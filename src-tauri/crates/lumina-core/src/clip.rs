use crate::*;
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use std::borrow::Cow;

// ----------------- SEMANTIC SEARCH (CLIP) -----------------
// Image encoder: OpenAI CLIP ViT-B/32 (ONNX export by Xenova). Text encoder: sentence-transformers'
// multilingual CLIP (DistilBERT distilled onto the same 512-D space: Dutch, English, French and 47 more),
// mean pooling + a 768->512 projection. Text and image vectors are compared by cosine similarity.
// Licenses: MIT (CLIP) and Apache-2.0 (multilingual text encoder).

pub const CLIP_MODEL_ID: &str = "clip-vit-b32+mclip-v1";

const VISION_FILE: &str = "clip_vision.onnx";
const TEXT_FILE: &str = "clip_text_quint8.onnx";
const DENSE_FILE: &str = "clip_text_dense.safetensors";
const TOKENIZER_FILE: &str = "clip_text_tokenizer.json";

// (file, url pinned to a commit, sha256, approx bytes)
const CLIP_FILES: [(&str, &str, &str, u64); 4] = [
    (
        VISION_FILE,
        "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/onnx/vision_model.onnx",
        "fd6e1402a588279d1723c7534d4bcba5bc0b14b47dfab0e46f8c47b8270d7d40",
        351_685_709,
    ),
    (
        TEXT_FILE,
        "https://huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1/resolve/58edf8cada9e398793dca955574a48cbb7f18be2/onnx/model_quint8_avx2.onnx",
        "fbc8fbeaa5237d96bd1bf430057c70d34de8334a463e933a5faa305f6caeed9c",
        135_377_779,
    ),
    (
        DENSE_FILE,
        "https://huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1/resolve/58edf8cada9e398793dca955574a48cbb7f18be2/2_Dense/model.safetensors",
        "d12568dc7300970a4d3dbb49068ad16cd89b99840b74b026f8e48071e9414f74",
        1_572_984,
    ),
    (
        TOKENIZER_FILE,
        "https://huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1/resolve/58edf8cada9e398793dca955574a48cbb7f18be2/tokenizer.json",
        "5b4e1a8171c81dfd666ae40265b9530c6e0b3d53923fe8ac493dcc84229adf81",
        1_961_847,
    ),
];

const IMAGE_SIZE: usize = 224;
const CLIP_MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const CLIP_STD: [f32; 3] = [0.268_629_54, 0.261_302_58, 0.275_777_1];
const EMBED_DIM: usize = 512;
const TEXT_HIDDEN: usize = 768;
const MAX_TOKENS: usize = 128;

pub struct ClipModels {
    vision: Mutex<Session>,
    text: Mutex<Session>,
    tokenizer: tokenizers::Tokenizer,
    // 512 x 768 projection (row-major), no bias
    dense: Vec<f32>,
    pub device: String,
}

fn l2_normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    for x in v {
        *x /= norm;
    }
}

// The projection layer is a single F32 tensor in a safetensors file: 8-byte header length, JSON header, data
fn read_dense(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let header_len = u64::from_le_bytes(bytes.get(..8).ok_or("bad safetensors")?.try_into().unwrap()) as usize;
    let header: JsonValue = serde_json::from_slice(bytes.get(8..8 + header_len).ok_or("bad safetensors")?)
        .map_err(|e| e.to_string())?;
    let info = &header["linear.weight"];
    let offsets = info["data_offsets"].as_array().ok_or("linear.weight missing")?;
    let (start, end) = (offsets[0].as_u64().unwrap_or(0) as usize, offsets[1].as_u64().unwrap_or(0) as usize);
    let data = bytes.get(8 + header_len + start..8 + header_len + end).ok_or("bad safetensors offsets")?;
    let weights = blob_to_embedding(data);
    if weights.len() != EMBED_DIM * TEXT_HIDDEN {
        return Err(format!("unexpected projection size {}", weights.len()));
    }
    Ok(weights)
}

// CLIP preprocessing: resize the short side to 224 (bicubic), centre crop 224x224, normalize, NCHW
pub fn clip_image_input(img: &DynamicImage) -> Vec<f32> {
    let (w, h) = img.dimensions();
    let scale = IMAGE_SIZE as f32 / w.min(h).max(1) as f32;
    let (nw, nh) = (
        ((w as f32 * scale).round() as u32).max(IMAGE_SIZE as u32),
        ((h as f32 * scale).round() as u32).max(IMAGE_SIZE as u32),
    );
    let resized = img.resize_exact(nw, nh, FilterType::CatmullRom).to_rgb8();
    let (x0, y0) = ((nw as usize - IMAGE_SIZE) / 2, (nh as usize - IMAGE_SIZE) / 2);
    let plane = IMAGE_SIZE * IMAGE_SIZE;
    let mut input = vec![0f32; 3 * plane];
    for y in 0..IMAGE_SIZE {
        for x in 0..IMAGE_SIZE {
            let px = resized.get_pixel((x0 + x) as u32, (y0 + y) as u32);
            for c in 0..3 {
                input[c * plane + y * IMAGE_SIZE + x] = (px[c] as f32 / 255.0 - CLIP_MEAN[c]) / CLIP_STD[c];
            }
        }
    }
    input
}

fn embed_image_with(session: &mut Session, input: &[f32]) -> Result<Vec<f32>, String> {
    let tensor = Tensor::from_array(([1usize, 3, IMAGE_SIZE, IMAGE_SIZE], input.to_vec())).map_err(|e| e.to_string())?;
    let input_name = session.inputs().first().map(|i| i.name().to_string()).unwrap_or_else(|| "pixel_values".into());
    let outputs = session
        .run(vec![(Cow::from(input_name), SessionInputValue::from(tensor))])
        .map_err(|e| e.to_string())?;
    // Xenova's export has `image_embeds` (projected, 512-D) and the raw `last_hidden_state`
    let value = outputs.get("image_embeds").unwrap_or(&outputs[0]);
    let (_, data) = value.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    let mut v: Vec<f32> = data.iter().take(EMBED_DIM).copied().collect();
    if v.len() != EMBED_DIM {
        return Err(format!("unexpected CLIP image output size {}", v.len()));
    }
    l2_normalize(&mut v);
    Ok(v)
}

impl ClipModels {
    pub fn load(dir: &Path) -> Result<ClipModels, String> {
        let vision_path = dir.join(VISION_FILE);
        // A session that is made is not yet one that runs (CUDA without cuDNN fails only then): the GPU counts
        // once a blank image goes through it, which also compiles DirectML's shaders now
        let blank = vec![0f32; 3 * IMAGE_SIZE * IMAGE_SIZE];
        let gpu = face_ort::build_session(&vision_path, true)
            .and_then(|mut s| embed_image_with(&mut s, &blank).map(|_| s));
        let (vision, device) = match gpu {
            Ok(s) => (s, face_ort::GPU_DEVICE.to_string()),
            Err(gpu_err) => {
                let mut s = face_ort::build_session(&vision_path, false)?;
                embed_image_with(&mut s, &blank)?;
                (s, format!("CPU (GPU unavailable: {gpu_err})"))
            }
        };
        // The quantized text encoder runs on the CPU: one short query at a time, a few ms
        let text = face_ort::build_session(&dir.join(TEXT_FILE), false)?;
        let mut tokenizer =
            tokenizers::Tokenizer::from_file(dir.join(TOKENIZER_FILE)).map_err(|e| format!("tokenizer: {e}"))?;
        let _ = tokenizer.with_truncation(Some(tokenizers::TruncationParams {
            max_length: MAX_TOKENS,
            ..Default::default()
        }));
        tokenizer.with_padding(None);
        Ok(ClipModels {
            vision: Mutex::new(vision),
            text: Mutex::new(text),
            tokenizer,
            dense: read_dense(&dir.join(DENSE_FILE))?,
            device,
        })
    }

    // 512-D normalized vector for a preprocessed image (see clip_image_input)
    pub fn embed_image_input(&self, input: &[f32]) -> Result<Vec<f32>, String> {
        let mut session = self.vision.lock().map_err(|_| "CLIP vision lock poisoned")?;
        embed_image_with(&mut session, input)
    }

    pub fn embed_image(&self, img: &DynamicImage) -> Result<Vec<f32>, String> {
        self.embed_image_input(&clip_image_input(img))
    }

    // 512-D normalized vector for a text query (any of ~50 languages)
    pub fn embed_text(&self, text: &str) -> Result<Vec<f32>, String> {
        let encoding = self.tokenizer.encode(text, true).map_err(|e| format!("tokenizer: {e}"))?;
        let ids: Vec<i64> = encoding.get_ids().iter().map(|&i| i as i64).collect();
        let n = ids.len().max(1);
        let mask = vec![1i64; n];

        let mut session = self.text.lock().map_err(|_| "CLIP text lock poisoned")?;
        let names: Vec<String> = session.inputs().iter().map(|i| i.name().to_string()).collect();
        let mut inputs: Vec<(Cow<str>, SessionInputValue)> = Vec::new();
        for name in names {
            let data = match name.as_str() {
                "input_ids" => ids.clone(),
                "attention_mask" => mask.clone(),
                _ => vec![0i64; n], // token_type_ids, if the export has it
            };
            let tensor = Tensor::from_array(([1usize, n], data)).map_err(|e| e.to_string())?;
            inputs.push((Cow::from(name), SessionInputValue::from(tensor)));
        }
        let outputs = session.run(inputs).map_err(|e| e.to_string())?;
        let value = outputs.get("last_hidden_state").or_else(|| outputs.get("token_embeddings")).unwrap_or(&outputs[0]);
        let (_, hidden) = value.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        if hidden.len() < n * TEXT_HIDDEN {
            return Err(format!("unexpected CLIP text output size {}", hidden.len()));
        }
        // Mean over the tokens (all real: no padding), then the 768 -> 512 projection
        let mut pooled = vec![0f32; TEXT_HIDDEN];
        for t in 0..n {
            for (k, p) in pooled.iter_mut().enumerate() {
                *p += hidden[t * TEXT_HIDDEN + k];
            }
        }
        for p in pooled.iter_mut() {
            *p /= n as f32;
        }
        let mut out: Vec<f32> = (0..EMBED_DIM)
            .map(|r| face_match::dot(&self.dense[r * TEXT_HIDDEN..(r + 1) * TEXT_HIDDEN], &pooled))
            .collect();
        l2_normalize(&mut out);
        Ok(out)
    }
}

// ----------------- MODEL DOWNLOAD -----------------

#[derive(Serialize, Clone, Default)]
pub struct SemanticProgress {
    // "download" | "index"
    pub stage: String,
    pub completed: usize,
    pub total: usize,
    pub message: String,
    pub done: bool,
    pub cancelled: bool,
}

fn emit_semantic(app: &dyn Host, p: SemanticProgress) {
    let _ = emit_to(&app, "semantic-progress", p);
}

pub fn clip_models_dir(app: &dyn Host) -> PathBuf {
    get_models_dir(app)
}

pub fn clip_models_present(dir: &Path) -> bool {
    CLIP_FILES.iter().all(|(name, _, _, size)| {
        dir.join(name).metadata().map(|m| m.len() == *size).unwrap_or(false)
    })
}

static CLIP_VERIFIED: AtomicBool = AtomicBool::new(false);

// Downloads the missing model files in `dir` (about 490 MB in total), each to .part, checked against its
// SHA-256, then renamed into place. `cancelled` is polled between chunks. Used by the app and by
// `--prepare-models` (Lumina Setup).
pub async fn ensure_clip_models_in(
    dir: &Path,
    progress: face_ort::DownloadProgress<'_>,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<(), String> {
    let check_dir = dir.to_path_buf();
    let missing: Vec<usize> = tokio::task::spawn_blocking(move || {
        (0..CLIP_FILES.len())
            .filter(|&i| !face_ort::sha256_hex(&check_dir.join(CLIP_FILES[i].0)).is_some_and(|h| h == CLIP_FILES[i].2))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;

    if !missing.is_empty() {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .read_timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        let total_bytes: u64 = missing.iter().map(|&i| CLIP_FILES[i].3).sum();
        let mut done_bytes = 0u64;
        for &i in &missing {
            let (name, url, sha, _) = CLIP_FILES[i];
            let part = dir.join(format!("{name}.part"));
            let mut res = client.get(url).send().await.map_err(|e| format!("Could not download {name}: {e}"))?;
            if !res.status().is_success() {
                return Err(format!("Could not download {name}: HTTP {}", res.status()));
            }
            let mut file = File::create(&part).map_err(|e| e.to_string())?;
            while let Some(chunk) = res.chunk().await.map_err(|e| format!("Download of {name} interrupted: {e}"))? {
                if cancelled() {
                    drop(file);
                    let _ = fs::remove_file(&part);
                    return Err(SEMANTIC_CANCELLED.into());
                }
                std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
                done_bytes += chunk.len() as u64;
                progress(done_bytes, total_bytes);
            }
            drop(file);
            let (part_check, sha_owned) = (part.clone(), sha.to_string());
            let ok = tokio::task::spawn_blocking(move || face_ort::sha256_hex(&part_check).is_some_and(|h| h == sha_owned))
                .await
                .unwrap_or(false);
            if !ok {
                let _ = fs::remove_file(&part);
                return Err(format!("{name} failed its checksum. Please try again."));
            }
            fs::rename(&part, dir.join(name)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

async fn ensure_clip_models(app: &dyn Host) -> Result<PathBuf, String> {
    let dir = clip_models_dir(app);
    if CLIP_VERIFIED.load(Ordering::Acquire) {
        return Ok(dir);
    }
    let cancel_generation = SEMANTIC_CANCEL.load(Ordering::Acquire);
    let last_mb = AtomicU64::new(u64::MAX);
    let emit_progress = |done: u64, total: u64| {
        let mb = done / 1_048_576;
        if last_mb.swap(mb, Ordering::Relaxed) != mb {
            emit_semantic(
                app,
                SemanticProgress {
                    stage: "download".into(),
                    completed: mb as usize,
                    total: (total / 1_048_576) as usize,
                    message: "Downloading the smart search models (once)".into(),
                    ..Default::default()
                },
            );
        }
    };
    let is_cancelled = || SEMANTIC_CANCEL.load(Ordering::Acquire) != cancel_generation;
    if let Err(e) = ensure_clip_models_in(&dir, &emit_progress, &is_cancelled).await {
        if e == SEMANTIC_CANCELLED {
            emit_semantic(app, SemanticProgress { stage: "download".into(), done: true, cancelled: true, ..Default::default() });
        }
        return Err(e);
    }
    CLIP_VERIFIED.store(true, Ordering::Release);
    Ok(dir)
}

static CLIP_MODELS: LazyLock<Mutex<Option<Arc<ClipModels>>>> = LazyLock::new(|| Mutex::new(None));

async fn clip_models(app: &dyn Host) -> Result<Arc<ClipModels>, String> {
    if let Some(m) = CLIP_MODELS.lock().ok().and_then(|g| g.clone()) {
        return Ok(m);
    }
    let dir = ensure_clip_models(app).await?;
    let loaded = Arc::new(
        tokio::task::spawn_blocking(move || ClipModels::load(&dir))
            .await
            .map_err(|e| e.to_string())??,
    );
    if let Ok(mut slot) = CLIP_MODELS.lock() {
        return Ok(slot.get_or_insert(loaded).clone());
    }
    Ok(loaded)
}

pub(crate) fn release_clip_models() {
    if let Ok(mut slot) = CLIP_MODELS.lock() {
        *slot = None;
    }
}

// The smart search models when they are installed, without downloading them (the face scan uses them to
// spot closed eyes, but never triggers the 470 MB download itself)
pub fn clip_models_if_present(dir: &Path) -> Option<Arc<ClipModels>> {
    if let Some(m) = CLIP_MODELS.lock().ok().and_then(|g| g.clone()) {
        return Some(m);
    }
    if !clip_models_present(dir) {
        return None;
    }
    let loaded = Arc::new(ClipModels::load(dir).ok()?);
    CLIP_MODELS.lock().ok().map(|mut slot| slot.get_or_insert(loaded.clone()).clone()).or(Some(loaded))
}

// ----------------- INDEX -----------------

// Image vectors of the current model, kept in memory for searching
static CLIP_CACHE: LazyLock<Mutex<HashMap<String, Vec<f32>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static CLIP_CACHE_LOADED: AtomicBool = AtomicBool::new(false);
// Videos: the vector of each frame, in frame order
static FRAME_CACHE: LazyLock<Mutex<HashMap<String, Vec<Vec<f32>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn ensure_clip_cache(conn: &Connection) {
    if CLIP_CACHE_LOADED.load(Ordering::Acquire) {
        return;
    }
    let mut map = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash, embedding FROM photo_clip WHERE model = ?1") {
        if let Ok(rows) = stmt.query_map(params![CLIP_MODEL_ID], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))) {
            for (hash, blob) in rows.flatten() {
                let v = blob_to_embedding(&blob);
                if v.len() == EMBED_DIM {
                    map.insert(hash, v);
                }
            }
        }
    }
    if let Ok(mut cache) = CLIP_CACHE.lock() {
        for (k, v) in map {
            cache.entry(k).or_insert(v);
        }
    }
    let mut frames: HashMap<String, Vec<Vec<f32>>> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash, embedding FROM photo_clip_frames WHERE model = ?1 ORDER BY hash, frame") {
        if let Ok(rows) = stmt.query_map(params![CLIP_MODEL_ID], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))) {
            for (hash, blob) in rows.flatten() {
                let v = blob_to_embedding(&blob);
                if v.len() == EMBED_DIM {
                    frames.entry(hash).or_default().push(v);
                }
            }
        }
    }
    if let Ok(mut cache) = FRAME_CACHE.lock() {
        for (k, v) in frames {
            cache.entry(k).or_insert(v);
        }
    }
    CLIP_CACHE_LOADED.store(true, Ordering::Release);
}

// Removed photos leave smart search at once (their rows go with the photo, in the caller's transaction)
// Every video's frame vectors (the frames are being made again)
pub fn forget_frame_vectors() {
    if let Ok(mut cache) = FRAME_CACHE.lock() {
        cache.clear();
    }
}

pub fn forget_vectors(hashes: &[String]) {
    if let Ok(mut cache) = CLIP_CACHE.lock() {
        for h in hashes {
            cache.remove(h);
        }
    }
    if let Ok(mut cache) = FRAME_CACHE.lock() {
        for h in hashes {
            cache.remove(h);
        }
    }
}

// Error text the UI recognises as "the user stopped it"
pub const SEMANTIC_CANCELLED: &str = "Smart search indexing cancelled";
static SEMANTIC_CANCEL: AtomicU64 = AtomicU64::new(0);
static SEMANTIC_RUNNING: AtomicBool = AtomicBool::new(false);

// An index pass is running (for a server's status page)
pub fn semantic_index_running() -> bool {
    SEMANTIC_RUNNING.load(Ordering::Acquire)
}

pub fn cancel_semantic_index() {
    SEMANTIC_CANCEL.fetch_add(1, Ordering::AcqRel);
}

#[derive(Serialize)]
pub struct SemanticStatus {
    pub models_ready: bool,
    pub indexed: usize,
    pub total: usize,
    pub running: bool,
}

// Whether smart search can be used without a download, and how much of the folder is indexed
pub async fn semantic_status(app: SharedHost, root_folder: Option<String>) -> Result<SemanticStatus, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let prefix = make_folder_prefix(root_folder.as_deref());
        let total: usize = conn
            .query_row("SELECT COUNT(*) FROM photos WHERE current_path LIKE ?1 ESCAPE '!'", params![prefix], |r| r.get(0))
            .unwrap_or(0);
        let indexed: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM photos p JOIN photo_clip c ON c.hash = p.hash AND c.model = ?2
                 WHERE p.current_path LIKE ?1 ESCAPE '!'",
                params![prefix, CLIP_MODEL_ID],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(SemanticStatus {
            models_ready: clip_models_present(&clip_models_dir(&app)),
            indexed,
            total,
            running: SEMANTIC_RUNNING.load(Ordering::Acquire),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Indexes every photo of the folder that has no vector yet (downloading the models first if needed).
// Runs in the background; progress arrives as `semantic-progress` events. Returns how many will be indexed.
pub async fn start_semantic_index(app: SharedHost, root_folder: String) -> Result<usize, String> {
    if SEMANTIC_RUNNING.swap(true, Ordering::AcqRel) {
        return Ok(0);
    }
    let result = run_semantic_index(Arc::new(app), root_folder).await;
    if result.is_err() {
        SEMANTIC_RUNNING.store(false, Ordering::Release);
    }
    result
}

async fn run_semantic_index(app: SharedHost, root_folder: String) -> Result<usize, String> {
    let models = clip_models(&app).await?;
    let cancel_generation = SEMANTIC_CANCEL.load(Ordering::Acquire);

    let conn = open_global_db(&app)?;
    ensure_clip_cache(&conn);
    let prefix = make_folder_prefix(Some(&root_folder));
    let app_dir = get_app_storage_dir(&app);
    let thumbs_dir = app_dir.join("thumbnails");
    let frames_dir = video_frames::frames_dir(&app_dir);
    // (hash, images to embed, is a video): a photo's thumbnail, or a video's frames (videos indexed from their
    // thumbnail alone, before frames were searched, are done again)
    let todo: Vec<(String, Vec<PathBuf>, bool)> = {
        let cache = CLIP_CACHE.lock().map_err(|_| "cache lock poisoned")?;
        let frame_cache = FRAME_CACHE.lock().map_err(|_| "cache lock poisoned")?;
        let mut stmt = conn
            .prepare("SELECT hash, COALESCE(media_type, 'photo') = 'video' FROM photos WHERE current_path LIKE ?1 ESCAPE '!'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![prefix], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.flatten()
            .filter_map(|(h, is_video)| {
                if is_video {
                    let frames = video_frames::frame_paths(&frames_dir, &h);
                    (!frame_cache.contains_key(&h) && !frames.is_empty()).then_some((h, frames, true))
                } else {
                    let thumb = thumbs_dir.join(format!("{h}.jpg"));
                    (!cache.contains_key(&h) && thumb.exists()).then_some((h, vec![thumb], false))
                }
            })
            .collect()
    };
    let total = todo.len();
    if total == 0 {
        SEMANTIC_RUNNING.store(false, Ordering::Release);
        emit_semantic(&app, SemanticProgress { stage: "index".into(), done: true, ..Default::default() });
        return Ok(0);
    }

    std::thread::spawn(move || {
        let started = Instant::now();
        let mut conn = open_global_db(&app).ok();
        let mut completed = 0usize;
        let mut cancelled = false;
        for chunk in todo.chunks(32) {
            if SEMANTIC_CANCEL.load(Ordering::Acquire) != cancel_generation {
                cancelled = true;
                break;
            }
            // Decoding + preprocessing in parallel at low priority, then the GPU one image at a time
            let inputs: Vec<(String, bool, Vec<Vec<f32>>)> = BG_POOL.install(|| {
                chunk
                    .par_iter()
                    .map(|(h, images, is_video)| {
                        let inputs = images.iter().filter_map(|p| image::open(p).ok().map(|img| clip_image_input(&img))).collect();
                        (h.clone(), *is_video, inputs)
                    })
                    .collect()
            });
            let mut vectors: Vec<(String, Vec<f32>)> = Vec::with_capacity(inputs.len());
            let mut video_frames: Vec<(String, Vec<Vec<f32>>)> = Vec::new();
            for (hash, is_video, images) in inputs {
                let embedded: Vec<Vec<f32>> = images.iter().filter_map(|i| models.embed_image_input(i).ok()).collect();
                if embedded.is_empty() {
                    continue;
                }
                if !is_video {
                    vectors.push((hash, embedded.into_iter().next().unwrap_or_default()));
                    continue;
                }
                // A video's own vector (similar shots, highlights, "find similar") is the mean of its frames
                let mut mean = vec![0f32; EMBED_DIM];
                for v in &embedded {
                    for (m, x) in mean.iter_mut().zip(v) {
                        *m += x;
                    }
                }
                l2_normalize(&mut mean);
                vectors.push((hash.clone(), mean));
                video_frames.push((hash, embedded));
            }
            if let Some(conn) = conn.as_mut() {
                if let Ok(tx) = conn.transaction() {
                    for (hash, v) in &vectors {
                        let _ = tx.execute(
                            "INSERT OR REPLACE INTO photo_clip (hash, embedding, model) VALUES (?1, ?2, ?3)",
                            params![hash, embedding_to_blob(v), CLIP_MODEL_ID],
                        );
                    }
                    for (hash, frames) in &video_frames {
                        let _ = tx.execute("DELETE FROM photo_clip_frames WHERE hash = ?1", params![hash]);
                        for (n, v) in frames.iter().enumerate() {
                            let _ = tx.execute(
                                "INSERT INTO photo_clip_frames (hash, frame, embedding, model) VALUES (?1, ?2, ?3, ?4)",
                                params![hash, n as i64, embedding_to_blob(v), CLIP_MODEL_ID],
                            );
                        }
                    }
                    let _ = tx.commit();
                }
            }
            if let Ok(mut cache) = CLIP_CACHE.lock() {
                cache.extend(vectors);
            }
            if let Ok(mut cache) = FRAME_CACHE.lock() {
                cache.extend(video_frames);
            }
            completed += chunk.len();
            emit_semantic(
                &app,
                SemanticProgress {
                    stage: "index".into(),
                    completed,
                    total,
                    message: "Indexing photos for smart search".into(),
                    ..Default::default()
                },
            );
        }
        emit_perf(&app, "Smart search index", started, completed, format!("CLIP ViT-B/32 on {}", models.device));
        SEMANTIC_RUNNING.store(false, Ordering::Release);
        emit_semantic(&app, SemanticProgress { stage: "index".into(), completed, total, done: true, cancelled, ..Default::default() });
    });
    Ok(total)
}

// ----------------- SEARCH -----------------

// The smart search vectors of these photos (those that are indexed)
pub fn clip_vectors(conn: &Connection, hashes: &[String]) -> HashMap<String, Vec<f32>> {
    ensure_clip_cache(conn);
    let Ok(cache) = CLIP_CACHE.lock() else { return HashMap::new() };
    hashes.iter().filter_map(|h| cache.get(h).map(|v| (h.clone(), v.clone()))).collect()
}

#[derive(Serialize)]
pub struct SemanticHit {
    pub hash: String,
    pub score: f32,
}

// CLIP scores shift per query (a broad query lifts every photo), so the cut-off adapts to the query: keep
// photos in the top part of the spread between the median photo and the best match. Tuned on 1,800 library
// photos (2026-10-26): 0.6 keeps the clear matches without hundreds of loose ones for broad queries.
const SPREAD_FRACTION: f32 = 0.6;
const ABSOLUTE_FLOOR: f32 = 0.12;

fn cutoff_for(sorted_scores: &[f32]) -> f32 {
    let (Some(&top), Some(&median)) = (sorted_scores.first(), sorted_scores.get(sorted_scores.len() / 2)) else {
        return ABSOLUTE_FLOOR;
    };
    (median + SPREAD_FRACTION * (top - median)).max(ABSOLUTE_FLOOR)
}
const MAX_HITS: usize = 1000;
// Text queries return this many scores uncut: the app applies the cut-off among the photos its other filters
// keep ("emma at the park" ranks Emma's photos against each other, not against the whole library)
const MAX_SCORED: usize = 20_000;

fn rank(query: &[f32], exclude: Option<&str>, cut: bool) -> Vec<SemanticHit> {
    let Ok(cache) = CLIP_CACHE.lock() else { return Vec::new() };
    let Ok(frames) = FRAME_CACHE.lock() else { return Vec::new() };
    // A video scores by its best frame: what appears in one part of it is found too
    let mut hits: Vec<SemanticHit> = cache
        .iter()
        .filter(|(h, _)| Some(h.as_str()) != exclude)
        .map(|(h, v)| {
            let own = face_match::dot(query, v);
            let score = frames.get(h).into_iter().flatten().map(|f| face_match::dot(query, f)).fold(own, f32::max);
            SemanticHit { hash: h.clone(), score }
        })
        .collect();
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    if !cut {
        hits.truncate(MAX_SCORED);
        return hits;
    }
    let scores: Vec<f32> = hits.iter().map(|h| h.score).collect();
    let cutoff = cutoff_for(&scores);
    hits.retain(|h| h.score >= cutoff);
    hits.truncate(MAX_HITS);
    hits
}

pub async fn semantic_search(app: SharedHost, query: String) -> Result<Vec<SemanticHit>, String> {
    let models = clip_models(&app).await?;
    tokio::task::spawn_blocking(move || {
        if let Ok(conn) = open_global_db(&app) {
            ensure_clip_cache(&conn);
        }
        let q = models.embed_text(query.trim())?;
        Ok(rank(&q, None, false))
    })
    .await
    .map_err(|e| e.to_string())?
}

// "Find similar": the photo's own image vector is the query
pub async fn find_similar_photos(app: SharedHost, hash: String) -> Result<Vec<SemanticHit>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        ensure_clip_cache(&conn);
        let query = CLIP_CACHE.lock().ok().and_then(|c| c.get(&hash).cloned());
        let Some(query) = query else {
            return Err("This photo isn't indexed for smart search yet.".to_string());
        };
        let mut hits = rank(&query, None, true);
        // The photo itself first (score 1.0), so the result reads "this photo and the ones like it"
        hits.sort_by(|a, b| (b.hash == hash).cmp(&(a.hash == hash)).then(b.score.total_cmp(&a.score)));
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Manual check of text/image alignment and the cut-off, on real thumbnails:
// PowerShell: $env:LUMINA_CLIP_MODELS="<folder with the 4 model files>"; $env:LUMINA_CLIP_IMAGES="<folder of jpgs>";
//             cargo test --release --lib clip_eval -- --ignored --nocapture
#[cfg(test)]
mod eval {
    use super::*;

    #[test]
    #[ignore]
    fn clip_eval() {
        let (Ok(models_dir), Ok(images_dir)) = (std::env::var("LUMINA_CLIP_MODELS"), std::env::var("LUMINA_CLIP_IMAGES")) else {
            eprintln!("Set LUMINA_CLIP_MODELS and LUMINA_CLIP_IMAGES");
            return;
        };
        let started = Instant::now();
        let models = ClipModels::load(Path::new(&models_dir)).expect("load");
        {
            let v = models.vision.lock().unwrap();
            let t = models.text.lock().unwrap();
            eprintln!("device {} · load {} ms", models.device, started.elapsed().as_millis());
            eprintln!("vision in {:?} out {:?}", v.inputs().iter().map(|i| i.name()).collect::<Vec<_>>(), v.outputs().iter().map(|o| o.name()).collect::<Vec<_>>());
            eprintln!("text in {:?} out {:?}", t.inputs().iter().map(|i| i.name()).collect::<Vec<_>>(), t.outputs().iter().map(|o| o.name()).collect::<Vec<_>>());
        }
        let limit: usize = std::env::var("LUMINA_CLIP_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(2000);
        let files: Vec<PathBuf> = fs::read_dir(&images_dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jpg")) && !p.to_string_lossy().contains(".tmp"))
            .take(limit)
            .collect();
        let t0 = Instant::now();
        let vectors: Vec<(String, Vec<f32>)> = files
            .iter()
            .filter_map(|p| {
                let img = image::open(p).ok()?;
                Some((p.file_name()?.to_string_lossy().to_string(), models.embed_image(&img).ok()?))
            })
            .collect();
        let ms = t0.elapsed().as_millis().max(1);
        eprintln!("{} images in {ms} ms ({:.1}/s incl. decode)", vectors.len(), vectors.len() as f64 * 1000.0 / ms as f64);

        for q in [
            "a dog", "hond op het strand", "sunset over the sea", "birthday cake", "screenshot of a chat",
            "snow in the mountains", "kinderen die spelen", "a car", "food on a plate", "people at a wedding",
            "een kat", "city at night", "receipt", "flowers", "christmas tree",
        ] {
            let t = Instant::now();
            let qv = models.embed_text(q).unwrap();
            let text_ms = t.elapsed().as_millis();
            let mut scored: Vec<(f32, &str)> = vectors.iter().map(|(n, v)| (face_match::dot(&qv, v), n.as_str())).collect();
            scored.sort_by(|a, b| b.0.total_cmp(&a.0));
            let top = scored[0].0;
            let cutoff = cutoff_for(&scored.iter().map(|s| s.0).collect::<Vec<_>>());
            let kept = scored.iter().filter(|s| s.0 >= cutoff).count();
            let median = scored[scored.len() / 2].0;
            eprintln!(
                "
\"{q}\" ({text_ms} ms) top {:.3} · median {median:.3} · kept {kept}",
                top
            );
            for (s, n) in scored.iter().take(5) {
                eprintln!("   {s:.3} {n}");
            }
            if kept > 5 {
                let (s, n) = scored[kept - 1];
                eprintln!("   last kept #{kept}: {s:.3} {n}");
            }
        }
    }
}
