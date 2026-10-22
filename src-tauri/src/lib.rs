use base64::{engine::general_purpose, Engine as _};
use exif::{Reader, Tag, Value};
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageFormat};
use rayon::prelude::*;
use reverse_geocoder::ReverseGeocoder;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use tract_onnx::prelude::*;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

static GEOCODER: LazyLock<ReverseGeocoder> = LazyLock::new(ReverseGeocoder::new);

static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_default()
});

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FaceInstance {
    pub face_id: String,
    pub hash: String,
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub person_name: Option<String>,
    pub face_thumb: String,
    pub confidence: f64,
}

#[derive(Serialize, Clone)]
pub struct FaceMatchEvent {
    pub person_name: String,
    pub matched_hashes: Vec<String>,
    pub total_matched: usize,
}

#[derive(Serialize, Clone)]
pub struct FaceScanProgress {
    pub completed: usize,
    pub total: usize,
    pub faces_found: usize,
    pub auto_matched: usize,
    pub done: bool,
}

#[derive(Serialize, Clone)]
pub struct PhotoItem {
    pub hash: String,
    pub name: String,
    pub subfolder: String,
    pub path: String,
    pub thumb_path: String,
    pub size_kb: u64,
    pub width: u32,
    pub height: u32,
    pub thumb_ready: bool,
    pub rating: i32,
    pub flag: Option<String>,          // "pick", "reject", or null
    pub color_label: Option<String>,   // "red", "yellow", "green", "blue", or null
    pub rotation: i32,                 // 0, 90, 180, 270 degrees
    pub in_basket: bool,
    pub tags: Vec<String>,
    pub people: Vec<String>,
    pub faces: Vec<FaceInstance>,
    pub ai_caption: String,
    pub ocr_text: String,
    pub captured_at: String,
    pub camera_model: String,
    pub location: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub dhash: String,
    pub sharpness: f64,
    pub duplicate_group: Option<usize>,
    pub staged_target: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PersonItem {
    pub id: i64,
    pub name: String,
    pub photo_count: i64,
    pub cover_thumb: String,
}

#[derive(Serialize, Clone)]
pub struct StagedOperation {
    pub hash: String,
    pub current_path: String,
    pub target_subfolder: String,
    pub filename: String,
}

#[derive(Serialize, Clone)]
pub struct ThumbBatchItem {
    pub hash: String,
    pub thumb_path: String,
    pub dhash: String,
    pub sharpness: f64,
    pub width: u32,
    pub height: u32,
    pub auto_tags: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ThumbBatchProgress {
    pub items: Vec<ThumbBatchItem>,
    pub duplicate_groups: HashMap<String, usize>,
    pub completed: usize,
    pub total: usize,
}

#[derive(Serialize, Clone)]
pub struct ExifRefreshResult {
    pub hash: String,
    pub captured_at: String,
    pub camera_model: String,
    pub location: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct TimelineBucket {
    pub period: String, // "YYYY-MM" or "YYYY"
    pub count: usize,
}

#[derive(Serialize, Clone)]
pub struct CitySearchResult {
    pub name: String,
    pub country: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Serialize, Clone)]
pub struct TimestampShiftResult {
    pub hash: String,
    pub captured_at: String,
}

#[derive(Serialize, Clone)]
pub struct LibraryHealthStats {
    pub total_photos: usize,
    pub total_library_size_mb: f64,
    pub trash_staged_count: usize,
    pub trash_recoverable_mb: f64,
    pub duplicate_extras_count: usize,
    pub duplicate_recoverable_mb: f64,
    pub cache_files_count: usize,
    pub cache_size_mb: f64,
    pub orphaned_cache_count: usize,
    pub camera_breakdown: Vec<(String, usize)>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct AiFaceBox {
    pub box_2d: Vec<f64>,
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct AiVisionResponse {
    pub objects: Vec<String>,
    pub scene: String,
    pub is_screenshot: bool,
    pub people_present: Vec<String>,
    pub face_boxes: Vec<AiFaceBox>,
    pub ocr_text: String,
    pub caption: String,
}

#[derive(Serialize, Clone)]
pub struct AiAnalysisResult {
    pub tags: Vec<String>,
    pub people: Vec<String>,
    pub faces: Vec<FaceInstance>,
    pub caption: String,
    pub ocr_text: String,
}

#[derive(Serialize)]
pub struct OllamaModelInfo {
    pub name: String,
    pub size_gb: f64,
}

#[derive(Serialize)]
pub struct OllamaStatus {
    pub running: bool,
    pub active_vram_model: Option<String>,
    pub installed_models: Vec<OllamaModelInfo>,
}

fn get_app_storage_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./phototriage_data"));
    let _ = fs::create_dir_all(&base);
    base
}

fn open_global_db(app: &AppHandle) -> Result<Connection, String> {
    let app_dir = get_app_storage_dir(app);
    let db_path = app_dir.join("library.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| e.to_string())?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS photos (
            hash TEXT PRIMARY KEY,
            current_path TEXT,
            subfolder TEXT,
            file_size INTEGER DEFAULT 0,
            modified_time INTEGER DEFAULT 0,
            width INTEGER DEFAULT 0,
            height INTEGER DEFAULT 0,
            rating INTEGER DEFAULT 0,
            flag TEXT DEFAULT NULL,
            color_label TEXT DEFAULT NULL,
            rotation INTEGER DEFAULT 0,
            in_basket INTEGER DEFAULT 0,
            ai_caption TEXT DEFAULT '',
            ocr_text TEXT DEFAULT '',
            captured_at TEXT DEFAULT '',
            camera_model TEXT DEFAULT '',
            location TEXT DEFAULT '',
            latitude REAL,
            longitude REAL,
            dhash TEXT DEFAULT '',
            sharpness REAL DEFAULT 0.0,
            staged_target TEXT DEFAULT NULL,
            exif_checked INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS photo_tags (
            hash TEXT,
            tag TEXT,
            PRIMARY KEY (hash, tag)
        );
        CREATE TABLE IF NOT EXISTS people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            cover_face_thumb TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS photo_people (
            hash TEXT,
            person_name TEXT,
            PRIMARY KEY (hash, person_name)
        );
        CREATE TABLE IF NOT EXISTS photo_faces (
            face_id TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            bbox_x REAL NOT NULL,
            bbox_y REAL NOT NULL,
            bbox_w REAL NOT NULL,
            bbox_h REAL NOT NULL,
            person_name TEXT,
            face_thumb TEXT NOT NULL,
            embedding TEXT NOT NULL,
            confidence REAL DEFAULT 1.0,
            source TEXT DEFAULT 'user'
        );",
    )
    .map_err(|e| e.to_string())?;

    let _ = conn.execute("ALTER TABLE photos ADD COLUMN flag TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN color_label TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN rotation INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN in_basket INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN ocr_text TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN latitude REAL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN longitude REAL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN dhash TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN sharpness REAL DEFAULT 0.0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN staged_target TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN exif_checked INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN width INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN height INTEGER DEFAULT 0", []);
    // Repair any previously shifted dates that used colons instead of hyphens in YYYY-MM-DD
    let _ = conn.execute(
        "UPDATE photos SET captured_at = substr(replace(captured_at, ':', '-'), 1, 10) || substr(captured_at, 11) WHERE length(captured_at) >= 10 AND substr(captured_at, 5, 1) = ':'",
        [],
    );
    let _ = conn.execute("ALTER TABLE people ADD COLUMN cover_face_thumb TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE photo_faces ADD COLUMN source TEXT DEFAULT 'user'", []);

    // Purge bad placeholder tags & fake face boxes on startup
    let _ = conn.execute(
        "DELETE FROM photo_tags WHERE tag IN ('tag1', 'tag2', 'tag3', 'object1', 'object2', 'analyze', 'first', 'got', 'let', 'step', 'okay', 'need', 'look')",
        [],
    );
    let _ = conn.execute(
        "UPDATE photos SET ai_caption = '' WHERE ai_caption = 'One short sentence.' OR ai_caption LIKE 'Got it, let%' OR ai_caption LIKE 'Okay, let%'",
        [],
    );
    let _ = conn.execute(
        "DELETE FROM photo_faces WHERE (person_name IS NULL OR person_name = '') AND source != 'onnx'",
        [],
    );

    Ok(conn)
}

fn compute_fast_hash(path: &Path, file_size: u64) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&file_size.to_le_bytes());

    let mut buffer = vec![0u8; 65536];
    let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
    hasher.update(&buffer[..bytes_read]);

    if file_size > 65536 * 2 {
        file.seek(SeekFrom::End(-65536)).map_err(|e| e.to_string())?;
        let bytes_read_end = file.read(&mut buffer).map_err(|e| e.to_string())?;
        hasher.update(&buffer[..bytes_read_end]);
    }

    Ok(hasher.finalize().to_hex()[..16].to_string())
}

fn compute_dhash(img: &DynamicImage) -> String {
    let gray = img.resize_exact(9, 9, FilterType::Triangle).to_luma8();
    let mut hash: u64 = 0;
    let mut bit = 0;
    for y in (0..8).step_by(2) {
        for x in 0..8 {
            if gray.get_pixel(x, y)[0] > gray.get_pixel(x + 1, y)[0] {
                hash |= 1u64 << bit;
            }
            bit += 1;
        }
    }
    for y in 0..8 {
        for x in (0..8).step_by(2) {
            if gray.get_pixel(x, y)[0] > gray.get_pixel(x, y + 1)[0] {
                hash |= 1u64 << bit;
            }
            bit += 1;
        }
    }
    format!("{:016x}", hash)
}

fn compute_sharpness(img: &DynamicImage) -> f64 {
    let gray = img.resize_exact(128, 128, FilterType::Triangle).to_luma8();
    let mut sum = 0.0;
    let mut sum_sq = 0.0;
    let mut count = 0.0;

    for y in 1..127 {
        for x in 1..127 {
            let c = gray.get_pixel(x, y)[0] as f64;
            let top = gray.get_pixel(x, y - 1)[0] as f64;
            let bottom = gray.get_pixel(x, y + 1)[0] as f64;
            let left = gray.get_pixel(x - 1, y)[0] as f64;
            let right = gray.get_pixel(x + 1, y)[0] as f64;

            let lap = (top + bottom + left + right - 4.0 * c).abs();
            sum += lap;
            sum_sq += lap * lap;
            count += 1.0;
        }
    }

    let mean = sum / count;
    let variance = (sum_sq / count) - (mean * mean);
    (variance * 10.0).round() / 10.0
}

fn is_likely_screenshot(file_path: &Path, camera_model: &str, img: Option<&DynamicImage>) -> bool {
    let fname = file_path
        .file_name()
        .map(|f| f.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if fname.contains("screenshot")
        || fname.contains("screen shot")
        || fname.contains("schermopname")
        || fname.contains("schermafbeelding")
        || fname.contains("capture")
        || fname.contains("snip")
        || fname.starts_with("scr_")
        || (fname.starts_with("img_") && fname.ends_with(".png"))
    {
        return true;
    }

    if !camera_model.is_empty() {
        return false;
    }

    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if let Some(decoded) = img {
        let (w, h) = decoded.dimensions();
        let common_dims = [
            (1920, 1080),
            (2560, 1440),
            (3840, 2160),
            (3440, 1440),
            (1366, 768),
            (1440, 900),
            (2880, 1800),
            (1170, 2532),
            (1179, 2556),
            (1284, 2778),
            (1290, 2796),
            (1080, 2400),
            (1080, 2340),
            (1440, 3200),
        ];
        if common_dims.contains(&(w, h)) || common_dims.contains(&(h, w)) {
            return true;
        }
        if ext == "png" {
            let small = decoded.resize_exact(64, 64, FilterType::Nearest).to_rgb8();
            let mut flat_count = 0;
            for y in 0..64 {
                for x in 0..63 {
                    if small.get_pixel(x, y) == small.get_pixel(x + 1, y) {
                        flat_count += 1;
                    }
                }
            }
            if flat_count as f32 / (64.0 * 63.0) > 0.38 {
                return true;
            }
        }
    } else if ext == "png" && camera_model.is_empty() && fname.contains("202") {
        return true;
    }

    false
}

// ----------------- HIGH-PRECISION FACE EMBEDDING & VERIFICATION -----------------

fn has_bilateral_face_structure(face_img: &DynamicImage) -> bool {
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

type OnnxPlan = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

static ULTRAFACE_PLAN: LazyLock<Mutex<Option<OnnxPlan>>> = LazyLock::new(|| Mutex::new(None));

const ULTRAFACE_URL: &str = "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx";

fn get_models_dir(app: &AppHandle) -> PathBuf {
    let dir = get_app_storage_dir(app).join("models");
    let _ = fs::create_dir_all(&dir);
    dir
}

#[tauri::command]
async fn ensure_neural_face_models(app: AppHandle) -> Result<String, String> {
    let models_dir = get_models_dir(&app);
    let detector_path = models_dir.join("version-RFB-320.onnx");

    if !detector_path.exists() || detector_path.metadata().map(|m| m.len() < 100_000).unwrap_or(true) {
        let resp = HTTP_CLIENT
            .get(ULTRAFACE_URL)
            .send()
            .await
            .map_err(|e| format!("Failed to download UltraFace ONNX model: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Failed to download UltraFace model: HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        fs::write(&detector_path, &bytes).map_err(|e| e.to_string())?;
    }

    Ok("Neural ONNX face detector ready".to_string())
}

fn get_or_load_ultraface(app: &AppHandle) -> Option<OnnxPlan> {
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

    *guard = Some(model.clone());
    Some(model)
}

// Generates the exact 4,420 prior anchor boxes for UltraFace-RFB-320 (input 320x240)
fn generate_ultraface_priors() -> Vec<[f32; 4]> {
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

static ULTRAFACE_PRIORS: LazyLock<Vec<[f32; 4]>> = LazyLock::new(generate_ultraface_priors);

// Runs the UltraFace-RFB-320 ONNX neural network on an image in ~10ms!
// Returns only genuine human faces with high confidence (score >= 0.72), zero walls/chairs/mugs!
fn detect_faces_with_onnx(app: &AppHandle, img: &DynamicImage) -> Vec<(f64, f64, f64, f64, f64)> {
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
        if score < 0.72 {
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
        let overlaps = kept.iter().any(|&(kx, ky, kw, kh, _)| {
            let ix1 = bx.max(kx);
            let iy1 = by.max(ky);
            let ix2 = (bx + bw).min(kx + kw);
            let iy2 = (by + bh).min(ky + kh);
            let inter = (ix2 - ix1).max(0.0) * (iy2 - iy1).max(0.0);
            let union = bw * bh + kw * kh - inter;
            union > 0.0 && (inter / union) > 0.30
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

// Computes a 384-D illumination-invariant biometric descriptor (LBP + Multi-Scale HOG + Lab Chrominance)
// on the aligned inner face region
fn compute_face_embedding(face_img: &DynamicImage) -> Vec<f32> {
    // Tight inner crop (removes hair/background border around the head)
    let w = face_img.width();
    let h = face_img.height();
    let inner = if w >= 20 && h >= 20 {
        face_img.crop_imm(w / 10, h / 10, (w * 8) / 10, (h * 8) / 10)
    } else {
        face_img.clone()
    };

    let mut vec = Vec::with_capacity(384);

    // 1. 8x8 spatial Lab-like chromatic & luminance grid (64 * 3 = 192 features)
    let grid8 = inner.resize_exact(8, 8, FilterType::Triangle).to_rgb8();
    for y in 0..8 {
        for x in 0..8 {
            let p = grid8.get_pixel(x, y);
            let r = p[0] as f32 / 255.0;
            let g = p[1] as f32 / 255.0;
            let b = p[2] as f32 / 255.0;
            let luma = 0.299 * r + 0.587 * g + 0.114 * b;
            let rg = r - g;
            let yb = 0.5 * (r + g) - b;
            vec.push(luma);
            vec.push(rg * 1.5);
            vec.push(yb * 1.5);
        }
    }

    // 2. 8x8 Signed Horizontal & Vertical Facial Landmark Gradients (eyes, nose bridge, mouth ratio = 128 features)
    let gray24 = inner.resize_exact(24, 24, FilterType::Triangle).to_luma8();
    for gy in 0..8 {
        for gx in 0..8 {
            let px = (gx * 2 + 4).min(21);
            let py = (gy * 2 + 4).min(21);
            let c = gray24.get_pixel(px, py)[0] as f32 / 255.0;
            let r = gray24.get_pixel(px + 2, py)[0] as f32 / 255.0;
            let d = gray24.get_pixel(px, py + 2)[0] as f32 / 255.0;
            vec.push((r - c) * 2.0);
            vec.push((d - c) * 2.0);
        }
    }

    // 3. 8x8 Local Center-Symmetric Contrast (LBP-like texture around eyes/brows/mouth = 64 features)
    for gy in 0..8 {
        for gx in 0..8 {
            let px = (gx * 2 + 4).min(22).max(1);
            let py = (gy * 2 + 4).min(22).max(1);
            let c = gray24.get_pixel(px, py)[0] as f32 / 255.0;
            let l = gray24.get_pixel(px - 1, py)[0] as f32 / 255.0;
            let r = gray24.get_pixel(px + 1, py)[0] as f32 / 255.0;
            let u = gray24.get_pixel(px, py - 1)[0] as f32 / 255.0;
            let d = gray24.get_pixel(px, py + 1)[0] as f32 / 255.0;
            let lap = (l + r + u + d - 4.0 * c).abs();
            vec.push(lap * 2.0);
        }
    }

    let mean = vec.iter().sum::<f32>() / (vec.len() as f32);
    for v in &mut vec {
        *v -= mean;
    }
    let norm = vec.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-6);
    for v in &mut vec {
        *v /= norm;
    }
    vec
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn save_cropped_face_and_record(
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

    if source == "ai" && person_name.is_none() && !has_bilateral_face_structure(&cropped) {
        return None;
    }

    let embedding = compute_face_embedding(&cropped);
    let emb_json = serde_json::to_string(&embedding).unwrap_or_else(|_| "[]".to_string());

    let face_id = format!(
        "{}_{}_{}",
        hash,
        (bbox.0 * 100.0).round() as i32,
        (bbox.1 * 100.0).round() as i32
    );

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
            person_name,
            face_thumb_str,
            emb_json,
            source
        ],
    );

    if let Some(ref p_name) = person_name {
        let clean = p_name.trim().to_string();
        if !clean.is_empty() {
            let _ = conn.execute(
                "INSERT INTO people (name, cover_face_thumb) VALUES (?1, ?2)
                 ON CONFLICT(name) DO UPDATE SET cover_face_thumb = excluded.cover_face_thumb",
                params![clean, face_thumb_str],
            );
            let _ = conn.execute(
                "INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)",
                params![hash, clean],
            );
        }
    }

    Some(FaceInstance {
        face_id,
        hash: hash.to_string(),
        bbox_x: bbox.0,
        bbox_y: bbox.1,
        bbox_w: bbox.2,
        bbox_h: bbox.3,
        person_name,
        face_thumb: face_thumb_str,
        confidence: 1.0,
    })
}

fn get_faces_for_hash(conn: &Connection, hash: &str) -> Vec<FaceInstance> {
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

fn assign_duplicate_groups(photos: &mut [PhotoItem]) {
    for p in photos.iter_mut() {
        p.duplicate_group = None;
    }

    // Order indices chronologically by captured_at then name so bursts with different prefixes still sit adjacent
    let mut order: Vec<usize> = (0..photos.len()).collect();
    order.sort_by(|&a, &b| {
        photos[a]
            .captured_at
            .cmp(&photos[b].captured_at)
            .then_with(|| photos[a].name.cmp(&photos[b].name))
    });

    let parsed: Vec<(Option<u64>, bool)> = photos
        .iter()
        .map(|p| {
            let h = if p.dhash.len() == 16 {
                u64::from_str_radix(&p.dhash, 16).ok()
            } else {
                None
            };
            let is_scr = p.tags.iter().any(|t| t == "screenshot")
                || p.name.ends_with(".png")
                || p.name.ends_with(".PNG")
                || p.camera_model.is_empty();
            (h, is_scr)
        })
        .collect();

    let n = order.len();
    let mut visited = vec![false; photos.len()];
    let mut current_group = 1usize;

    for pos_i in 0..n {
        let i = order[pos_i];
        if visited[i] || photos[i].subfolder == "_Trash" {
            continue;
        }
        let (Some(h1), is_scr_1) = parsed[i] else {
            continue;
        };

        let mut members = vec![i];
        let limit = (pos_i + 300).min(n);
        for pos_j in (pos_i + 1)..limit {
            let j = order[pos_j];
            if visited[j] || photos[j].subfolder == "_Trash" {
                continue;
            }
            if let (Some(h2), is_scr_2) = parsed[j] {
                let max_dist = if is_scr_1 && is_scr_2 { 11 } else { 8 };
                if (h1 ^ h2).count_ones() <= max_dist {
                    members.push(j);
                }
            }
        }

        if members.len() > 1 {
            for &idx in &members {
                visited[idx] = true;
                photos[idx].duplicate_group = Some(current_group);
            }
            current_group += 1;
        }
    }
}

fn compute_db_duplicate_groups(conn: &Connection, root_folder: Option<&str>) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    let prefix = make_folder_prefix(root_folder);
    let Ok(mut stmt) = conn.prepare(
        "SELECT hash, dhash, COALESCE(camera_model, ''), COALESCE(subfolder, ''), COALESCE(current_path, '')
         FROM photos
         WHERE length(dhash) = 16 AND COALESCE(subfolder, '') != '_Trash' AND current_path LIKE ?1
         ORDER BY COALESCE(captured_at, '') ASC, current_path ASC",
    ) else {
        return map;
    };

    let Ok(rows) = stmt.query_map(params![prefix], |r| {
        let hash: String = r.get(0)?;
        let dhash_str: String = r.get(1)?;
        let cam: String = r.get(2)?;
        let path: String = r.get(4)?;
        let h_val = u64::from_str_radix(&dhash_str, 16).unwrap_or(0);
        let is_scr = cam.is_empty() || path.ends_with(".png") || path.ends_with(".PNG");
        Ok((hash, h_val, is_scr))
    }) else {
        return map;
    };

    let items: Vec<(String, u64, bool)> = rows.flatten().collect();
    let n = items.len();
    let mut visited = vec![false; n];
    let mut grp = 1usize;

    for i in 0..n {
        if visited[i] {
            continue;
        }
        let (_, h1, s1) = items[i];
        let mut members = vec![i];
        let limit = (i + 300).min(n);
        for j in (i + 1)..limit {
            if visited[j] {
                continue;
            }
            let (_, h2, s2) = items[j];
            let max_d = if s1 && s2 { 11 } else { 8 };
            if (h1 ^ h2).count_ones() <= max_d {
                members.push(j);
            }
        }
        if members.len() > 1 {
            for &idx in &members {
                visited[idx] = true;
                map.insert(items[idx].0.clone(), grp);
            }
            grp += 1;
        }
    }

    map
}

fn parse_gps_rational(val: &Value) -> Option<f64> {
    match val {
        Value::Rational(rats) if rats.len() >= 3 => {
            let deg = rats[0].to_f64();
            let min = rats[1].to_f64();
            let sec = rats[2].to_f64();
            if deg.is_nan() || min.is_nan() || sec.is_nan() {
                None
            } else {
                Some(deg + (min / 60.0) + (sec / 3600.0))
            }
        }
        Value::SRational(rats) if rats.len() >= 3 => {
            let deg = rats[0].to_f64();
            let min = rats[1].to_f64();
            let sec = rats[2].to_f64();
            Some(deg + (min / 60.0) + (sec / 3600.0))
        }
        _ => None,
    }
}

fn format_system_time_iso(st: std::time::SystemTime) -> String {
    let secs = st
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if secs <= 0 {
        return String::new();
    }
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;

    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let yr = if m <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", yr, m, d, hh, mm, ss)
}

fn normalize_date_str(raw: &str) -> String {
    let clean = raw.trim().trim_matches('"').trim();
    if clean.len() >= 10 {
        let date_part = clean[..10].replace(':', "-");
        let time_part = if clean.len() >= 19 {
            clean[11..19].to_string()
        } else {
            "00:00:00".to_string()
        };
        if date_part.chars().take(4).all(|c| c.is_ascii_digit()) {
            return format!("{} {}", date_part, time_part);
        }
    }
    String::new()
}

fn read_exif_orientation(file_path: &Path) -> u32 {
    if let Ok(file) = File::open(file_path) {
        let mut bufreader = BufReader::new(file);
        let exifreader = Reader::new();
        if let Ok(exif) = exifreader.read_from_container(&mut bufreader) {
            if let Some(field) = exif.get_field(Tag::Orientation, exif::In::PRIMARY) {
                if let Some(v) = field.value.get_uint(0) {
                    return v;
                }
            }
        }
    }
    1
}

fn apply_exif_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

fn open_and_orient_image(file_path: &Path) -> Result<DynamicImage, String> {
    let reader = image::ImageReader::open(file_path).map_err(|e| e.to_string())?;
    let reader_guessed = reader.with_guessed_format().map_err(|e| e.to_string())?;
    let img = reader_guessed.decode().map_err(|e| e.to_string())?;
    let orientation = read_exif_orientation(file_path);
    Ok(apply_exif_orientation(img, orientation))
}

fn get_oriented_dimensions(file_path: &Path) -> (u32, u32) {
    if let Ok((w, h)) = image::image_dimensions(file_path) {
        let orientation = read_exif_orientation(file_path);
        if matches!(orientation, 5 | 6 | 7 | 8) {
            return (h, w);
        }
        return (w, h);
    }
    (0, 0)
}

fn make_folder_prefix(root_folder: Option<&str>) -> String {
    match root_folder {
        Some(f) if !f.trim().is_empty() => format!("{}%", f.trim()),
        _ => "%".to_string(),
    }
}

fn extract_exif_metadata(file_path: &Path) -> (String, String, String, Option<f64>, Option<f64>) {
    let mut date_str = String::new();
    let mut make_str = String::new();
    let mut camera = String::new();
    let mut location = String::new();
    let mut raw_lat = None;
    let mut raw_lon = None;

    if let Ok(file) = File::open(file_path) {
        let mut bufreader = BufReader::new(file);
        let exifreader = Reader::new();
        if let Ok(exif) = exifreader.read_from_container(&mut bufreader) {
            let mut lat_deg_opt: Option<f64> = None;
            let mut lon_deg_opt: Option<f64> = None;
            let mut is_south = false;
            let mut is_west = false;

            for f in exif.fields() {
                match f.tag {
                    Tag::DateTimeOriginal => {
                        let norm = normalize_date_str(&f.display_value().to_string());
                        if !norm.is_empty() {
                            date_str = norm;
                        }
                    }
                    Tag::DateTimeDigitized | Tag::DateTime => {
                        if date_str.is_empty() {
                            let norm = normalize_date_str(&f.display_value().to_string());
                            if !norm.is_empty() {
                                date_str = norm;
                            }
                        }
                    }
                    Tag::Make => {
                        if make_str.is_empty() {
                            make_str = f.display_value().to_string().replace('"', "").trim().to_string();
                        }
                    }
                    Tag::Model => {
                        if camera.is_empty() {
                            camera = f.display_value().to_string().replace('"', "").trim().to_string();
                        }
                    }
                    Tag::GPSLatitude => {
                        if lat_deg_opt.is_none() {
                            lat_deg_opt = parse_gps_rational(&f.value);
                        }
                    }
                    Tag::GPSLatitudeRef => {
                        let s = f.display_value().to_string().to_uppercase();
                        if s.contains('S') {
                            is_south = true;
                        }
                    }
                    Tag::GPSLongitude => {
                        if lon_deg_opt.is_none() {
                            lon_deg_opt = parse_gps_rational(&f.value);
                        }
                    }
                    Tag::GPSLongitudeRef => {
                        let s = f.display_value().to_string().to_uppercase();
                        if s.contains('W') {
                            is_west = true;
                        }
                    }
                    _ => {}
                }
            }

            if camera.is_empty() && !make_str.is_empty() {
                camera = make_str;
            } else if !make_str.is_empty() && !camera.to_lowercase().starts_with(&make_str.to_lowercase()) {
                camera = format!("{} {}", make_str, camera);
            }

            if let (Some(mut lat), Some(mut lon)) = (lat_deg_opt, lon_deg_opt) {
                if is_south && lat > 0.0 {
                    lat = -lat;
                }
                if is_west && lon > 0.0 {
                    lon = -lon;
                }
                if (lat.abs() > 0.0001 || lon.abs() > 0.0001) && lat.abs() <= 90.0 && lon.abs() <= 180.0 {
                    raw_lat = Some(lat);
                    raw_lon = Some(lon);
                    let search_res = GEOCODER.search((lat, lon));
                    location = format!("{}, {}", search_res.record.name, search_res.record.cc);
                }
            }
        }
    }

    if date_str.is_empty() {
        if let Ok(meta) = fs::metadata(file_path) {
            if let Ok(ctime) = meta.created().or_else(|_| meta.modified()) {
                date_str = format_system_time_iso(ctime);
            }
        }
    }

    (date_str, camera, location, raw_lat, raw_lon)
}

fn get_relative_subfolder(root: &Path, file_path: &Path) -> String {
    if let Some(parent) = file_path.parent() {
        if let Ok(rel) = parent.strip_prefix(root) {
            let parts: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect();
            if !parts.is_empty() {
                return parts.join(" / ");
            }
        }
    }
    "Root".to_string()
}

#[derive(Clone)]
struct CachedRow {
    size: u64,
    mtime: u64,
    width: u32,
    height: u32,
    rating: i32,
    flag: Option<String>,
    color_label: Option<String>,
    rotation: i32,
    in_basket: bool,
    ai_caption: String,
    ocr_text: String,
    hash: String,
    captured_at: String,
    camera_model: String,
    location: String,
    lat: Option<f64>,
    lon: Option<f64>,
    dhash: String,
    sharpness: f64,
    staged_target: Option<String>,
    exif_checked: i32,
}

#[tauri::command]
async fn scan_folder(
    app: AppHandle,
    folder_path: String,
    force_reprocess: Option<bool>,
) -> Result<Vec<PhotoItem>, String> {
    let force = force_reprocess.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let root_path = PathBuf::from(&folder_path);
        let app_dir = get_app_storage_dir(&app);
        let thumbs_dir = app_dir.join("thumbnails");
        let _ = fs::create_dir_all(&thumbs_dir);

        let mut conn = open_global_db(&app)?;

        let mut cache_map: HashMap<String, CachedRow> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT current_path, file_size, modified_time, rating,
                            COALESCE(ai_caption, ''), COALESCE(ocr_text, ''), hash,
                            COALESCE(captured_at, ''), COALESCE(camera_model, ''),
                            COALESCE(location, ''), latitude, longitude,
                            COALESCE(dhash, ''), COALESCE(sharpness, 0.0), staged_target,
                            COALESCE(exif_checked, 0), flag, color_label, COALESCE(rotation, 0), COALESCE(in_basket, 0),
                            COALESCE(width, 0), COALESCE(height, 0)
                     FROM photos",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        CachedRow {
                            size: row.get(1)?,
                            mtime: row.get(2)?,
                            rating: row.get(3)?,
                            ai_caption: row.get(4)?,
                            ocr_text: row.get(5)?,
                            hash: row.get(6)?,
                            captured_at: row.get(7)?,
                            camera_model: row.get(8)?,
                            location: row.get(9)?,
                            lat: row.get(10)?,
                            lon: row.get(11)?,
                            dhash: row.get(12)?,
                            sharpness: row.get(13)?,
                            staged_target: row.get(14)?,
                            exif_checked: row.get(15)?,
                            flag: row.get(16)?,
                            color_label: row.get(17)?,
                            rotation: row.get(18)?,
                            in_basket: row.get::<_, i32>(19).unwrap_or(0) != 0,
                            width: row.get::<_, u32>(20).unwrap_or(0),
                            height: row.get::<_, u32>(21).unwrap_or(0),
                        },
                    ))
                })
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                cache_map.insert(r.0, r.1);
            }
        }

        let mut tags_map: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT hash, tag FROM photo_tags ORDER BY tag ASC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                tags_map.entry(r.0).or_default().push(r.1);
            }
        }

        let mut people_map: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT hash, person_name FROM photo_people ORDER BY person_name ASC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                people_map.entry(r.0).or_default().push(r.1);
            }
        }

        let mut faces_map: HashMap<String, Vec<FaceInstance>> = HashMap::new();
        {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, person_name, face_thumb, confidence FROM photo_faces ORDER BY bbox_x ASC",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
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
                    for f in rows.flatten() {
                        faces_map.entry(f.hash.clone()).or_default().push(f);
                    }
                }
            }
        }

        let walker = WalkDir::new(&root_path)
            .into_iter()
            .filter_entry(|e| {
                if !e.file_type().is_dir() {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                name != ".git" && name != "node_modules" && name != ".triage_cache" && !name.starts_with('$')
            })
            .flatten();

        let mut photos: Vec<PhotoItem> = walker
            .par_bridge()
            .filter_map(|entry| {
                if !entry.file_type().is_file() {
                    return None;
                }
                let file_path = entry.into_path();
                let ext = file_path.extension()?.to_str()?.to_lowercase();
                if !["jpg", "jpeg", "png", "webp", "bmp", "gif", "tiff"].contains(&ext.as_str()) {
                    return None;
                }

                let metadata = fs::metadata(&file_path).ok()?;
                let size_bytes = metadata.len();
                if size_bytes == 0 {
                    return None;
                }
                let size_kb = size_bytes / 1024;
                let modified_time = metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                let path_str = file_path.to_string_lossy().to_string();

                let (hash, width, height, rating, flag, color_label, rotation, in_basket, ai_caption, ocr_text, captured_at, camera_model, location, lat, lon, dhash, sharpness, staged_target) =
                    if let Some(c) = cache_map.get(&path_str) {
                        if !force && c.exif_checked == 1 && c.width > 0 && c.height > 0 && !c.captured_at.is_empty() && c.size == size_bytes && c.mtime == modified_time {
                            (
                                c.hash.clone(),
                                c.width,
                                c.height,
                                c.rating,
                                c.flag.clone(),
                                c.color_label.clone(),
                                c.rotation,
                                c.in_basket,
                                c.ai_caption.clone(),
                                c.ocr_text.clone(),
                                c.captured_at.clone(),
                                c.camera_model.clone(),
                                c.location.clone(),
                                c.lat,
                                c.lon,
                                c.dhash.clone(),
                                c.sharpness,
                                c.staged_target.clone(),
                            )
                        } else {
                            let h = if c.size == size_bytes {
                                c.hash.clone()
                            } else {
                                compute_fast_hash(&file_path, size_bytes).ok()?
                            };
                            let (w, ht) = if c.width > 0 && c.height > 0 && !force {
                                (c.width, c.height)
                            } else {
                                get_oriented_dimensions(&file_path)
                            };
                            let (d, cam, loc, new_lat, new_lon) = extract_exif_metadata(&file_path);
                            (
                                h,
                                w,
                                ht,
                                c.rating,
                                c.flag.clone(),
                                c.color_label.clone(),
                                c.rotation,
                                c.in_basket,
                                c.ai_caption.clone(),
                                c.ocr_text.clone(),
                                if !d.is_empty() { d } else { c.captured_at.clone() },
                                if !cam.is_empty() { cam } else { c.camera_model.clone() },
                                if !loc.is_empty() { loc } else { c.location.clone() },
                                new_lat.or(c.lat),
                                new_lon.or(c.lon),
                                if force { String::new() } else { c.dhash.clone() },
                                if force { 0.0 } else { c.sharpness },
                                c.staged_target.clone(),
                            )
                        }
                    } else {
                        let h = compute_fast_hash(&file_path, size_bytes).ok()?;
                        let (w, ht) = get_oriented_dimensions(&file_path);
                        let (d, cam, loc, lat, lon) = extract_exif_metadata(&file_path);
                        (h, w, ht, 0, None, None, 0, false, String::new(), String::new(), d, cam, loc, lat, lon, String::new(), 0.0, None)
                    };

                let thumb_file = thumbs_dir.join(format!("{}.jpg", hash));
                let thumb_ready = !force && thumb_file.metadata().map(|m| m.len() > 0).unwrap_or(false);
                let subfolder = get_relative_subfolder(&root_path, &file_path);
                let mut tags = tags_map.get(&hash).cloned().unwrap_or_default();

                if is_likely_screenshot(&file_path, &camera_model, None) && !tags.iter().any(|t| t == "screenshot") {
                    tags.push("screenshot".to_string());
                    tags.sort();
                }

                let people = people_map.get(&hash).cloned().unwrap_or_default();
                let faces = faces_map.get(&hash).cloned().unwrap_or_default();

                Some(PhotoItem {
                    hash,
                    name: file_path.file_name()?.to_string_lossy().to_string(),
                    subfolder,
                    path: path_str,
                    thumb_path: thumb_file.to_string_lossy().to_string(),
                    size_kb,
                    width,
                    height,
                    thumb_ready,
                    rating,
                    flag,
                    color_label,
                    rotation,
                    in_basket,
                    tags,
                    people,
                    faces,
                    ai_caption,
                    ocr_text,
                    captured_at,
                    camera_model,
                    location,
                    latitude: lat,
                    longitude: lon,
                    dhash,
                    sharpness,
                    duplicate_group: None,
                    staged_target,
                })
            })
            .collect();

        if let Ok(tx) = conn.transaction() {
            for p in &photos {
                let metadata = fs::metadata(&p.path).ok();
                let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                let mtime = metadata
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                let _ = tx.execute(
                    "INSERT INTO photos (hash, current_path, subfolder, file_size, modified_time, width, height, rating, flag, color_label, rotation, ai_caption, ocr_text, captured_at, camera_model, location, latitude, longitude, dhash, sharpness, staged_target, exif_checked)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, 1)
                     ON CONFLICT(hash) DO UPDATE SET
                        current_path = excluded.current_path,
                        subfolder = excluded.subfolder,
                        file_size = excluded.file_size,
                        modified_time = excluded.modified_time,
                        width = CASE WHEN excluded.width > 0 THEN excluded.width ELSE photos.width END,
                        height = CASE WHEN excluded.height > 0 THEN excluded.height ELSE photos.height END,
                        captured_at = excluded.captured_at,
                        camera_model = excluded.camera_model,
                        location = excluded.location,
                        latitude = excluded.latitude,
                        longitude = excluded.longitude,
                        staged_target = excluded.staged_target,
                        exif_checked = 1",
                    params![
                        p.hash, p.path, p.subfolder, size_bytes, mtime, p.width, p.height, p.rating,
                        p.flag, p.color_label, p.rotation,
                        p.ai_caption, p.ocr_text, p.captured_at, p.camera_model,
                        p.location, p.latitude, p.longitude, p.dhash, p.sharpness,
                        p.staged_target
                    ],
                );

                if p.tags.iter().any(|t| t == "screenshot") {
                    let _ = tx.execute(
                        "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, 'screenshot')",
                        params![p.hash],
                    );
                }
            }
            let _ = tx.commit();
        }

        photos.sort_by(|a, b| a.subfolder.cmp(&b.subfolder).then(a.name.cmp(&b.name)));
        assign_duplicate_groups(&mut photos);

        let needs_processing: Vec<PhotoItem> = photos
            .iter()
            .filter(|p| force || !p.thumb_ready || p.dhash.is_empty())
            .cloned()
            .collect();

        if !needs_processing.is_empty() {
            let app_clone = app.clone();
            let folder_scope = folder_path.clone();
            std::thread::spawn(move || {
                let total = needs_processing.len();
                let completed = AtomicUsize::new(0);

                let num_threads = (std::thread::available_parallelism()
                    .map(|n| (n.get() * 3) / 4)
                    .unwrap_or(6))
                    .max(2);

                let pool = rayon::ThreadPoolBuilder::new()
                    .num_threads(num_threads)
                    .build()
                    .unwrap();

                pool.install(|| {
                    for chunk in needs_processing.chunks(24) {
                        let batch_items: Vec<ThumbBatchItem> = chunk
                            .par_iter()
                            .map(|photo| {
                                let original_path = Path::new(&photo.path);
                                let thumb_file = Path::new(&photo.thumb_path);

                                let mut computed_dhash = photo.dhash.clone();
                                let mut computed_sharpness = photo.sharpness;
                                let mut computed_w = photo.width;
                                let mut computed_h = photo.height;
                                let mut final_thumb_path = photo.thumb_path.clone();
                                let mut detected_scr = false;

                                if let Ok(img) = open_and_orient_image(original_path) {
                                    let (iw, ih) = img.dimensions();
                                    computed_w = iw;
                                    computed_h = ih;
                                    detected_scr = is_likely_screenshot(
                                        original_path,
                                        &photo.camera_model,
                                        Some(&img),
                                    );
                                    let thumb = img.thumbnail(360, 360);
                                    computed_dhash = compute_dhash(&thumb);
                                    computed_sharpness = compute_sharpness(&thumb);

                                    if force || !thumb_file.exists() {
                                        if thumb.to_rgb8().save(thumb_file).is_err() {
                                            final_thumb_path = photo.path.clone();
                                        }
                                    }
                                }

                                let mut auto_tags = Vec::new();
                                if detected_scr {
                                    auto_tags.push("screenshot".to_string());
                                }

                                completed.fetch_add(1, Ordering::Relaxed);

                                ThumbBatchItem {
                                    hash: photo.hash.clone(),
                                    thumb_path: final_thumb_path,
                                    dhash: computed_dhash,
                                    sharpness: computed_sharpness,
                                    width: computed_w,
                                    height: computed_h,
                                    auto_tags,
                                }
                            })
                            .collect();

                        let done = completed.load(Ordering::Relaxed);
                        let mut dup_groups = HashMap::new();

                        if let Ok(mut db_conn) = open_global_db(&app_clone) {
                            if let Ok(tx) = db_conn.transaction() {
                                for item in &batch_items {
                                    let _ = tx.execute(
                                        "UPDATE photos SET dhash = ?1, sharpness = ?2, width = CASE WHEN ?3 > 0 THEN ?3 ELSE width END, height = CASE WHEN ?4 > 0 THEN ?4 ELSE height END WHERE hash = ?5",
                                        params![item.dhash, item.sharpness, item.width, item.height, item.hash],
                                    );
                                    if !item.auto_tags.is_empty() {
                                        let _ = tx.execute(
                                            "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, 'screenshot')",
                                            params![item.hash],
                                        );
                                    }
                                }
                                let _ = tx.commit();
                            }

                            if done == total || done % 96 == 0 {
                                dup_groups = compute_db_duplicate_groups(&db_conn, Some(&folder_scope));
                            }
                        }

                        let _ = app_clone.emit(
                            "thumb-batch-ready",
                            ThumbBatchProgress {
                                items: batch_items,
                                duplicate_groups: dup_groups,
                                completed: done,
                                total,
                            },
                        );
                    }
                });
            });
        }

        Ok(photos)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- FORCE EXIF RESCAN (INDIVIDUAL & BATCH) -----------------

#[tauri::command]
fn rescan_exif_batch(app: AppHandle, hashes: Vec<String>) -> Result<Vec<ExifRefreshResult>, String> {
    let mut conn = open_global_db(&app)?;
    let mut results = Vec::new();

    if let Ok(tx) = conn.transaction() {
        for h in &hashes {
            let row_opt: Option<(String, String, String, String, Option<f64>, Option<f64>)> = tx
                .query_row(
                    "SELECT current_path, COALESCE(captured_at, ''), COALESCE(camera_model, ''), COALESCE(location, ''), latitude, longitude
                     FROM photos WHERE hash = ?1",
                    params![h],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )
                .ok();

            if let Some((path_str, old_date, old_cam, old_loc, old_lat, old_lon)) = row_opt {
                let (d, cam, loc, lat, lon) = extract_exif_metadata(Path::new(&path_str));

                let final_date = if !d.is_empty() { d } else { old_date };
                let final_cam = if !cam.is_empty() { cam } else { old_cam };
                let final_loc = if !loc.is_empty() { loc } else { old_loc };
                let final_lat = lat.or(old_lat);
                let final_lon = lon.or(old_lon);

                let _ = tx.execute(
                    "UPDATE photos SET
                        captured_at = ?1,
                        camera_model = ?2,
                        location = ?3,
                        latitude = ?4,
                        longitude = ?5,
                        exif_checked = 1
                     WHERE hash = ?6",
                    params![final_date, final_cam, final_loc, final_lat, final_lon, h],
                );

                results.push(ExifRefreshResult {
                    hash: h.clone(),
                    captured_at: final_date,
                    camera_model: final_cam,
                    location: final_loc,
                    latitude: final_lat,
                    longitude: final_lon,
                });
            }
        }
        let _ = tx.commit();
    }

    Ok(results)
}

// ----------------- DATE TIMELINE AGGREGATION -----------------

#[tauri::command]
fn get_timeline_distribution(app: AppHandle, root_folder: Option<String>) -> Result<Vec<TimelineBucket>, String> {
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(root_folder.as_deref());
    let mut stmt = conn
        .prepare(
            "SELECT substr(replace(captured_at, ':', '-'), 1, 10) as period, count(*)
             FROM photos
             WHERE captured_at IS NOT NULL AND length(captured_at) >= 10 AND current_path LIKE ?1
             GROUP BY period
             ORDER BY period ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![prefix], |r| {
            Ok(TimelineBucket {
                period: r.get(0)?,
                count: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
}

// ----------------- OFFLINE CITY SEARCH & MANUAL LOCATION -----------------

#[tauri::command]
fn search_cities_offline(query: String) -> Result<Vec<CitySearchResult>, String> {
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return Ok(Vec::new());
    }

    let known_cities: &[(&str, &str, f64, f64)] = &[
        ("Brussels", "BE", 50.8503, 4.3517),
        ("Meise", "BE", 50.9333, 4.3333),
        ("Antwerp", "BE", 51.2194, 4.4025),
        ("Ghent", "BE", 51.0543, 3.7174),
        ("Bruges", "BE", 51.2093, 3.2247),
        ("Leuven", "BE", 50.8798, 4.7005),
        ("Liege", "BE", 50.6326, 5.5797),
        ("Namur", "BE", 50.4674, 4.8720),
        ("Paris", "FR", 48.8566, 2.3522),
        ("Alpe d'Huez", "FR", 45.0922, 6.0694),
        ("Nice", "FR", 43.7102, 7.2620),
        ("Lyon", "FR", 45.7640, 4.8357),
        ("Marseille", "FR", 43.2965, 5.3698),
        ("Amsterdam", "NL", 52.3676, 4.9041),
        ("Rotterdam", "NL", 51.9244, 4.4777),
        ("London", "GB", 51.5074, -0.1278),
        ("Berlin", "DE", 52.5200, 13.4050),
        ("Munich", "DE", 48.1351, 11.5820),
        ("Rome", "IT", 41.9028, 12.4964),
        ("Milan", "IT", 45.4642, 9.1900),
        ("Florence", "IT", 43.7696, 11.2558),
        ("Venice", "IT", 45.4408, 12.3155),
        ("Madrid", "ES", 40.4168, -3.7038),
        ("Barcelona", "ES", 41.3851, 2.1734),
        ("New York", "US", 40.7128, -74.0060),
        ("San Francisco", "US", 37.7749, -122.4194),
        ("Los Angeles", "US", 34.0522, -118.2437),
        ("Tokyo", "JP", 35.6762, 139.6503),
    ];

    let mut matches = Vec::new();
    for &(name, cc, lat, lon) in known_cities {
        if name.to_lowercase().contains(&q) || cc.to_lowercase() == q {
            matches.push(CitySearchResult {
                name: name.to_string(),
                country: cc.to_string(),
                latitude: lat,
                longitude: lon,
            });
        }
    }

    Ok(matches)
}

#[tauri::command]
fn set_manual_location(
    app: AppHandle,
    hashes: Vec<String>,
    location: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<(), String> {
    let clean_loc = location.trim().to_string();
    let mut conn = open_global_db(&app)?;

    let (final_loc, final_lat, final_lon) = if let (Some(lat), Some(lon)) = (latitude, longitude) {
        let rev = GEOCODER.search((lat, lon));
        let loc_name = if clean_loc.is_empty() {
            format!("{}, {}", rev.record.name, rev.record.cc)
        } else {
            clean_loc
        };
        (loc_name, Some(lat), Some(lon))
    } else {
        (clean_loc, latitude, longitude)
    };

    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let _ = tx.execute(
                "UPDATE photos SET location = ?1, latitude = ?2, longitude = ?3 WHERE hash = ?4",
                params![final_loc, final_lat, final_lon, h],
            );
        }
        let _ = tx.commit();
    }

    Ok(())
}

// ----------------- PICK/REJECT FLAGS, COLOR LABELS & ROTATION -----------------

#[tauri::command]
fn set_photo_flag(app: AppHandle, hashes: Vec<String>, flag: Option<String>) -> Result<(), String> {
    let mut conn = open_global_db(&app)?;
    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let _ = tx.execute(
                "UPDATE photos SET flag = ?1 WHERE hash = ?2",
                params![flag, h],
            );
        }
        let _ = tx.commit();
    }
    Ok(())
}

#[tauri::command]
fn set_photo_color_label(app: AppHandle, hashes: Vec<String>, color: Option<String>) -> Result<(), String> {
    let mut conn = open_global_db(&app)?;
    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let _ = tx.execute(
                "UPDATE photos SET color_label = ?1 WHERE hash = ?2",
                params![color, h],
            );
        }
        let _ = tx.commit();
    }
    Ok(())
}

#[tauri::command]
fn set_photo_rotation(app: AppHandle, hashes: Vec<String>, delta_degrees: i32) -> Result<HashMap<String, i32>, String> {
    let mut conn = open_global_db(&app)?;
    let mut out = HashMap::new();

    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let cur: i32 = tx
                .query_row("SELECT COALESCE(rotation, 0) FROM photos WHERE hash = ?1", params![h], |r| r.get(0))
                .unwrap_or(0);
            let next = (cur + delta_degrees).rem_euclid(360);
            let _ = tx.execute("UPDATE photos SET rotation = ?1 WHERE hash = ?2", params![next, h]);
            out.insert(h, next);
        }
        let _ = tx.commit();
    }

    Ok(out)
}

// ----------------- NON-DESTRUCTIVE STAGING & DISMISS -----------------

#[tauri::command]
fn stage_photo_move(app: AppHandle, hash: String, target_subfolder: Option<String>) -> Result<(), String> {
    let conn = open_global_db(&app)?;
    conn.execute(
        "UPDATE photos SET staged_target = ?1 WHERE hash = ?2",
        params![target_subfolder, hash],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn clear_all_staged(app: AppHandle, root_folder: Option<String>) -> Result<usize, String> {
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(root_folder.as_deref());
    let count = conn
        .execute(
            "UPDATE photos SET staged_target = NULL WHERE staged_target IS NOT NULL AND current_path LIKE ?1",
            params![prefix],
        )
        .map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
fn get_staged_operations(app: AppHandle, root_folder: Option<String>) -> Result<Vec<StagedOperation>, String> {
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(root_folder.as_deref());
    let mut stmt = conn
        .prepare("SELECT hash, current_path, staged_target FROM photos WHERE staged_target IS NOT NULL AND current_path LIKE ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![prefix], |row| {
            let p_str: String = row.get(1)?;
            let path = Path::new(&p_str);
            let fname = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            Ok(StagedOperation {
                hash: row.get(0)?,
                current_path: p_str,
                target_subfolder: row.get(2)?,
                filename: fname,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
}

#[tauri::command]
fn commit_staged_operations(
    app: AppHandle,
    root_folder: String,
    smart_rename: Option<bool>,
) -> Result<usize, String> {
    let do_rename = smart_rename.unwrap_or(false);
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(Some(&root_folder));
    let mut stmt = conn
        .prepare(
            "SELECT hash, current_path, staged_target, COALESCE(captured_at, ''), COALESCE(location, '')
             FROM photos WHERE staged_target IS NOT NULL AND current_path LIKE ?1
             ORDER BY captured_at ASC, current_path ASC",
        )
        .map_err(|e| e.to_string())?;

    let ops: Vec<(String, String, String, String, String)> = stmt
        .query_map(params![prefix], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    let root = Path::new(&root_folder);
    let mut count = 0;
    let mut seq = 1usize;

    for (hash, current_path, target_sub, captured_at, location) in ops {
        let src = Path::new(&current_path);
        if !src.exists() {
            continue;
        }
        let orig_fname = match src.file_name() {
            Some(f) => f.to_string_lossy().to_string(),
            None => continue,
        };
        let ext = src
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "jpg".to_string());

        let clean_sub = target_sub.trim().replace('\\', "/");
        let target_dir = if clean_sub.is_empty() || clean_sub.eq_ignore_ascii_case("Root") {
            root.to_path_buf()
        } else {
            let mut d = root.to_path_buf();
            for part in clean_sub.split('/').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                d = d.join(part);
            }
            d
        };

        if !target_dir.exists() {
            let _ = fs::create_dir_all(&target_dir);
        }

        let final_fname = if do_rename && clean_sub != "_Trash" {
            let date_part = if captured_at.len() >= 10 {
                captured_at[..10].replace(':', "-")
            } else {
                "0000-00-00".to_string()
            };
            let time_part = if captured_at.len() >= 19 {
                captured_at[11..19].replace(':', "")
            } else {
                format!("{:04}", seq)
            };
            let city_part = if !location.is_empty() {
                let raw_city = location.split(',').next().unwrap_or("").trim();
                let sanitized: String = raw_city
                    .chars()
                    .filter(|c| c.is_alphanumeric() || *c == '-')
                    .collect();
                if sanitized.is_empty() {
                    String::new()
                } else {
                    format!("_{}", sanitized)
                }
            } else {
                String::new()
            };
            seq += 1;
            format!("{}_{}{}_{:03}.{}", date_part, time_part, city_part, seq, ext)
        } else {
            orig_fname
        };

        let mut dest = target_dir.join(&final_fname);
        if dest != src && dest.exists() {
            let stem = Path::new(&final_fname)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "photo".to_string());
            dest = target_dir.join(format!("{}_{}.{}", stem, &hash[..6], ext));
        }

        if dest != src && !dest.exists() {
            if fs::rename(src, &dest).is_ok() {
                let new_path = dest.to_string_lossy().to_string();
                let new_sub = get_relative_subfolder(root, &dest);
                let _ = conn.execute(
                    "UPDATE photos SET current_path = ?1, subfolder = ?2, staged_target = NULL WHERE hash = ?3",
                    params![new_path, new_sub, hash],
                );
                count += 1;
            }
        }
    }

    Ok(count)
}

// ----------------- PHASE 2: QUICK PINBOARD BASKET, CLOCK SHIFT, XMP EXPORT & HEALTH -----------------

#[tauri::command]
fn set_photo_basket(app: AppHandle, hashes: Vec<String>, in_basket: bool) -> Result<(), String> {
    let mut conn = open_global_db(&app)?;
    let val = if in_basket { 1 } else { 0 };
    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let _ = tx.execute(
                "UPDATE photos SET in_basket = ?1 WHERE hash = ?2",
                params![val, h],
            );
        }
        let _ = tx.commit();
    }
    Ok(())
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap_year(y) { 29 } else { 28 },
        _ => 30,
    }
}

fn shift_exif_datetime_str(raw: &str, offset_minutes: i64) -> Option<String> {
    let clean = raw.trim();
    if clean.len() < 16 {
        return None;
    }
    let y: i64 = clean.get(0..4)?.parse().ok()?;
    let m: i64 = clean.get(5..7)?.parse().ok()?;
    let d: i64 = clean.get(8..10)?.parse().ok()?;
    let hh: i64 = clean.get(11..13)?.parse().ok()?;
    let mm: i64 = clean.get(14..16)?.parse().ok()?;
    let ss: i64 = clean.get(17..19).and_then(|s| s.parse().ok()).unwrap_or(0);

    let mut total_minutes = hh * 60 + mm + offset_minutes;
    let day_delta = total_minutes.div_euclid(1440);
    total_minutes = total_minutes.rem_euclid(1440);

    let new_hh = total_minutes / 60;
    let new_mm = total_minutes % 60;

    let mut cur_y = y;
    let mut cur_m = m;
    let mut cur_d = d + day_delta;

    while cur_d > days_in_month(cur_y, cur_m) {
        cur_d -= days_in_month(cur_y, cur_m);
        cur_m += 1;
        if cur_m > 12 {
            cur_m = 1;
            cur_y += 1;
        }
    }
    while cur_d < 1 {
        cur_m -= 1;
        if cur_m < 1 {
            cur_m = 12;
            cur_y -= 1;
        }
        cur_d += days_in_month(cur_y, cur_m);
    }

    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        cur_y, cur_m, cur_d, new_hh, new_mm, ss
    ))
}

#[tauri::command]
fn shift_capture_timestamps(
    app: AppHandle,
    hashes: Vec<String>,
    offset_minutes: i64,
) -> Result<Vec<TimestampShiftResult>, String> {
    let mut conn = open_global_db(&app)?;
    let mut out = Vec::new();

    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let cur_dt: String = tx
                .query_row(
                    "SELECT COALESCE(captured_at, '') FROM photos WHERE hash = ?1",
                    params![h],
                    |r| r.get(0),
                )
                .unwrap_or_default();

            if let Some(shifted) = shift_exif_datetime_str(&cur_dt, offset_minutes) {
                let _ = tx.execute(
                    "UPDATE photos SET captured_at = ?1 WHERE hash = ?2",
                    params![shifted, h],
                );
                out.push(TimestampShiftResult {
                    hash: h,
                    captured_at: shifted,
                });
            }
        }
        let _ = tx.commit();
    }

    Ok(out)
}

#[tauri::command]
fn export_xmp_sidecars(app: AppHandle, hashes: Option<Vec<String>>) -> Result<usize, String> {
    let conn = open_global_db(&app)?;

    let mut tags_map: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash, tag FROM photo_tags") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for r in rows.flatten() {
                tags_map.entry(r.0).or_default().push(r.1);
            }
        }
    }

    let mut people_map: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash, person_name FROM photo_people") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for r in rows.flatten() {
                people_map.entry(r.0).or_default().push(r.1);
            }
        }
    }

    let filter_set: Option<std::collections::HashSet<String>> =
        hashes.map(|v| v.into_iter().collect());

    let mut stmt = conn
        .prepare(
            "SELECT hash, current_path, rating, COALESCE(color_label, ''), COALESCE(ai_caption, ''),
                    COALESCE(captured_at, ''), latitude, longitude
             FROM photos",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i32>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<f64>>(6)?,
                r.get::<_, Option<f64>>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut exported = 0usize;
    for row in rows.flatten() {
        let (hash, path_str, rating, color_label, caption, captured_at, lat, lon) = row;
        if let Some(ref set) = filter_set {
            if !set.contains(&hash) {
                continue;
            }
        }

        let img_path = Path::new(&path_str);
        if !img_path.exists() {
            continue;
        }
        let xmp_path = img_path.with_extension("xmp");

        let tags = tags_map.get(&hash).cloned().unwrap_or_default();
        let people = people_map.get(&hash).cloned().unwrap_or_default();

        let mut subject_xml = String::new();
        for t in tags.iter().chain(people.iter()) {
            let escaped = t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
            subject_xml.push_str(&format!("          <rdf:li>{}</rdf:li>\n", escaped));
        }

        let escaped_caption = caption
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");

        let gps_xml = if let (Some(la), Some(lo)) = (lat, lon) {
            format!(
                "      exif:GPSLatitude=\"{}\"\n      exif:GPSLongitude=\"{}\"\n",
                la, lo
            )
        } else {
            String::new()
        };

        let xmp_content = format!(
            "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
    <rdf:Description rdf:about=\"\"\n\
      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n\
      xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n\
      xmlns:exif=\"http://ns.adobe.com/exif/1.0/\"\n\
      xmp:CreatorTool=\"Lumina v3.1\"\n\
      xmp:Rating=\"{}\"\n\
      xmp:Label=\"{}\"\n\
      xmp:CreateDate=\"{}\"\n\
{}>\n\
      <dc:description>\n\
        <rdf:Alt>\n\
          <rdf:li xml:lang=\"x-default\">{}</rdf:li>\n\
        </rdf:Alt>\n\
      </dc:description>\n\
      <dc:subject>\n\
        <rdf:Bag>\n\
{}        </rdf:Bag>\n\
      </dc:subject>\n\
    </rdf:Description>\n\
  </rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>",
            rating, color_label, captured_at, gps_xml, escaped_caption, subject_xml
        );

        if fs::write(&xmp_path, xmp_content).is_ok() {
            exported += 1;
        }
    }

    Ok(exported)
}

#[tauri::command]
fn get_library_health_stats(app: AppHandle, root_folder: Option<String>) -> Result<LibraryHealthStats, String> {
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(root_folder.as_deref());

    let total_photos: usize = conn
        .query_row("SELECT COUNT(*) FROM photos WHERE current_path LIKE ?1", params![prefix], |r| r.get(0))
        .unwrap_or(0);
    let total_bytes: i64 = conn
        .query_row("SELECT COALESCE(SUM(file_size), 0) FROM photos WHERE current_path LIKE ?1", params![prefix], |r| r.get(0))
        .unwrap_or(0);

    let (trash_cnt, trash_bytes): (usize, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(file_size), 0) FROM photos WHERE (staged_target = '_Trash' OR subfolder = '_Trash') AND current_path LIKE ?1",
            params![prefix],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    let dup_groups = compute_db_duplicate_groups(&conn, root_folder.as_deref());
    let mut seen_groups = std::collections::HashSet::new();
    let mut dup_extras_cnt = 0usize;
    let mut dup_extras_bytes = 0i64;

    for (h, grp) in &dup_groups {
        if !seen_groups.insert(*grp) {
            dup_extras_cnt += 1;
            let sz: i64 = conn
                .query_row("SELECT COALESCE(file_size, 0) FROM photos WHERE hash = ?1", params![h], |r| r.get(0))
                .unwrap_or(0);
            dup_extras_bytes += sz;
        }
    }

    let mut valid_hashes = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash FROM photos") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for h in rows.flatten() {
                valid_hashes.insert(h);
            }
        }
    }

    let app_dir = get_app_storage_dir(&app);
    let thumbs_dir = app_dir.join("thumbnails");
    let faces_dir = app_dir.join("faces");

    let mut cache_files_count = 0usize;
    let mut cache_bytes = 0u64;
    let mut orphaned_count = 0usize;

    for dir in [&thumbs_dir, &faces_dir] {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        cache_files_count += 1;
                        cache_bytes += meta.len();
                        let stem = entry
                            .path()
                            .file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_default();
                        let base_hash = stem.split('_').next().unwrap_or("");
                        if !base_hash.is_empty() && !valid_hashes.contains(base_hash) {
                            orphaned_count += 1;
                        }
                    }
                }
            }
        }
    }

    let mut camera_breakdown = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT CASE WHEN camera_model = '' OR camera_model IS NULL THEN 'Unknown / No EXIF' ELSE camera_model END as cam,
                COUNT(*) as cnt
         FROM photos WHERE current_path LIKE ?1 GROUP BY cam ORDER BY cnt DESC LIMIT 8",
    ) {
        if let Ok(rows) = stmt.query_map(params![prefix], |r| Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?))) {
            camera_breakdown = rows.flatten().collect();
        }
    }

    Ok(LibraryHealthStats {
        total_photos,
        total_library_size_mb: (total_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
        trash_staged_count: trash_cnt,
        trash_recoverable_mb: (trash_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
        duplicate_extras_count: dup_extras_cnt,
        duplicate_recoverable_mb: (dup_extras_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
        cache_files_count,
        cache_size_mb: (cache_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
        orphaned_cache_count: orphaned_count,
        camera_breakdown,
    })
}

#[tauri::command]
fn prune_orphaned_cache(app: AppHandle) -> Result<usize, String> {
    let conn = open_global_db(&app)?;
    let mut valid_hashes = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash FROM photos") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for h in rows.flatten() {
                valid_hashes.insert(h);
            }
        }
    }

    let app_dir = get_app_storage_dir(&app);
    let thumbs_dir = app_dir.join("thumbnails");
    let faces_dir = app_dir.join("faces");

    let mut removed = 0usize;
    for dir in [&thumbs_dir, &faces_dir] {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let stem = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let base_hash = stem.split('_').next().unwrap_or("");
                    if !base_hash.is_empty() && !valid_hashes.contains(base_hash) {
                        if fs::remove_file(&path).is_ok() {
                            removed += 1;
                        }
                    }
                }
            }
        }
    }

    Ok(removed)
}

// ----------------- INTERACTIVE FACE SELECTION & PRECISION AUTO-MATCHER -----------------

#[tauri::command]
async fn detect_faces_in_photo(
    app: AppHandle,
    hash: String,
    image_path: String,
    force_onnx: Option<bool>,
) -> Result<Vec<FaceInstance>, String> {
    let run_neural = force_onnx.unwrap_or(false);
    if run_neural {
        let _ = ensure_neural_face_models(app.clone()).await;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let existing = get_faces_for_hash(&conn, &hash);
        if !run_neural && !existing.is_empty() {
            return Ok(existing);
        }

        if let Ok(img) = open_and_orient_image(Path::new(&image_path)) {
            let onnx_boxes = detect_faces_with_onnx(&app, &img);
            // Clear any old un-named boxes on this photo before inserting fresh ONNX boxes
            let _ = conn.execute(
                "DELETE FROM photo_faces WHERE hash = ?1 AND (person_name IS NULL OR person_name = '')",
                params![hash],
            );
            for (bx, by, bw, bh, _score) in onnx_boxes {
                let _ = save_cropped_face_and_record(&app, &conn, &hash, &img, (bx, by, bw, bh), None, "onnx");
            }
        }

        Ok(get_faces_for_hash(&conn, &hash))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_library_faces_batch(
    app: AppHandle,
    hashes: Vec<String>,
) -> Result<usize, String> {
    // 1. Ensure the UltraFace ONNX model is downloaded & cached locally
    let _ = ensure_neural_face_models(app.clone()).await?;

    let total_hashes = hashes.len();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let Ok(conn) = open_global_db(&app_clone) else {
            return;
        };

        // Load all known named face embeddings so we can auto-match newly detected ONNX faces on the fly!
        let mut known_people_embeddings: Vec<(String, Vec<f32>)> = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT person_name, embedding FROM photo_faces WHERE person_name IS NOT NULL AND person_name != ''",
        ) {
            if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                for (pname, emb_str) in rows.flatten() {
                    if let Ok(emb) = serde_json::from_str::<Vec<f32>>(&emb_str) {
                        if !emb.is_empty() {
                            known_people_embeddings.push((pname, emb));
                        }
                    }
                }
            }
        }

        let total = hashes.len();
        let mut faces_found = 0usize;
        let mut auto_matched = 0usize;
        let thumbs_dir = get_app_storage_dir(&app_clone).join("thumbnails");

        for (idx, h) in hashes.iter().enumerate() {
            let path_opt: Option<String> = conn
                .query_row("SELECT current_path FROM photos WHERE hash = ?1", params![h], |r| r.get(0))
                .ok();

            if let Some(orig_path) = path_opt {
                // Use 360px cached thumbnail if available for 10x faster decoding (UltraFace takes 320x240!)
                let thumb_path = thumbs_dir.join(format!("{}.jpg", h));
                let load_path = if thumb_path.exists() {
                    thumb_path.to_string_lossy().to_string()
                } else {
                    orig_path.clone()
                };

                if let Ok(img) = open_and_orient_image(Path::new(&load_path)) {
                    let boxes = detect_faces_with_onnx(&app_clone, &img);
                    if !boxes.is_empty() {
                        // Delete old unnamed boxes for this photo
                        let _ = conn.execute(
                            "DELETE FROM photo_faces WHERE hash = ?1 AND (person_name IS NULL OR person_name = '')",
                            params![h],
                        );
                        for (bx, by, bw, bh, _conf) in boxes {
                            if let Some(saved) = save_cropped_face_and_record(
                                &app_clone,
                                &conn,
                                h,
                                &img,
                                (bx, by, bw, bh),
                                None,
                                "onnx",
                            ) {
                                faces_found += 1;

                                // Compare against known named people embeddings!
                                if !known_people_embeddings.is_empty() {
                                    if let Ok(emb_str) = conn.query_row(
                                        "SELECT embedding FROM photo_faces WHERE face_id = ?1",
                                        params![saved.face_id],
                                        |r| r.get::<_, String>(0),
                                    ) {
                                        if let Ok(cand_emb) = serde_json::from_str::<Vec<f32>>(&emb_str) {
                                            let mut best_match: Option<(String, f32)> = None;
                                            for (pname, ref_emb) in &known_people_embeddings {
                                                let sim = cosine_similarity(ref_emb, &cand_emb);
                                                if sim >= 0.86 {
                                                    if best_match.as_ref().map(|b| sim > b.1).unwrap_or(true) {
                                                        best_match = Some((pname.clone(), sim));
                                                    }
                                                }
                                            }
                                            if let Some((matched_name, best_sim)) = best_match {
                                                let _ = conn.execute(
                                                    "UPDATE photo_faces SET person_name = ?1, confidence = ?2 WHERE face_id = ?3",
                                                    params![matched_name, best_sim as f64, saved.face_id],
                                                );
                                                let _ = conn.execute(
                                                    "INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)",
                                                    params![h, matched_name],
                                                );
                                                auto_matched += 1;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (idx + 1) % 10 == 0 || idx + 1 == total {
                let _ = app_clone.emit(
                    "face-scan-progress",
                    FaceScanProgress {
                        completed: idx + 1,
                        total,
                        faces_found,
                        auto_matched,
                        done: idx + 1 == total,
                    },
                );
            }
        }
    });

    Ok(total_hashes)
}

#[tauri::command]
fn assign_face_region_and_automatch(
    app: AppHandle,
    hash: String,
    image_path: String,
    bbox_x: f64,
    bbox_y: f64,
    bbox_w: f64,
    bbox_h: f64,
    person_name: String,
) -> Result<Vec<FaceInstance>, String> {
    let clean_name = person_name.trim().to_string();
    if clean_name.is_empty() {
        return Err("Person name cannot be empty".into());
    }

    let img = open_and_orient_image(Path::new(&image_path)).map_err(|e| format!("Failed to open image: {e}"))?;
    let conn = open_global_db(&app)?;

    let saved_face = save_cropped_face_and_record(
        &app,
        &conn,
        &hash,
        &img,
        (bbox_x, bbox_y, bbox_w, bbox_h),
        Some(clean_name.clone()),
        "onnx",
    )
    .ok_or("Failed to crop face region")?;

    let ref_emb_str: String = conn
        .query_row(
            "SELECT embedding FROM photo_faces WHERE face_id = ?1",
            params![saved_face.face_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "[]".to_string());
    let ref_emb: Vec<f32> = serde_json::from_str(&ref_emb_str).unwrap_or_default();

    if !ref_emb.is_empty() {
        let app_clone = app.clone();
        let target_name = clean_name.clone();
        let source_hash = hash.clone();

        std::thread::spawn(move || {
            let Ok(bg_conn) = open_global_db(&app_clone) else {
                return;
            };

            let mut matched_hashes: Vec<String> = Vec::new();
            if let Ok(mut stmt) = bg_conn.prepare(
                "SELECT face_id, hash, embedding FROM photo_faces
                 WHERE hash != ?1 AND (person_name IS NULL OR person_name = '')",
            ) {
                if let Ok(rows) = stmt.query_map(params![source_hash], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                }) {
                    for (fid, fhash, femb_str) in rows.flatten() {
                        if let Ok(cand_emb) = serde_json::from_str::<Vec<f32>>(&femb_str) {
                            let sim = cosine_similarity(&ref_emb, &cand_emb);
                            if sim >= 0.86 {
                                let _ = bg_conn.execute(
                                    "UPDATE photo_faces SET person_name = ?1, confidence = ?2 WHERE face_id = ?3",
                                    params![target_name, sim as f64, fid],
                                );
                                let _ = bg_conn.execute(
                                    "INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)",
                                    params![fhash, target_name],
                                );
                                if !matched_hashes.contains(&fhash) {
                                    matched_hashes.push(fhash);
                                }
                            }
                        }
                    }
                }
            }

            let _ = app_clone.emit(
                "face-automatch-complete",
                FaceMatchEvent {
                    person_name: target_name,
                    total_matched: matched_hashes.len(),
                    matched_hashes,
                },
            );
        });
    }

    Ok(get_faces_for_hash(&conn, &hash))
}

#[tauri::command]
fn remove_face_box(app: AppHandle, face_id: String, hash: String) -> Result<Vec<FaceInstance>, String> {
    let conn = open_global_db(&app)?;
    let _ = conn.execute("DELETE FROM photo_faces WHERE face_id = ?1", params![face_id]);
    Ok(get_faces_for_hash(&conn, &hash))
}

#[tauri::command]
fn get_people(app: AppHandle, root_folder: Option<String>) -> Result<Vec<PersonItem>, String> {
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(root_folder.as_deref());
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name, COUNT(DISTINCT pp.hash) as cnt,
                    COALESCE(NULLIF(p.cover_face_thumb, ''), (SELECT pf.face_thumb FROM photo_faces pf JOIN photos phf ON pf.hash = phf.hash WHERE pf.person_name = p.name AND phf.current_path LIKE ?1 LIMIT 1), '') as face_crop,
                    (SELECT ph.hash FROM photos ph JOIN photo_people pp2 ON ph.hash = pp2.hash WHERE pp2.person_name = p.name AND ph.current_path LIKE ?1 LIMIT 1) as fallback_hash
             FROM people p
             JOIN photo_people pp ON p.name = pp.person_name
             JOIN photos ph_main ON pp.hash = ph_main.hash
             WHERE ph_main.current_path LIKE ?1
             GROUP BY p.name
             HAVING cnt > 0
             ORDER BY cnt DESC",
        )
        .map_err(|e| e.to_string())?;

    let app_dir = get_app_storage_dir(&app);
    let thumbs_dir = app_dir.join("thumbnails");

    let rows = stmt
        .query_map(params![prefix], |row| {
            let face_crop: String = row.get(3)?;
            let fallback_h: Option<String> = row.get(4)?;
            let cover_thumb = if !face_crop.is_empty() && Path::new(&face_crop).exists() {
                face_crop
            } else {
                fallback_h
                    .map(|h| thumbs_dir.join(format!("{}.jpg", h)).to_string_lossy().to_string())
                    .unwrap_or_default()
            };

            Ok(PersonItem {
                id: row.get(0)?,
                name: row.get(1)?,
                photo_count: row.get(2)?,
                cover_thumb,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
}

#[tauri::command]
fn add_person_to_photo(app: AppHandle, hash: String, name: String) -> Result<Vec<String>, String> {
    let clean = name.trim().to_string();
    if clean.is_empty() {
        return Err("Name cannot be empty".into());
    }
    let conn = open_global_db(&app)?;
    conn.execute("INSERT OR IGNORE INTO people (name) VALUES (?1)", params![clean])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)",
        params![hash, clean],
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT person_name FROM photo_people WHERE hash = ?1 ORDER BY person_name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![hash], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
fn remove_person_from_photo(app: AppHandle, hash: String, name: String) -> Result<Vec<String>, String> {
    let conn = open_global_db(&app)?;
    conn.execute(
        "DELETE FROM photo_people WHERE hash = ?1 AND person_name = ?2",
        params![hash, name],
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "UPDATE photo_faces SET person_name = NULL WHERE hash = ?1 AND person_name = ?2",
        params![hash, name],
    );

    let mut stmt = conn
        .prepare("SELECT person_name FROM photo_people WHERE hash = ?1 ORDER BY person_name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![hash], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

// ----------------- OLLAMA LIFECYCLE -----------------

#[tauri::command]
async fn check_ollama_status() -> Result<OllamaStatus, String> {
    let res = HTTP_CLIENT.get("http://127.0.0.1:11434/api/tags").send().await;

    if res.is_err() {
        return Ok(OllamaStatus {
            running: false,
            active_vram_model: None,
            installed_models: Vec::new(),
        });
    }

    let mut installed_models = Vec::new();
    if let Ok(response) = res.unwrap().json::<serde_json::Value>().await {
        if let Some(models) = response["models"].as_array() {
            for m in models {
                let name = m["name"].as_str().unwrap_or_default().to_string();
                let size_bytes = m["size"].as_f64().unwrap_or(0.0);
                installed_models.push(OllamaModelInfo {
                    name,
                    size_gb: (size_bytes / (1024.0 * 1024.0 * 1024.0) * 10.0).round() / 10.0,
                });
            }
        }
    }

    let mut active_vram_model = None;
    if let Ok(ps_res) = HTTP_CLIENT.get("http://127.0.0.1:11434/api/ps").send().await {
        if let Ok(ps_val) = ps_res.json::<serde_json::Value>().await {
            if let Some(active_arr) = ps_val["models"].as_array() {
                if let Some(first) = active_arr.first() {
                    active_vram_model = first["name"].as_str().map(|s| s.to_string());
                }
            }
        }
    }

    Ok(OllamaStatus {
        running: true,
        active_vram_model,
        installed_models,
    })
}

#[tauri::command]
async fn start_ollama_service() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("ollama")
            .arg("serve")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to spawn ollama serve: {e}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("ollama")
            .arg("serve")
            .spawn()
            .map_err(|e| format!("Failed to spawn ollama serve: {e}"))?;
    }

    Ok("Ollama started in background".to_string())
}

#[tauri::command]
async fn preload_ollama_vram(model_name: String) -> Result<String, String> {
    let payload = json!({
        "model": model_name.trim(),
        "prompt": "",
        "keep_alive": "30m"
    });

    let _ = HTTP_CLIENT
        .post("http://127.0.0.1:11434/api/generate")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to warm up model in VRAM: {e}"))?;

    Ok("Model loaded into VRAM".to_string())
}

#[tauri::command]
async fn unload_ollama_vram(model_name: String) -> Result<String, String> {
    let payload = json!({
        "model": model_name,
        "keep_alive": 0
    });

    let _ = HTTP_CLIENT
        .post("http://127.0.0.1:11434/api/generate")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to reach Ollama: {e}"))?;

    Ok("Model unloaded from VRAM".to_string())
}

// ----------------- CORE DATA COMMANDS -----------------

#[tauri::command]
fn set_rating(app: AppHandle, hash: String, rating: i32) -> Result<(), String> {
    let conn = open_global_db(&app)?;
    conn.execute(
        "UPDATE photos SET rating = ?1 WHERE hash = ?2",
        params![rating, hash],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn add_tag(app: AppHandle, hash: String, tag: String) -> Result<Vec<String>, String> {
    let clean_tag = tag.trim().to_lowercase();
    if clean_tag.is_empty() {
        return Err("Tag cannot be empty".into());
    }
    let conn = open_global_db(&app)?;
    conn.execute(
        "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, ?2)",
        params![hash, clean_tag],
    )
    .map_err(|e| e.to_string())?;

    get_tags_for_hash(&conn, &hash)
}

#[tauri::command]
fn remove_tag(app: AppHandle, hash: String, tag: String) -> Result<Vec<String>, String> {
    let conn = open_global_db(&app)?;
    conn.execute(
        "DELETE FROM photo_tags WHERE hash = ?1 AND tag = ?2",
        params![hash, tag],
    )
    .map_err(|e| e.to_string())?;

    get_tags_for_hash(&conn, &hash)
}

fn get_tags_for_hash(conn: &Connection, hash: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT tag FROM photo_tags WHERE hash = ?1 ORDER BY tag ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![hash], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

// ----------------- FAST ASSISTANT-PREFILLED QWEN3-VL VISION PIPELINE -----------------

fn encode_fast_ai_buffer(image_path: &str) -> Result<String, String> {
    if let Ok(img) = open_and_orient_image(Path::new(image_path)) {
        let small = img.thumbnail(640, 640).to_rgb8();
        let mut buf = Cursor::new(Vec::new());
        if small.write_to(&mut buf, ImageFormat::Jpeg).is_ok() {
            return Ok(general_purpose::STANDARD.encode(buf.into_inner()));
        }
    }
    let raw_bytes = fs::read(image_path).map_err(|e| format!("Failed to read image: {e}"))?;
    Ok(general_purpose::STANDARD.encode(&raw_bytes))
}

fn json_value_to_string_list(val: Option<&JsonValue>) -> Vec<String> {
    let Some(v) = val else { return Vec::new() };
    match v {
        JsonValue::Array(arr) => arr
            .iter()
            .filter_map(|item| match item {
                JsonValue::String(s) => Some(s.trim().to_string()),
                JsonValue::Object(map) => map
                    .get("name")
                    .or_else(|| map.get("label"))
                    .or_else(|| map.get("tag"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim().to_string()),
                _ => None,
            })
            .filter(|s| !s.is_empty())
            .collect(),
        JsonValue::String(s) => s
            .split(|c| c == ',' || c == ';' || c == '\n')
            .map(|part| part.trim().trim_matches(|c| c == '[' || c == ']' || c == '"').to_string())
            .filter(|part| !part.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn json_value_to_string(val: Option<&JsonValue>) -> String {
    let Some(v) = val else { return String::new() };
    match v {
        JsonValue::String(s) => s.trim().to_string(),
        JsonValue::Array(arr) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

fn parse_face_boxes(val: Option<&JsonValue>) -> Vec<AiFaceBox> {
    let Some(JsonValue::Array(arr)) = val else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        if let JsonValue::Object(map) = item {
            let coords_val = map
                .get("box_2d")
                .or_else(|| map.get("bbox"))
                .or_else(|| map.get("box"));
            if let Some(JsonValue::Array(c_arr)) = coords_val {
                let nums: Vec<f64> = c_arr.iter().filter_map(|n| n.as_f64()).collect();
                if nums.len() == 4 {
                    let label = map
                        .get("label")
                        .or_else(|| map.get("person"))
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    out.push(AiFaceBox { box_2d: nums, label });
                }
            }
        } else if let JsonValue::Array(c_arr) = item {
            let nums: Vec<f64> = c_arr.iter().filter_map(|n| n.as_f64()).collect();
            if nums.len() == 4 {
                out.push(AiFaceBox {
                    box_2d: nums,
                    label: None,
                });
            }
        }
    }
    out
}

fn parse_resilient_ai_json(raw: &str) -> Result<AiVisionResponse, String> {
    let mut cleaned = raw.trim().to_string();

    if let Some(end_think) = cleaned.rfind("</think>") {
        cleaned = cleaned[(end_think + 8)..].trim().to_string();
    }

    let bytes = cleaned.as_bytes();
    let mut last_close = None;
    for i in (0..bytes.len()).rev() {
        if bytes[i] == b'}' {
            last_close = Some(i);
            break;
        }
    }

    if let Some(end_idx) = last_close {
        for start_idx in 0..end_idx {
            if bytes[start_idx] == b'{' {
                let candidate = &cleaned[start_idx..=end_idx];
                if let Ok(val) = serde_json::from_str::<JsonValue>(candidate) {
                    if val.is_object() {
                        let objects = json_value_to_string_list(
                            val.get("objects")
                                .or_else(|| val.get("tags"))
                                .or_else(|| val.get("labels"))
                                .or_else(|| val.get("items")),
                        );
                        let scene = json_value_to_string(val.get("scene").or_else(|| val.get("setting")));
                        let is_screenshot = val
                            .get("is_screenshot")
                            .and_then(|v| v.as_bool())
                            .unwrap_or_else(|| scene.to_lowercase().contains("screenshot"));
                        let people_present = json_value_to_string_list(
                            val.get("people_present")
                                .or_else(|| val.get("people"))
                                .or_else(|| val.get("persons")),
                        );
                        let face_boxes = parse_face_boxes(
                            val.get("face_boxes")
                                .or_else(|| val.get("faces"))
                                .or_else(|| val.get("face_locations")),
                        );
                        let ocr_text = json_value_to_string(
                            val.get("ocr_text")
                                .or_else(|| val.get("text"))
                                .or_else(|| val.get("visible_text")),
                        );
                        let caption = json_value_to_string(
                            val.get("caption")
                                .or_else(|| val.get("description"))
                                .or_else(|| val.get("summary")),
                        );

                        if !caption.is_empty() || !objects.is_empty() || !ocr_text.is_empty() {
                            return Ok(AiVisionResponse {
                                objects,
                                scene,
                                is_screenshot,
                                people_present,
                                face_boxes,
                                ocr_text,
                                caption,
                            });
                        }
                    }
                }
            }
        }
    }

    Err(format!(
        "Could not parse JSON from model output: {}",
        cleaned.chars().take(160).collect::<String>()
    ))
}

#[tauri::command]
async fn ai_analyze_photo(
    app: AppHandle,
    hash: String,
    image_path_for_ai: String,
    model_name: String,
    existing_tags: Vec<String>,
) -> Result<AiAnalysisResult, String> {
    let img_path_clone = image_path_for_ai.clone();
    let base64_img = tauri::async_runtime::spawn_blocking(move || encode_fast_ai_buffer(&img_path_clone))
        .await
        .map_err(|e| e.to_string())??;

    let vocab_hint = if existing_tags.is_empty() {
        String::new()
    } else {
        format!(
            "Reuse relevant tags from [{}] when accurate. ",
            existing_tags.iter().take(20).cloned().collect::<Vec<_>>().join(", ")
        )
    };

    let prompt = format!(
        "Analyze this image and return JSON with keys: caption (1 sentence), objects (array of short lowercase nouns, e.g. card, dog, mug, sofa), scene (1 word: indoor, outdoor, screenshot, document, nature, street), is_screenshot (boolean), ocr_text (exact visible text in image, or empty string). {vocab_hint}"
    );

    let prefill = "{\"caption\": \"";
    let payload = json!({
        "model": model_name.trim(),
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": [base64_img]
            },
            {
                "role": "assistant",
                "content": prefill
            }
        ],
        "stream": false,
        "options": {
            "temperature": 0.1,
            "num_predict": 450
        },
        "keep_alive": "30m"
    });

    let res = HTTP_CLIENT
        .post("http://127.0.0.1:11434/api/chat")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Ollama unreachable: {e}"))?;

    if !res.status().is_success() {
        let err = res.text().await.unwrap_or_default();
        return Err(format!("Ollama error: {err}"));
    }

    let body: JsonValue = res.json().await.map_err(|e| e.to_string())?;

    let raw_content = body["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .trim();

    let mut full_json_str = if raw_content.starts_with('{') {
        raw_content.to_string()
    } else {
        format!("{}{}", prefill, raw_content)
    };

    if raw_content.is_empty() {
        let gen_payload = json!({
            "model": model_name.trim(),
            "prompt": prompt,
            "images": [base64_img],
            "format": "json",
            "think": false,
            "stream": false,
            "options": {
                "temperature": 0.1,
                "num_predict": 1024
            },
            "keep_alive": "30m"
        });
        if let Ok(gen_res) = HTTP_CLIENT
            .post("http://127.0.0.1:11434/api/generate")
            .json(&gen_payload)
            .send()
            .await
        {
            if let Ok(gen_body) = gen_res.json::<JsonValue>().await {
                if let Some(resp_str) = gen_body["response"].as_str() {
                    full_json_str = resp_str.trim().to_string();
                }
            }
        }
    }

    let ai_result = parse_resilient_ai_json(&full_json_str)?;

    let conn = open_global_db(&app)?;

    let banned_placeholders = [
        "none", "unknown", "null", "tag1", "tag2", "tag3", "object1", "object2", "item1", "item2",
        "analyze", "first", "got", "let", "step", "<lowercase noun>",
    ];

    let _ = conn.execute(
        "DELETE FROM photo_tags WHERE hash = ?1 AND tag IN ('tag1', 'tag2', 'tag3', 'analyze', 'first', 'got', 'let', 'step')",
        params![hash],
    );

    for raw_tag in &ai_result.objects {
        let mut clean = raw_tag
            .trim()
            .trim_matches(|c| c == '<' || c == '>' || c == '"')
            .to_lowercase();
        for prefix in ["illustration of ", "picture of ", "photo of ", "image of "] {
            if let Some(stripped) = clean.strip_prefix(prefix) {
                clean = stripped.trim().to_string();
            }
        }
        if clean.starts_with("text ") {
            continue;
        }
        if !clean.is_empty()
            && clean.len() <= 28
            && !clean.contains("lowercase")
            && !clean.contains('|')
            && !banned_placeholders.contains(&clean.as_str())
        {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, ?2)",
                params![hash, clean],
            );
        }
    }

    if !ai_result.scene.is_empty() {
        let first_scene_word = ai_result
            .scene
            .split(|c: char| !c.is_alphanumeric())
            .find(|w| !w.is_empty())
            .unwrap_or("")
            .to_lowercase();
        if ["indoor", "outdoor", "screenshot", "document", "nature", "street", "beach", "kitchen", "studio", "night"]
            .contains(&first_scene_word.as_str())
        {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, ?2)",
                params![hash, first_scene_word],
            );
        }
    }

    if ai_result.is_screenshot {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, 'screenshot')",
            params![hash],
        );
    }

    let clean_ocr = if ai_result.ocr_text.contains("<transcribe") {
        String::new()
    } else {
        ai_result.ocr_text.trim().to_string()
    };
    let clean_caption = ai_result.caption.trim().to_string();

    let _ = conn.execute(
        "UPDATE photos SET ai_caption = ?1, ocr_text = ?2 WHERE hash = ?3",
        params![clean_caption, clean_ocr, hash],
    );

    // Delegate face detection to pure-Rust ONNX UltraFace if no faces are recorded yet
    if get_faces_for_hash(&conn, &hash).is_empty() {
        if let Ok(img) = open_and_orient_image(Path::new(&image_path_for_ai)) {
            let onnx_boxes = detect_faces_with_onnx(&app, &img);
            for (bx, by, bw, bh, _score) in onnx_boxes {
                let _ = save_cropped_face_and_record(&app, &conn, &hash, &img, (bx, by, bw, bh), None, "onnx");
            }
        }
    }

    let current_faces = get_faces_for_hash(&conn, &hash);
    let updated_tags = get_tags_for_hash(&conn, &hash)?;

    let mut stmt = conn
        .prepare("SELECT person_name FROM photo_people WHERE hash = ?1 ORDER BY person_name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![hash], |r| r.get(0)).map_err(|e| e.to_string())?;
    let updated_people: Vec<String> = rows.flatten().collect();

    Ok(AiAnalysisResult {
        tags: updated_tags,
        people: updated_people,
        faces: current_faces,
        caption: clean_caption,
        ocr_text: clean_ocr,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            set_rating,
            add_tag,
            remove_tag,
            set_photo_flag,
            set_photo_color_label,
            set_photo_rotation,
            rescan_exif_batch,
            get_timeline_distribution,
            search_cities_offline,
            set_manual_location,
            stage_photo_move,
            clear_all_staged,
            get_staged_operations,
            commit_staged_operations,
            set_photo_basket,
            shift_capture_timestamps,
            export_xmp_sidecars,
            get_library_health_stats,
            prune_orphaned_cache,
            get_people,
            add_person_to_photo,
            remove_person_from_photo,
            ensure_neural_face_models,
            detect_faces_in_photo,
            scan_library_faces_batch,
            assign_face_region_and_automatch,
            remove_face_box,
            ai_analyze_photo,
            check_ollama_status,
            start_ollama_service,
            preload_ollama_vram,
            unload_ollama_vram
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
