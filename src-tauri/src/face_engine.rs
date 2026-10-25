use crate::*;

pub static FACE_EMBEDDING_CACHE: LazyLock<Mutex<HashMap<String, Vec<f32>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub static EMBEDDING_CACHE_WARMED: AtomicBool = AtomicBool::new(false);

pub static PENDING_CANDIDATES_CACHE: LazyLock<Mutex<HashMap<String, Vec<SimilarFaceCandidate>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn ensure_embedding_cache_loaded(conn: &Connection) {
    if EMBEDDING_CACHE_WARMED.load(Ordering::Acquire) {
        return;
    }
    let mut parsed_map: HashMap<String, Vec<f32>> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT face_id, embedding FROM photo_faces") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) {
            for (fid, emb_str) in rows.flatten() {
                if let Ok(vec) = serde_json::from_str::<Vec<f32>>(&emb_str) {
                    if !vec.is_empty() {
                        parsed_map.insert(fid, vec);
                    }
                }
            }
        }
    }
    if let Ok(mut guard) = FACE_EMBEDDING_CACHE.lock() {
        for (k, v) in parsed_map {
            guard.entry(k).or_insert(v);
        }
    }
    EMBEDDING_CACHE_WARMED.store(true, Ordering::Release);
}

// ----------------- HIGH-PRECISION FACE EMBEDDING & VERIFICATION -----------------

pub fn has_bilateral_face_structure(face_img: &DynamicImage) -> bool {
    let gray = face_img.resize_exact(32, 32, FilterType::Triangle).to_luma8();
    let mut sym_diff = 0.0f32;
    let mut total_var = 0.0f32;
    let mut mean_luma = 0.0f32;

    for y in 4..28 {
        for x in 4..28 {
            mean_luma += gray.get_pixel(x, y)[0] as f32 / 255.0;
        }
    }
    mean_luma /= (24 * 24) as f32;

    for y in 6..26 {
        for x in 4..16 {
            let left_px = gray.get_pixel(x, y)[0] as f32 / 255.0;
            let right_px = gray.get_pixel(31 - x, y)[0] as f32 / 255.0;
            sym_diff += (left_px - right_px).abs();
            total_var += (left_px - mean_luma).abs() + (right_px - mean_luma).abs();
        }
    }

    let avg_sym_diff = sym_diff / (20.0 * 12.0);
    let avg_var = total_var / (20.0 * 24.0);

    avg_var > 0.065 && avg_sym_diff < 0.22
}

// ----------------- PHASE 3: PURE-RUST ONNX NEURAL FACE DETECTION & BIOMETRIC ENGINE -----------------

pub type OnnxPlan = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

pub static ULTRAFACE_PLAN: LazyLock<Mutex<Option<Arc<OnnxPlan>>>> = LazyLock::new(|| Mutex::new(None));
pub static MOBILEFACENET_PLAN: LazyLock<Mutex<Option<Arc<OnnxPlan>>>> = LazyLock::new(|| Mutex::new(None));

pub const ULTRAFACE_URL: &str = "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx";
pub const MOBILEFACENET_URL: &str = "https://huggingface.co/WePrompt/buffalo_sc/resolve/main/w600k_mbf.onnx";

pub fn get_models_dir(app: &AppHandle) -> PathBuf {
    let dir = get_app_storage_dir(app).join("models");
    let _ = fs::create_dir_all(&dir);
    dir
}

static FACE_MODELS_VERIFIED: AtomicBool = AtomicBool::new(false);
static LEGACY_UPGRADE_STARTED: AtomicBool = AtomicBool::new(false);

// A model file is usable only if it is large enough AND parses as an ONNX graph
// (a truncated download can easily pass a size check).
pub fn onnx_model_file_is_valid(path: &Path, min_len: u64) -> bool {
    path.metadata().map(|m| m.len() >= min_len).unwrap_or(false)
        && tract_onnx::onnx().model_for_path(path).is_ok()
}

// Downloads to `<name>.part`, validates, then renames into place, so a failed or interrupted
// download never leaves a corrupt model where the loader would find it.
async fn download_model_verified(url: &str, final_path: &Path, min_len: u64, label: &str) -> Result<(), String> {
    let part_path = final_path.with_extension("onnx.part");
    let resp = HTTP_CLIENT
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download the {label} face model: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Failed to download the {label} face model: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Download of the {label} face model was interrupted: {e}"))?;
    fs::write(&part_path, &bytes).map_err(|e| e.to_string())?;

    let part_for_check = part_path.clone();
    let valid = tauri::async_runtime::spawn_blocking(move || onnx_model_file_is_valid(&part_for_check, min_len))
        .await
        .unwrap_or(false);
    if !valid {
        let _ = fs::remove_file(&part_path);
        return Err(format!(
            "The downloaded {label} face model is incomplete or corrupt ({} bytes). Please try again.",
            bytes.len()
        ));
    }
    fs::rename(&part_path, final_path).map_err(|e| e.to_string())
}

async fn ensure_model(url: &str, path: PathBuf, min_len: u64, label: &str) -> Result<(), String> {
    let path_for_check = path.clone();
    let valid = tauri::async_runtime::spawn_blocking(move || onnx_model_file_is_valid(&path_for_check, min_len))
        .await
        .unwrap_or(false);
    if valid {
        return Ok(());
    }
    // Missing, or corrupt from an earlier interrupted download: replace it
    let _ = fs::remove_file(&path);
    download_model_verified(url, &path, min_len, label).await
}

#[tauri::command]
pub async fn ensure_neural_face_models(app: AppHandle) -> Result<String, String> {
    if !FACE_MODELS_VERIFIED.load(Ordering::Acquire) {
        let models_dir = get_models_dir(&app);
        ensure_model(ULTRAFACE_URL, models_dir.join("version-RFB-320.onnx"), 100_000, "UltraFace detector").await?;
        // MobileFaceNet produces the 512-D embeddings that face matching depends on
        ensure_model(MOBILEFACENET_URL, models_dir.join("w600k_mbf.onnx"), 500_000, "MobileFaceNet embedder").await?;
        FACE_MODELS_VERIFIED.store(true, Ordering::Release);
    }

    // Upgrade any legacy 384-D face embeddings once per session, in the background
    if !LEGACY_UPGRADE_STARTED.swap(true, Ordering::AcqRel) {
        let app_for_upgrade = app.clone();
        std::thread::spawn(move || {
            upgrade_legacy_face_embeddings(&app_for_upgrade);
        });
    }

    Ok("Neural ONNX face models ready".to_string())
}

pub fn upgrade_legacy_face_embeddings(app: &AppHandle) {
    if get_or_load_mobilefacenet(app).is_none() {
        return;
    }
    let Ok(mut conn) = open_global_db(app) else {
        return;
    };
    let mut legacy_rows: Vec<(String, String)> = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT face_id, face_thumb, embedding FROM photo_faces") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        }) {
            for (fid, thumb, emb_str) in rows.flatten() {
                let is_512 = serde_json::from_str::<Vec<f32>>(&emb_str)
                    .map(|v| v.len() == 512)
                    .unwrap_or(false);
                if !is_512 && Path::new(&thumb).exists() {
                    legacy_rows.push((fid, thumb));
                }
            }
        }
    }
    if legacy_rows.is_empty() {
        return;
    }
    if let Ok(tx) = conn.transaction() {
        for (fid, thumb) in legacy_rows {
            if let Ok(img) = image::open(&thumb) {
                let new_emb = compute_face_embedding(&img);
                if new_emb.len() == 512 {
                    if let Ok(emb_json) = serde_json::to_string(&new_emb) {
                        let _ = tx.execute(
                            "UPDATE photo_faces SET embedding = ?1 WHERE face_id = ?2",
                            params![emb_json, fid],
                        );
                        if let Ok(mut guard) = FACE_EMBEDDING_CACHE.lock() {
                            guard.insert(fid.clone(), new_emb);
                        }
                    }
                }
            }
        }
        let _ = tx.commit();
    }
}

pub fn get_or_load_mobilefacenet(app: &AppHandle) -> Option<Arc<OnnxPlan>> {
    let mut guard = MOBILEFACENET_PLAN.lock().ok()?;
    if let Some(ref plan) = *guard {
        return Some(plan.clone());
    }

    let embedder_path = get_models_dir(app).join("w600k_mbf.onnx");
    if !embedder_path.exists() || embedder_path.metadata().map(|m| m.len() < 500_000).unwrap_or(true) {
        return None;
    }

    let model = tract_onnx::onnx()
        .with_ignore_output_shapes(true)
        .model_for_path(&embedder_path)
        .ok()?
        .with_input_fact(0, f32::fact([1, 3, 112, 112]).into())
        .ok()?
        .into_optimized()
        .or_else(|_| {
            tract_onnx::onnx()
                .with_ignore_output_shapes(true)
                .model_for_path(&embedder_path)?
                .with_input_fact(0, f32::fact([1, 3, 112, 112]).into())?
                .into_typed()?
                .into_decluttered()
        })
        .ok()?
        .into_runnable()
        .ok()?;

    // Shared, not cloned: every thread runs the same plan concurrently (run() takes &self)
    let model = Arc::new(model);
    *guard = Some(model.clone());
    Some(model)
}

pub fn get_or_load_ultraface(app: &AppHandle) -> Option<Arc<OnnxPlan>> {
    let mut guard = ULTRAFACE_PLAN.lock().ok()?;
    if let Some(ref plan) = *guard {
        return Some(plan.clone());
    }

    let detector_path = get_models_dir(app).join("version-RFB-320.onnx");
    if !detector_path.exists() || detector_path.metadata().map(|m| m.len() < 100_000).unwrap_or(true) {
        return None;
    }

    let model = tract_onnx::onnx()
        .model_for_path(&detector_path)
        .ok()?
        .with_input_fact(0, f32::fact([1, 3, 240, 320]).into())
        .ok()?
        .into_optimized()
        .ok()?
        .into_runnable()
        .ok()?;

    // Shared, not cloned: every thread runs the same plan concurrently (run() takes &self)
    let model = Arc::new(model);
    *guard = Some(model.clone());
    Some(model)
}

// Generates the exact 4,420 prior anchor boxes for UltraFace-RFB-320 (input 320x240)
pub fn generate_ultraface_priors() -> Vec<[f32; 4]> {
    let image_w = 320.0f32;
    let image_h = 240.0f32;
    let strides = [8.0f32, 16.0, 32.0, 64.0];
    let feature_maps = [(40usize, 30usize), (20, 15), (10, 8), (5, 4)];
    let min_boxes: [&[f32]; 4] = [
        &[10.0, 16.0, 24.0],
        &[32.0, 48.0],
        &[64.0, 96.0],
        &[128.0, 192.0, 256.0],
    ];

    let mut priors = Vec::with_capacity(4420);
    for (idx, &(fw, fh)) in feature_maps.iter().enumerate() {
        let stride = strides[idx];
        for y in 0..fh {
            for x in 0..fw {
                let cx = ((x as f32) + 0.5) * stride / image_w;
                let cy = ((y as f32) + 0.5) * stride / image_h;
                for &min_box in min_boxes[idx] {
                    let w = min_box / image_w;
                    let h = min_box / image_h;
                    priors.push([cx, cy, w, h]);
                }
            }
        }
    }
    priors
}

pub static ULTRAFACE_PRIORS: LazyLock<Vec<[f32; 4]>> = LazyLock::new(generate_ultraface_priors);

// Runs the UltraFace-RFB-320 ONNX neural network on an image in ~10ms!
// Returns only genuine human faces with high confidence (score >= 0.72), zero walls/chairs/mugs!
pub fn detect_faces_with_onnx(app: &AppHandle, img: &DynamicImage) -> Vec<(f64, f64, f64, f64, f64)> {
    let Some(plan) = get_or_load_ultraface(app) else {
        return Vec::new();
    };

    let resized = img.resize_exact(320, 240, FilterType::Triangle).to_rgb8();
    let tensor = tract_ndarray::Array4::from_shape_fn((1, 3, 240, 320), |(_, c, y, x)| {
        let px = resized.get_pixel(x as u32, y as u32)[c] as f32;
        (px - 127.0) / 128.0
    })
    .into_tensor();

    let Ok(outputs) = plan.run(tvec!(tensor.into())) else {
        return Vec::new();
    };
    if outputs.len() < 2 {
        return Vec::new();
    }

    let Ok(scores_view) = outputs[0].to_array_view::<f32>() else {
        return Vec::new();
    };
    let Ok(boxes_view) = outputs[1].to_array_view::<f32>() else {
        return Vec::new();
    };

    let priors = &*ULTRAFACE_PRIORS;
    let num_priors = priors.len();
    let center_variance = 0.1f32;
    let size_variance = 0.2f32;

    let mut candidates: Vec<(f64, f64, f64, f64, f64)> = Vec::new();

    for i in 0..num_priors {
        let score = scores_view[[0, i, 1]];
        if score < 0.82 {
            continue;
        }

        let prior = priors[i];
        let dx = boxes_view[[0, i, 0]];
        let dy = boxes_view[[0, i, 1]];
        let dw = boxes_view[[0, i, 2]];
        let dh = boxes_view[[0, i, 3]];

        let cx = dx * center_variance * prior[2] + prior[0];
        let cy = dy * center_variance * prior[3] + prior[1];
        let w = (dw * size_variance).exp() * prior[2];
        let h = (dh * size_variance).exp() * prior[3];

        let xmin = (cx - w * 0.5).clamp(0.0, 0.98) as f64;
        let ymin = (cy - h * 0.5).clamp(0.0, 0.98) as f64;
        let xmax = (cx + w * 0.5).clamp(0.02, 1.0) as f64;
        let ymax = (cy + h * 0.5).clamp(0.02, 1.0) as f64;

        let bw = xmax - xmin;
        let bh = ymax - ymin;

        // Filter out microscopic noise or whole-screen false boxes
        if bw >= 0.035 && bh >= 0.035 && bw <= 0.85 && bh <= 0.85 {
            candidates.push((xmin, ymin, bw, bh, score as f64));
        }
    }

    // Non-Maximum Suppression (IoU <= 0.30)
    candidates.sort_by(|a, b| b.4.partial_cmp(&a.4).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<(f64, f64, f64, f64, f64)> = Vec::new();

    for cand in candidates {
        let (bx, by, bw, bh, _) = cand;
        let bcx = bx + bw * 0.5;
        let bcy = by + bh * 0.5;

        let overlaps = kept.iter().any(|&(kx, ky, kw, kh, _)| {
            let ix1 = bx.max(kx);
            let iy1 = by.max(ky);
            let ix2 = (bx + bw).min(kx + kw);
            let iy2 = (by + bh).min(ky + kh);
            let inter = (ix2 - ix1).max(0.0) * (iy2 - iy1).max(0.0);
            let area_b = bw * bh;
            let area_k = kw * kh;
            let union = area_b + area_k - inter;
            let min_area = area_b.min(area_k);

            let kcx = kx + kw * 0.5;
            let kcy = ky + kh * 0.5;
            let center_dist = ((bcx - kcx).powi(2) + (bcy - kcy).powi(2)).sqrt();
            let min_radius = (bw.min(kw) + bh.min(kh)) * 0.25;

            (union > 0.0 && (inter / union) > 0.25)
                || (min_area > 0.0 && (inter / min_area) > 0.55)
                || center_dist < min_radius
        });
        if !overlaps {
            kept.push(cand);
            if kept.len() >= 12 {
                break;
            }
        }
    }

    kept
}

// Computes a 512-D L2-normalized ArcFace embedding via MobileFaceNet ONNX
pub fn compute_face_embedding(face_img: &DynamicImage) -> Vec<f32> {
    // Take a reference to the shared plan and release the lock before running inference, so embeddings
    // on different threads run in parallel instead of one at a time
    let plan = MOBILEFACENET_PLAN.lock().ok().and_then(|guard| guard.clone());
    {
        if let Some(plan) = plan {
            // Square aspect-preserving crop at Lanczos3 quality for ArcFace 112x112 input
            let resized = face_img
                .resize_to_fill(112, 112, FilterType::Lanczos3)
                .to_rgb8();
            let tensor = tract_ndarray::Array4::from_shape_fn((1, 3, 112, 112), |(_, c, y, x)| {
                let px = resized.get_pixel(x as u32, y as u32)[c] as f32;
                (px - 127.5) / 128.0
            })
            .into_tensor();

            if let Ok(outputs) = plan.run(tvec!(tensor.into())) {
                if let Some(first) = outputs.first() {
                    if let Ok(view) = first.to_array_view::<f32>() {
                        let mut emb: Vec<f32> = view.iter().copied().collect();
                        if emb.len() >= 128 {
                            let norm = emb.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-6);
                            for v in &mut emb {
                                *v /= norm;
                            }
                            return emb;
                        }
                    }
                }
            }
        }
    }
    Vec::new()
}

// Single source of truth for face-match thresholds (512-D MobileFaceNet cosine). The badge counts, the review
// modal and its colour coding all use these via `get_face_match_config`. Phase 4 recalibrates them per engine.
pub const FACE_MATCH_MIN_SIMILARITY: f32 = 0.60;
pub const FACE_MATCH_STRONG_SIMILARITY: f32 = 0.62;

#[derive(Serialize)]
pub struct FaceMatchConfig {
    pub min_similarity_percent: f32,
    pub strong_similarity_percent: f32,
}

#[tauri::command]
pub fn get_face_match_config() -> FaceMatchConfig {
    FaceMatchConfig {
        min_similarity_percent: FACE_MATCH_MIN_SIMILARITY * 100.0,
        strong_similarity_percent: FACE_MATCH_STRONG_SIMILARITY * 100.0,
    }
}

// Pending-candidate cache entries are per person AND per library folder
pub fn pending_cache_key(person: &str, root_folder: Option<&str>) -> String {
    format!("{}|{}", person.trim().to_lowercase(), make_folder_prefix(root_folder).to_lowercase())
}

// Swaps in freshly computed candidates for one folder, leaving other folders' cached entries alone
pub fn replace_pending_for_folder(root_folder: Option<&str>, fresh: HashMap<String, Vec<SimilarFaceCandidate>>) {
    let suffix = format!("|{}", make_folder_prefix(root_folder).to_lowercase());
    if let Ok(mut g) = PENDING_CANDIDATES_CACHE.lock() {
        g.retain(|k, _| !k.ends_with(&suffix));
        g.extend(fresh);
    }
}

pub fn invalidate_pending_for_person(person: &str) {
    let prefix = format!("{}|", person.trim().to_lowercase());
    if let Ok(mut g) = PENDING_CANDIDATES_CACHE.lock() {
        g.retain(|k, _| !k.starts_with(&prefix));
    }
}

// Intersection-over-union of two normalized (x, y, w, h) boxes
pub fn bbox_iou(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> f64 {
    let ix = (a.0 + a.2).min(b.0 + b.2) - a.0.max(b.0);
    let iy = (a.1 + a.3).min(b.1 + b.3) - a.1.max(b.1);
    let inter = ix.max(0.0) * iy.max(0.0);
    let union = a.2 * a.3 + b.2 * b.3 - inter;
    if union > 0.0 { inter / union } else { 0.0 }
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

pub fn compute_normalized_centroid(embeddings: &[Vec<f32>], dim: usize) -> Option<Vec<f32>> {
    let valid: Vec<&Vec<f32>> = embeddings.iter().filter(|e| e.len() == dim).collect();
    if valid.is_empty() {
        return None;
    }
    let mut centroid = vec![0.0f32; dim];
    for emb in &valid {
        for (i, &val) in emb.iter().enumerate() {
            centroid[i] += val;
        }
    }
    let norm = centroid.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-6);
    for v in &mut centroid {
        *v /= norm;
    }
    Some(centroid)
}

pub fn score_against_person_profile(
    cand_emb: &[f32],
    ref_embeddings: &[Vec<f32>],
    centroid_512: Option<&Vec<f32>>,
    _centroid_384: Option<&Vec<f32>>,
) -> f32 {
    if cand_emb.len() != 512 {
        return 0.0;
    }
    let best_exemplar = ref_embeddings
        .iter()
        .filter(|r| r.len() == 512)
        .map(|r| cosine_similarity(r, cand_emb))
        .fold(0.0f32, f32::max);
    let centroid_sim = centroid_512
        .map(|c| cosine_similarity(c, cand_emb))
        .unwrap_or(0.0);
    if centroid_sim > 0.0 {
        0.55 * best_exemplar + 0.45 * centroid_sim
    } else {
        best_exemplar
    }
}

pub fn find_overlapping_face_id(
    conn: &Connection,
    hash: &str,
    bbox: (f64, f64, f64, f64),
    claimed_ids: Option<&std::collections::HashSet<String>>,
) -> Option<(String, Option<String>)> {
    let existing = get_faces_for_hash(conn, hash);
    let (bx, by, bw, bh) = bbox;
    let bcx = bx + bw * 0.5;
    let bcy = by + bh * 0.5;

    let mut best_match: Option<(String, Option<String>, f64)> = None;

    for f in existing {
        if let Some(claimed) = claimed_ids {
            if claimed.contains(&f.face_id) {
                continue;
            }
        }
        let ix1 = bx.max(f.bbox_x);
        let iy1 = by.max(f.bbox_y);
        let ix2 = (bx + bw).min(f.bbox_x + f.bbox_w);
        let iy2 = (by + bh).min(f.bbox_y + f.bbox_h);
        let inter = (ix2 - ix1).max(0.0) * (iy2 - iy1).max(0.0);
        let area_a = bw * bh;
        let area_b = f.bbox_w * f.bbox_h;
        let union = area_a + area_b - inter;
        let min_area = area_a.min(area_b);

        let fcx = f.bbox_x + f.bbox_w * 0.5;
        let fcy = f.bbox_y + f.bbox_h * 0.5;
        let center_dist = ((bcx - fcx).powi(2) + (bcy - fcy).powi(2)).sqrt();
        let min_radius = (bw.min(f.bbox_w) + bh.min(f.bbox_h)) * 0.18;

        let iou = if union > 0.0 { inter / union } else { 0.0 };
        let containment = if min_area > 0.0 { inter / min_area } else { 0.0 };

        if iou > 0.30 || containment > 0.60 || center_dist < min_radius {
            let score = iou.max(containment);
            if best_match.as_ref().map(|b| score > b.2).unwrap_or(true) {
                best_match = Some((f.face_id, f.person_name, score));
            }
        }
    }
    best_match.map(|(id, name, _)| (id, name))
}

pub fn sync_photo_people_from_faces(conn: &Connection, hash: &str, previous_face_person: Option<&str>) {
    // Ensure all currently named faces on this photo exist in photo_people
    let faces = get_faces_for_hash(conn, hash);
    let active_face_names: std::collections::HashSet<String> = faces
        .iter()
        .filter_map(|f| f.person_name.as_ref().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect();

    for name in &active_face_names {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)",
            params![hash, name],
        );
    }

    // If a face was renamed or removed, remove the old person_name from photo_people if no other face on this photo still has it
    if let Some(prev_name) = previous_face_person {
        let clean_prev = prev_name.trim();
        if !clean_prev.is_empty() && !active_face_names.iter().any(|n| n.eq_ignore_ascii_case(clean_prev)) {
            let _ = conn.execute(
                "DELETE FROM photo_people WHERE hash = ?1 AND lower(person_name) = lower(?2)",
                params![hash, clean_prev],
            );
        }
    }
}

pub fn save_cropped_face_and_record(
    app: &AppHandle,
    conn: &Connection,
    hash: &str,
    img: &DynamicImage,
    bbox: (f64, f64, f64, f64),
    person_name: Option<String>,
    source: &str,
) -> Option<FaceInstance> {
    let (img_w, img_h) = img.dimensions();
    if img_w < 16 || img_h < 16 {
        return None;
    }

    let x = ((bbox.0.clamp(0.0, 0.95)) * img_w as f64) as u32;
    let y = ((bbox.1.clamp(0.0, 0.95)) * img_h as f64) as u32;
    let w = ((bbox.2.clamp(0.03, 1.0)) * img_w as f64)
        .min((img_w - x) as f64)
        .max(16.0) as u32;
    let h = ((bbox.3.clamp(0.03, 1.0)) * img_h as f64)
        .min((img_h - y) as f64)
        .max(16.0) as u32;

    let cropped = img.crop_imm(x, y, w, h);

    if person_name.is_none() && !has_bilateral_face_structure(&cropped) {
        return None;
    }

    // Ensure MobileFaceNet is warmed up so we always generate 512-D embeddings consistently
    let _ = get_or_load_mobilefacenet(app);
    let embedding = compute_face_embedding(&cropped);
    let emb_json = serde_json::to_string(&embedding).unwrap_or_else(|_| "[]".to_string());

    // Check if this box overlaps an already-recorded face on this photo
    let mut previous_person: Option<String> = None;
    let (face_id, resolved_person_name) =
        if let Some((existing_id, existing_name)) = find_overlapping_face_id(conn, hash, bbox, None) {
            previous_person = existing_name.clone();
            (existing_id, person_name.or(existing_name))
        } else {
            (
                format!(
                    "{}_{}_{}",
                    hash,
                    (bbox.0 * 100.0).round() as i32,
                    (bbox.1 * 100.0).round() as i32
                ),
                person_name,
            )
        };

    if let Ok(mut guard) = FACE_EMBEDDING_CACHE.lock() {
        guard.insert(face_id.clone(), embedding);
    }
    let faces_dir = get_app_storage_dir(app).join("faces");
    let _ = fs::create_dir_all(&faces_dir);
    let face_thumb_path = faces_dir.join(format!("{}.jpg", face_id));

    let thumb_96 = cropped.resize_to_fill(96, 96, FilterType::Triangle).to_rgb8();
    let _ = thumb_96.save(&face_thumb_path);
    let face_thumb_str = face_thumb_path.to_string_lossy().to_string();

    let _ = conn.execute(
        "INSERT INTO photo_faces (face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, person_name, face_thumb, embedding, confidence, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1.0, ?10)
         ON CONFLICT(face_id) DO UPDATE SET
            bbox_x = excluded.bbox_x,
            bbox_y = excluded.bbox_y,
            bbox_w = excluded.bbox_w,
            bbox_h = excluded.bbox_h,
            person_name = COALESCE(excluded.person_name, photo_faces.person_name),
            face_thumb = excluded.face_thumb,
            embedding = excluded.embedding,
            source = excluded.source",
        params![
            face_id,
            hash,
            bbox.0,
            bbox.1,
            bbox.2,
            bbox.3,
            resolved_person_name,
            face_thumb_str,
            emb_json,
            source
        ],
    );

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
        confidence: 1.0,
    })
}

pub fn get_faces_for_hash(conn: &Connection, hash: &str) -> Vec<FaceInstance> {
    let mut stmt = match conn.prepare(
        "SELECT face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, person_name, face_thumb, confidence
         FROM photo_faces WHERE hash = ?1 ORDER BY bbox_x ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![hash], |row| {
        Ok(FaceInstance {
            face_id: row.get(0)?,
            hash: row.get(1)?,
            bbox_x: row.get(2)?,
            bbox_y: row.get(3)?,
            bbox_w: row.get(4)?,
            bbox_h: row.get(5)?,
            person_name: row.get(6)?,
            face_thumb: row.get(7)?,
            confidence: row.get(8)?,
        })
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    rows.flatten().collect()
}
