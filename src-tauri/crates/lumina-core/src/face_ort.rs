use crate::*;
use ort::session::Session;
use ort::value::Tensor;
use std::sync::OnceLock;

// ----------------- FACE ENGINE v2: SCRFD + ALIGNED ARCFACE ON ONNX RUNTIME -----------------
// Detector: SCRFD det_10g at 640x640 (letterboxed, never squashed) with 5 facial landmarks.
// Embedder: ArcFace w600k_r50 on 112x112 crops aligned to the standard ArcFace template.
// Runs on the GPU through DirectML when available (≈3 ms per photo + ≈3 ms per face on an RTX 5070 Ti),
// otherwise on the CPU with the same models, so embeddings never depend on the device.
// Pre/post-processing follows InsightFace's reference implementation (scrfd.py, arcface_onnx.py, face_align.py).

pub const DETECTOR_FILE: &str = "det_10g.onnx";
pub const EMBEDDER_FILE: &str = "w600k_r50.onnx";
// SHA-256 of the files in InsightFace's official buffalo_l release (v0.7)
pub const DETECTOR_SHA256: &str = "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91";
pub const EMBEDDER_SHA256: &str = "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43";
// Closed eyes are judged by the smart search model (CLIP) on the face: how much closer the face is to
// "open eyes" than to "closed eyes". On a labelled set (eye_calibration test) this separated open from shut
// eyes with an AUC of 0.96, where landmark models and a dedicated eye classifier reached 0.5-0.75.
pub const EYES_OPEN_PROMPT: &str = "open eyes";
pub const EYES_CLOSED_PROMPT: &str = "closed eyes";

const DET_SIZE: usize = 640;
const DET_SCORE_THRESHOLD: f32 = 0.5;
const DET_NMS_IOU: f64 = 0.4;
const STRIDES: [usize; 3] = [8, 16, 32];
const ANCHORS_PER_CELL: usize = 2;

// Where the five landmarks (eyes, nose tip, mouth corners) sit in a 112x112 ArcFace input
const ARCFACE_TEMPLATE: [(f32, f32); 5] = [
    (38.2946, 51.6963),
    (73.5318, 51.5014),
    (56.0252, 71.7366),
    (41.5493, 92.3655),
    (70.7299, 92.2041),
];

pub struct FaceModels {
    detector: Mutex<Session>,
    embedder: Mutex<Session>,
    // Optional (needs the smart search models): faces are found and named without it, only the closed-eye
    // check is skipped. Built on first use, so installing smart search later works without a restart.
    eyes: OnceLock<EyeScorer>,
    models_dir: PathBuf,
    pub device: String,
}

#[derive(Clone, Debug)]
pub struct Detection {
    // Normalized (x, y, w, h) in the oriented source image
    pub bbox: (f64, f64, f64, f64),
    pub score: f32,
    // Pixel coordinates in the source image: left eye, right eye, nose, left mouth, right mouth
    pub landmarks: [(f32, f32); 5],
}

pub struct FaceV2 {
    pub detection: Detection,
    pub embedding: Vec<f32>,
    pub quality: FaceQuality,
}

// How usable a face is for culling: an eyes-open score (CLIP margin; below about -0.013 the eyes look shut)
// and focus on the face itself
#[derive(Clone, Copy, Debug, Default)]
pub struct FaceQuality {
    pub eyes_open: Option<f32>,
    pub sharpness: Option<f32>,
}

static ORT_ENV: LazyLock<Option<ort::environment::Environment>> =
    LazyLock::new(|| ort::init().with_name("lumina").build().ok());

// The GPU: DirectML on Windows (any vendor), CUDA elsewhere (the server's NVIDIA card)
#[cfg(windows)]
pub const GPU_DEVICE: &str = "GPU (DirectML)";
#[cfg(not(windows))]
pub const GPU_DEVICE: &str = "GPU (CUDA)";

#[cfg(windows)]
pub(crate) fn gpu_provider() -> ort::ep::ExecutionProviderDispatch {
    ort::ep::DirectML::default().build().error_on_failure()
}

#[cfg(not(windows))]
pub(crate) fn gpu_provider() -> ort::ep::ExecutionProviderDispatch {
    ort::ep::CUDA::default().build().error_on_failure()
}

pub fn build_session(path: &Path, gpu: bool) -> Result<Session, String> {
    let env = ORT_ENV.as_ref().ok_or("ONNX Runtime could not be initialised")?;
    let mut builder = Session::builder(env).map_err(|e| e.to_string())?;
    if gpu {
        // DirectML requires these two settings (see ONNX Runtime's DirectML EP documentation)
        builder = builder
            .with_memory_pattern(false)
            .map_err(|e| e.to_string())?
            .with_parallel_execution(false)
            .map_err(|e| e.to_string())?
            .with_execution_providers([gpu_provider()])
            .map_err(|e| e.to_string())?;
    } else {
        let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(4).max(1);
        builder = builder.with_intra_threads(threads).map_err(|e| e.to_string())?;
    }
    builder.commit_from_file(path).map_err(|e| e.to_string())
}

impl FaceModels {
    // GPU first, CPU as fallback; both models must load on the same device
    pub fn load(models_dir: &Path) -> Result<FaceModels, String> {
        let det = models_dir.join(DETECTOR_FILE);
        let emb = models_dir.join(EMBEDDER_FILE);
        let gpu = build_session(&det, true).and_then(|d| build_session(&emb, true).map(|e| (d, e)));
        let gpu_err = match gpu.and_then(|(d, e)| FaceModels::ready(models_dir, d, e, GPU_DEVICE.to_string())) {
            Ok(models) => return Ok(models),
            Err(e) => e,
        };
        let d = build_session(&det, false)?;
        let e = build_session(&emb, false)?;
        FaceModels::ready(models_dir, d, e, format!("CPU (GPU unavailable: {gpu_err})"))
    }

    // The first run is also the test that the device works: CUDA without cuDNN makes its sessions fine and
    // fails only when a model runs. It also compiles DirectML's shaders (~1-2 s) now, not on the first photo.
    fn ready(models_dir: &Path, detector: Session, embedder: Session, device: String) -> Result<FaceModels, String> {
        let models = FaceModels {
            detector: Mutex::new(detector),
            embedder: Mutex::new(embedder),
            eyes: OnceLock::new(),
            models_dir: models_dir.to_path_buf(),
            device,
        };
        let warm = image::RgbImage::new(320, 240);
        models.detect(&DynamicImage::ImageRgb8(warm))?;
        models.embed(&[image::RgbImage::new(112, 112)])?;
        Ok(models)
    }

    pub fn detect(&self, img: &DynamicImage) -> Result<Vec<Detection>, String> {
        let (src_w, src_h) = img.dimensions();
        if src_w < 16 || src_h < 16 {
            return Ok(Vec::new());
        }
        // Letterbox: scale to fit 640x640 keeping the aspect ratio, top-left aligned, black padding
        let scale = (DET_SIZE as f32 / src_w as f32).min(DET_SIZE as f32 / src_h as f32);
        let (new_w, new_h) = (((src_w as f32 * scale).round() as u32).max(1), ((src_h as f32 * scale).round() as u32).max(1));
        let resized = img.resize_exact(new_w, new_h, FilterType::Triangle).to_rgb8();
        let plane = DET_SIZE * DET_SIZE;
        // (x - 127.5) / 128, RGB, NCHW; padding = (0 - 127.5) / 128
        let mut input = vec![-127.5f32 / 128.0; 3 * plane];
        for (x, y, px) in resized.enumerate_pixels() {
            let i = y as usize * DET_SIZE + x as usize;
            for c in 0..3 {
                input[c * plane + i] = (px[c] as f32 - 127.5) / 128.0;
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, DET_SIZE, DET_SIZE], input)).map_err(|e| e.to_string())?;

        let mut session = self.detector.lock().map_err(|_| "face detector lock poisoned")?;
        let outputs = session.run(ort::inputs![tensor]).map_err(|e| e.to_string())?;

        // Outputs come as 3 score maps, 3 box maps, 3 landmark maps; identify them by shape
        let mut by_shape: HashMap<(usize, usize), Vec<f32>> = HashMap::new();
        for (_, value) in outputs.iter() {
            let (shape, data) = value.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            if shape.len() == 2 {
                by_shape.insert((shape[0] as usize, shape[1] as usize), data.to_vec());
            }
        }
        drop(outputs);
        drop(session);

        let mut found: Vec<Detection> = Vec::new();
        for stride in STRIDES {
            let cells = DET_SIZE / stride;
            let n = cells * cells * ANCHORS_PER_CELL;
            let (Some(scores), Some(boxes), Some(kps)) = (by_shape.get(&(n, 1)), by_shape.get(&(n, 4)), by_shape.get(&(n, 10))) else {
                return Err(format!("unexpected detector outputs for stride {stride}"));
            };
            for i in 0..n {
                let score = scores[i];
                if score < DET_SCORE_THRESHOLD {
                    continue;
                }
                let cell = i / ANCHORS_PER_CELL;
                let (ax, ay) = (((cell % cells) * stride) as f32, ((cell / cells) * stride) as f32);
                let s = stride as f32;
                let (x1, y1) = (ax - boxes[i * 4] * s, ay - boxes[i * 4 + 1] * s);
                let (x2, y2) = (ax + boxes[i * 4 + 2] * s, ay + boxes[i * 4 + 3] * s);
                let mut landmarks = [(0f32, 0f32); 5];
                for (k, lm) in landmarks.iter_mut().enumerate() {
                    *lm = ((ax + kps[i * 10 + k * 2] * s) / scale, (ay + kps[i * 10 + k * 2 + 1] * s) / scale);
                }
                // Back to source pixels, clipped, then normalized
                let (x1, y1) = ((x1 / scale).max(0.0), (y1 / scale).max(0.0));
                let (x2, y2) = ((x2 / scale).min(src_w as f32), (y2 / scale).min(src_h as f32));
                if x2 <= x1 || y2 <= y1 {
                    continue;
                }
                found.push(Detection {
                    bbox: (
                        x1 as f64 / src_w as f64,
                        y1 as f64 / src_h as f64,
                        (x2 - x1) as f64 / src_w as f64,
                        (y2 - y1) as f64 / src_h as f64,
                    ),
                    score,
                    landmarks,
                });
            }
        }

        // Non-maximum suppression
        found.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        let mut kept: Vec<Detection> = Vec::new();
        for d in found {
            if kept.iter().all(|k| bbox_iou(k.bbox, d.bbox) <= DET_NMS_IOU) {
                kept.push(d);
            }
        }
        Ok(kept)
    }

    // 512-D L2-normalized embeddings for aligned 112x112 faces. One face per run: the model's output is
    // declared as [1, 512], and batching several faces fails on DirectML (≈3-7 ms per face on the GPU anyway).
    pub fn embed(&self, faces: &[image::RgbImage]) -> Result<Vec<Vec<f32>>, String> {
        let plane = 112 * 112;
        let mut session = self.embedder.lock().map_err(|_| "face embedder lock poisoned")?;
        let mut embeddings = Vec::with_capacity(faces.len());
        for face in faces {
            let mut input = vec![0f32; 3 * plane];
            for (x, y, px) in face.enumerate_pixels() {
                let i = y as usize * 112 + x as usize;
                for c in 0..3 {
                    // (x - 127.5) / 127.5, RGB, NCHW
                    input[c * plane + i] = (px[c] as f32 - 127.5) / 127.5;
                }
            }
            let tensor = Tensor::from_array(([1usize, 3, 112, 112], input)).map_err(|e| e.to_string())?;
            let outputs = session.run(ort::inputs![tensor]).map_err(|e| e.to_string())?;
            let (_, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let norm = data.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
            embeddings.push(data.iter().map(|x| x / norm).collect());
        }
        Ok(embeddings)
    }

    // Detect, align and embed every face in the image, with its eye opening and focus
    pub fn analyze(&self, img: &DynamicImage) -> Result<Vec<FaceV2>, String> {
        let detections = self.detect(img)?;
        if detections.is_empty() {
            return Ok(Vec::new());
        }
        let rgb = img.to_rgb8();
        let aligned: Vec<image::RgbImage> = detections.iter().map(|d| align_face(&rgb, &d.landmarks)).collect();
        let embeddings = self.embed(&aligned)?;
        Ok(detections
            .into_iter()
            .zip(embeddings)
            .zip(aligned.iter())
            .map(|((detection, embedding), face)| {
                let quality = self.quality(img, &detection, face);
                FaceV2 { detection, embedding, quality }
            })
            .collect())
    }

    // Eyes-open score and focus for one detected face (`aligned` is its 112x112 ArcFace crop)
    pub fn quality(&self, img: &DynamicImage, detection: &Detection, aligned: &image::RgbImage) -> FaceQuality {
        let eyes_open = self.eye_scorer().and_then(|e| e.score(img, detection.bbox));
        FaceQuality { eyes_open, sharpness: Some(face_sharpness(aligned)) }
    }

    pub fn can_judge_eyes(&self) -> bool {
        self.eye_scorer().is_some()
    }

    fn eye_scorer(&self) -> Option<&EyeScorer> {
        if let Some(e) = self.eyes.get() {
            return Some(e);
        }
        let clip = clip::clip_models_if_present(&self.models_dir)?;
        let open = clip.embed_text(EYES_OPEN_PROMPT).ok()?;
        let closed = clip.embed_text(EYES_CLOSED_PROMPT).ok()?;
        let _ = self.eyes.set(EyeScorer { clip, open, closed });
        self.eyes.get()
    }

    // Eye and focus measurements for a face stored as a box: its landmarks come from the detector run inside
    // the box (like embed_region), or the template placed in the box
    pub fn quality_for_box(&self, img: &DynamicImage, rgb: &image::RgbImage, bbox: (f64, f64, f64, f64)) -> Result<FaceQuality, String> {
        let landmarks = self.landmarks_for_box(img, bbox)?;
        let aligned = align_face(rgb, &landmarks);
        Ok(self.quality(img, &Detection { bbox, score: 0.0, landmarks }, &aligned))
    }
}

pub struct EyeScorer {
    clip: Arc<clip::ClipModels>,
    open: Vec<f32>,
    closed: Vec<f32>,
}

impl EyeScorer {
    // The face (its box enlarged by 20%, square) through CLIP: similarity to "open eyes" minus "closed eyes"
    fn score(&self, img: &DynamicImage, bbox: (f64, f64, f64, f64)) -> Option<f32> {
        let (w, h) = (img.width() as f64, img.height() as f64);
        let side = (bbox.2 * w).max(bbox.3 * h) * 1.2;
        if side < 24.0 {
            return None;
        }
        let (cx, cy) = ((bbox.0 + bbox.2 / 2.0) * w, (bbox.1 + bbox.3 / 2.0) * h);
        let (x, y) = ((cx - side / 2.0).max(0.0), (cy - side / 2.0).max(0.0));
        let face = img.crop_imm(x as u32, y as u32, side.min(w - x) as u32, side.min(h - y) as u32);
        let e = self.clip.embed_image(&face).ok()?;
        let dot = |t: &[f32]| e.iter().zip(t).map(|(a, b)| a * b).sum::<f32>();
        Some(dot(&self.open) - dot(&self.closed))
    }
}

// Focus on the face: variance of the Laplacian over the middle of the aligned 112x112 crop (eyes, nose,
// mouth), so a sharp background can't hide a soft face. Scale-independent because every crop is 112 px.
pub fn face_sharpness(aligned: &image::RgbImage) -> f32 {
    let gray = |x: u32, y: u32| {
        let p = aligned.get_pixel(x, y);
        0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32
    };
    let (mut sum, mut sum_sq, mut n) = (0f64, 0f64, 0f64);
    for y in 30..95u32 {
        for x in 24..88u32 {
            let lap = gray(x - 1, y) + gray(x + 1, y) + gray(x, y - 1) + gray(x, y + 1) - 4.0 * gray(x, y);
            sum += lap as f64;
            sum_sq += (lap * lap) as f64;
            n += 1.0;
        }
    }
    let mean = sum / n;
    (sum_sq / n - mean * mean) as f32
}

// Least-squares similarity transform (rotation + uniform scale + translation) mapping `src` onto `dst`.
// In 2D this has a closed form (complex-number regression); same result as Umeyama without reflection.
// Returns (a, b, tx, ty) for x' = a*x - b*y + tx, y' = b*x + a*y + ty.
pub fn similarity_transform(src: &[(f32, f32); 5], dst: &[(f32, f32); 5]) -> (f32, f32, f32, f32) {
    let n = src.len() as f32;
    let (msx, msy) = (src.iter().map(|p| p.0).sum::<f32>() / n, src.iter().map(|p| p.1).sum::<f32>() / n);
    let (mdx, mdy) = (dst.iter().map(|p| p.0).sum::<f32>() / n, dst.iter().map(|p| p.1).sum::<f32>() / n);
    let (mut num_a, mut num_b, mut den) = (0f32, 0f32, 0f32);
    for (s, d) in src.iter().zip(dst) {
        let (sx, sy) = (s.0 - msx, s.1 - msy);
        let (dx, dy) = (d.0 - mdx, d.1 - mdy);
        num_a += dx * sx + dy * sy;
        num_b += dy * sx - dx * sy;
        den += sx * sx + sy * sy;
    }
    let den = den.max(1e-6);
    let (a, b) = (num_a / den, num_b / den);
    (a, b, mdx - (a * msx - b * msy), mdy - (b * msx + a * msy))
}

// Warps the face onto the 112x112 ArcFace template (bilinear sampling, black outside the photo)
pub fn align_face(img: &image::RgbImage, landmarks: &[(f32, f32); 5]) -> image::RgbImage {
    let (a, b, tx, ty) = similarity_transform(landmarks, &ARCFACE_TEMPLATE);
    // Inverse of [a -b; b a] is [a b; -b a] / (a^2 + b^2)
    let det = (a * a + b * b).max(1e-9);
    let (w, h) = (img.width() as f32, img.height() as f32);
    let mut out = image::RgbImage::new(112, 112);
    for (u, v, px) in out.enumerate_pixels_mut() {
        let (du, dv) = (u as f32 - tx, v as f32 - ty);
        let sx = (a * du + b * dv) / det;
        let sy = (-b * du + a * dv) / det;
        if sx < 0.0 || sy < 0.0 || sx > w - 1.0 || sy > h - 1.0 {
            continue;
        }
        let (x0, y0) = (sx.floor() as u32, sy.floor() as u32);
        let (x1, y1) = ((x0 + 1).min(img.width() - 1), (y0 + 1).min(img.height() - 1));
        let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
        let (p00, p10, p01, p11) = (img.get_pixel(x0, y0), img.get_pixel(x1, y0), img.get_pixel(x0, y1), img.get_pixel(x1, y1));
        for c in 0..3 {
            let top = p00[c] as f32 * (1.0 - fx) + p10[c] as f32 * fx;
            let bottom = p01[c] as f32 * (1.0 - fx) + p11[c] as f32 * fx;
            px[c] = (top * (1.0 - fy) + bottom * fy).round() as u8;
        }
    }
    out
}

// ----------------- MODEL DOWNLOAD (official InsightFace buffalo_l package) -----------------

pub const BUFFALO_L_URL: &str = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip";

#[derive(Serialize, Clone)]
pub struct FaceModelDownloadProgress {
    pub downloaded_mb: f64,
    pub total_mb: f64,
    pub percent: usize,
    pub stage: String,
    pub done: bool,
}

pub fn sha256_hex(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn model_file_ok(path: &Path, sha256: &str) -> bool {
    sha256_hex(path).as_deref() == Some(sha256)
}

static FACE_MODELS_V2_VERIFIED: AtomicBool = AtomicBool::new(false);

// Progress of a model download: (bytes so far, total bytes)
pub type DownloadProgress<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

// Makes sure det_10g.onnx and w600k_r50.onnx in `dir` exist and match the official checksums, downloading
// InsightFace's buffalo_l package once if needed (288 MB; only the two models are kept).
// Returns whether a download was needed. Used by the app and by `--prepare-models` (Lumina Setup).
pub async fn ensure_face_models_in(dir: &Path, progress: DownloadProgress<'_>) -> Result<bool, String> {
    let (det, emb) = (dir.join(DETECTOR_FILE), dir.join(EMBEDDER_FILE));
    let check_dir = dir.to_path_buf();
    let present = tokio::task::spawn_blocking(move || {
        model_file_ok(&check_dir.join(DETECTOR_FILE), DETECTOR_SHA256) && model_file_ok(&check_dir.join(EMBEDDER_FILE), EMBEDDER_SHA256)
    })
    .await
    .unwrap_or(false);
    if present {
        return Ok(false);
    }
    download_buffalo_l(dir, progress).await?;
    if !(model_file_ok(&det, DETECTOR_SHA256) && model_file_ok(&emb, EMBEDDER_SHA256)) {
        return Err("The downloaded face models failed their checksum. Please try again.".into());
    }
    Ok(true)
}

pub async fn ensure_face_models_v2(app: &dyn Host) -> Result<PathBuf, String> {
    let dir = get_models_dir(app);
    if FACE_MODELS_V2_VERIFIED.load(Ordering::Acquire) {
        return Ok(dir);
    }
    let last_percent = AtomicUsize::new(usize::MAX);
    let emit_progress = |done: u64, total: u64| {
        let percent = (done * 100 / total.max(1)) as usize;
        if last_percent.swap(percent, Ordering::Relaxed) != percent {
            let _ = emit_to(&app, 
                "face-model-download",
                FaceModelDownloadProgress {
                    downloaded_mb: (done as f64 / 1_048_576.0 * 10.0).round() / 10.0,
                    total_mb: (total as f64 / 1_048_576.0 * 10.0).round() / 10.0,
                    percent: percent.min(99),
                    stage: "Downloading face recognition models".into(),
                    done: false,
                },
            );
        }
    };
    let result = ensure_face_models_in(&dir, &emit_progress).await;
    if result != Ok(false) {
        let _ = emit_to(&app, 
            "face-model-download",
            FaceModelDownloadProgress {
                downloaded_mb: 0.0,
                total_mb: 0.0,
                percent: 100,
                stage: if result.is_ok() { "Face models ready".into() } else { "Face model download failed".into() },
                done: true,
            },
        );
    }
    result?;
    FACE_MODELS_V2_VERIFIED.store(true, Ordering::Release);
    Ok(dir)
}

async fn download_buffalo_l(dir: &Path, progress: DownloadProgress<'_>) -> Result<(), String> {
    let zip_part = dir.join("buffalo_l.zip.part");
    // No overall timeout: 288 MB can take minutes; only connecting and stalls are bounded
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client
        .get(BUFFALO_L_URL)
        .send()
        .await
        .map_err(|e| format!("Could not download the face models: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Could not download the face models: HTTP {}", res.status()));
    }
    let total = res.content_length().unwrap_or(288_621_354);
    let mut file = File::create(&zip_part).map_err(|e| e.to_string())?;
    let mut downloaded = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("Face model download interrupted: {e}"))? {
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        progress(downloaded, total);
    }
    drop(file);

    let dir = dir.to_path_buf();
    let extracted = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let archive_file = File::open(&zip_part).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(BufReader::new(archive_file)).map_err(|e| format!("Corrupt face model package: {e}"))?;
        for (name, sha) in [(DETECTOR_FILE, DETECTOR_SHA256), (EMBEDDER_FILE, EMBEDDER_SHA256)] {
            let target = dir.join(name);
            let part = dir.join(format!("{name}.part"));
            {
                let mut entry = archive.by_name(name).map_err(|e| format!("{name} missing from the package: {e}"))?;
                let mut out = File::create(&part).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            }
            if !model_file_ok(&part, sha) {
                let _ = fs::remove_file(&part);
                return Err(format!("{name} failed its checksum"));
            }
            fs::rename(&part, &target).map_err(|e| e.to_string())?;
        }
        let _ = fs::remove_file(&zip_part);
        // The previous engine's models are no longer used
        let _ = fs::remove_file(dir.join("version-RFB-320.onnx"));
        let _ = fs::remove_file(dir.join("w600k_mbf.onnx"));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;
    extracted
}

// Loaded once and shared by every face operation (sessions are internally locked)
static FACE_MODELS_V2: LazyLock<Mutex<Option<Arc<FaceModels>>>> = LazyLock::new(|| Mutex::new(None));

// The device the face models ran on when they last loaded ("GPU (CUDA)", or "CPU (GPU unavailable: ...)"):
// they are dropped between jobs on a server, which still wants to show it
static LAST_DEVICE: Mutex<Option<String>> = Mutex::new(None);

pub fn last_device() -> Option<String> {
    LAST_DEVICE.lock().ok().and_then(|d| d.clone())
}

pub async fn face_models_v2(app: &dyn Host) -> Result<Arc<FaceModels>, String> {
    if let Some(models) = FACE_MODELS_V2.lock().ok().and_then(|g| g.clone()) {
        return Ok(models);
    }
    let dir = ensure_face_models_v2(app).await?;
    let loaded = tokio::task::spawn_blocking(move || FaceModels::load(&dir))
        .await
        .map_err(|e| e.to_string())??;
    if let Ok(mut last) = LAST_DEVICE.lock() {
        *last = Some(loaded.device.clone());
    }
    let loaded = Arc::new(loaded);
    if let Ok(mut slot) = FACE_MODELS_V2.lock() {
        if slot.is_none() {
            *slot = Some(loaded.clone());
        }
        return Ok(slot.clone().unwrap_or(loaded));
    }
    Ok(loaded)
}

// Drops the face models and the smart search models (the eye check holds those too), so their GPU memory
// goes back to the card: the server does this before Ollama's caption model needs it. The next use loads
// them again (about a second); a scan that still holds them keeps them until it ends.
pub fn release_models() {
    if let Ok(mut slot) = FACE_MODELS_V2.lock() {
        *slot = None;
    }
    clip::release_clip_models();
}

// Already-loaded models without awaiting (for blocking code that runs after face_models_v2 was awaited)
pub fn loaded_face_models_v2() -> Option<Arc<FaceModels>> {
    FACE_MODELS_V2.lock().ok().and_then(|g| g.clone())
}

// ----------------- APP INTEGRATION -----------------

// 96px face thumbnail from a box enlarged by 30%, so the UI shows the whole head rather than a tight crop
pub fn face_thumbnail(img: &DynamicImage, bbox: (f64, f64, f64, f64)) -> image::RgbImage {
    let (w, h) = (img.width() as f64, img.height() as f64);
    let (cx, cy) = ((bbox.0 + bbox.2 / 2.0) * w, (bbox.1 + bbox.3 / 2.0) * h);
    let side = (bbox.2 * w).max(bbox.3 * h) * 1.3;
    let x = (cx - side / 2.0).clamp(0.0, (w - 1.0).max(0.0));
    let y = (cy - side / 2.0).clamp(0.0, (h - 1.0).max(0.0));
    let cw = side.min(w - x).max(1.0);
    let ch = side.min(h - y).max(1.0);
    img.crop_imm(x as u32, y as u32, cw as u32, ch as u32)
        .resize_to_fill(96, 96, FilterType::Triangle)
        .to_rgb8()
}

impl FaceModels {
    // Landmarks for a box (e.g. one the user drew): the detector run inside the box (enlarged by 40%); if it
    // finds nothing there, the template placed in the box itself. Used to embed and measure stored boxes.
    fn landmarks_for_box(&self, img: &DynamicImage, bbox: (f64, f64, f64, f64)) -> Result<[(f32, f32); 5], String> {
        let (w, h) = (img.width() as f64, img.height() as f64);
        let pad = 0.4;
        let x0 = ((bbox.0 - bbox.2 * pad / 2.0) * w).clamp(0.0, w - 1.0);
        let y0 = ((bbox.1 - bbox.3 * pad / 2.0) * h).clamp(0.0, h - 1.0);
        let x1 = ((bbox.0 + bbox.2 * (1.0 + pad / 2.0)) * w).clamp(x0 + 1.0, w);
        let y1 = ((bbox.1 + bbox.3 * (1.0 + pad / 2.0)) * h).clamp(y0 + 1.0, h);
        let region = img.crop_imm(x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32);
        Ok(match self.detect(&region)?.into_iter().next() {
            // Detections are sorted by score; map the best one's landmarks back to full-image pixels
            Some(d) => d.landmarks.map(|(lx, ly)| (lx + x0 as f32, ly + y0 as f32)),
            None => {
                // No detection: place the template's landmarks inside the (square-ified) user box
                let side = (bbox.2 * w).max(bbox.3 * h) as f32;
                let (bx, by) = (
                    (bbox.0 * w) as f32 + ((bbox.2 * w) as f32 - side) / 2.0,
                    (bbox.1 * h) as f32 + ((bbox.3 * h) as f32 - side) / 2.0,
                );
                ARCFACE_TEMPLATE.map(|(tx, ty)| (bx + tx / 112.0 * side, by + ty / 112.0 * side))
            }
        })
    }

    pub fn embed_region(&self, img: &DynamicImage, bbox: (f64, f64, f64, f64)) -> Result<Vec<f32>, String> {
        let landmarks = self.landmarks_for_box(img, bbox)?;
        let aligned = align_face(&img.to_rgb8(), &landmarks);
        self.embed(&[aligned])?.into_iter().next().ok_or_else(|| "no embedding produced".to_string())
    }
}

// Stores one face (engine v2): reuses the id/name of an overlapping face on the same photo, writes the
// thumbnail, embedding and people links. Same rules as the original save_cropped_face_and_record.
#[allow(clippy::too_many_arguments)]
pub fn record_face_v2(
    app: &dyn Host,
    conn: &Connection,
    hash: &str,
    img: &DynamicImage,
    bbox: (f64, f64, f64, f64),
    embedding: Vec<f32>,
    score: f64,
    person_name: Option<String>,
    source: &str,
    quality: FaceQuality,
) -> Option<FaceInstance> {
    let mut previous_person: Option<String> = None;
    let (face_id, resolved_person_name) =
        if let Some((existing_id, existing_name)) = find_overlapping_face_id(conn, hash, bbox, None) {
            previous_person = existing_name.clone();
            (existing_id, person_name.or(existing_name))
        } else {
            (
                format!("{}_{}_{}", hash, (bbox.0 * 100.0).round() as i32, (bbox.1 * 100.0).round() as i32),
                person_name,
            )
        };

    let faces_dir = get_app_storage_dir(app).join("faces");
    let _ = fs::create_dir_all(&faces_dir);
    let face_thumb_path = faces_dir.join(format!("{}.jpg", face_id));
    let _ = face_thumbnail(img, bbox).save(&face_thumb_path);
    let face_thumb_str = face_thumb_path.to_string_lossy().to_string();

    let _ = conn.execute(
        "INSERT INTO photo_faces (face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, person_name, face_thumb, embedding, embedding_blob, engine, confidence, source, eyes_open, face_sharpness)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '[]', ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(face_id) DO UPDATE SET
            bbox_x = excluded.bbox_x,
            bbox_y = excluded.bbox_y,
            bbox_w = excluded.bbox_w,
            bbox_h = excluded.bbox_h,
            person_name = COALESCE(excluded.person_name, photo_faces.person_name),
            face_thumb = excluded.face_thumb,
            embedding = '[]',
            embedding_blob = excluded.embedding_blob,
            engine = excluded.engine,
            confidence = excluded.confidence,
            source = excluded.source,
            eyes_open = COALESCE(excluded.eyes_open, photo_faces.eyes_open),
            face_sharpness = COALESCE(excluded.face_sharpness, photo_faces.face_sharpness)",
        params![
            face_id,
            hash,
            bbox.0,
            bbox.1,
            bbox.2,
            bbox.3,
            resolved_person_name,
            face_thumb_str,
            embedding_to_blob(&embedding),
            FACE_ENGINE_V2,
            score,
            source,
            quality.eyes_open,
            quality.sharpness
        ],
    );
    if let Ok(mut cache) = FACE_EMBEDDING_CACHE.lock() {
        cache.insert(face_id.clone(), embedding);
    }

    if let Some(ref p_name) = resolved_person_name {
        let clean = p_name.trim().to_string();
        if !clean.is_empty() {
            let _ = conn.execute(
                "INSERT INTO people (name, cover_face_thumb) VALUES (?1, ?2)
                 ON CONFLICT(name) DO UPDATE SET cover_face_thumb = excluded.cover_face_thumb",
                params![clean, face_thumb_str],
            );
        }
    }
    sync_photo_people_from_faces(conn, hash, previous_person.as_deref());

    Some(FaceInstance {
        face_id,
        hash: hash.to_string(),
        bbox_x: bbox.0,
        bbox_y: bbox.1,
        bbox_w: bbox.2,
        bbox_h: bbox.3,
        person_name: resolved_person_name,
        face_thumb: face_thumb_str,
        confidence: score,
        eyes_open: quality.eyes_open.map(f64::from),
        face_sharpness: quality.sharpness.map(f64::from),
    })
}
