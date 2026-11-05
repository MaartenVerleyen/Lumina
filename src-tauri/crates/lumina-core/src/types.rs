// Data shapes shared by the engine, the desktop commands and (later) the server API: what the frontend receives.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    // Eye opening (about 0.3+ open, under 0.15 shut) and focus on the face; None for faces not measured yet
    pub eyes_open: Option<f64>,
    pub face_sharpness: Option<f64>,
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
    pub batch_faces: HashMap<String, Vec<FaceInstance>>,
    pub batch_people: HashMap<String, Vec<String>>,
    pub done: bool,
    pub cancelled: bool,
}

#[derive(Serialize, Clone)]
pub struct ScanProgressEvent {
    pub stage: String,
    pub current_file: String,
    pub completed: usize,
    pub total: usize,
    pub percent: usize,
    pub done: bool,
}

#[derive(Serialize, Clone, Default)]
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
    pub focal_length: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub iso: Option<String>,
    pub lens_model: Option<String>,
    pub pair_raw_path: Option<String>,
    pub damaged: bool,
    // "photo" or "video"; a video's length and codec (fourcc) when its container states them
    pub media_type: String,
    pub duration_ms: Option<u64>,
    pub video_codec: Option<String>,
    // Live Photos: on the photo its clip (hash and file), on the clip its photo
    pub live_video_hash: Option<String>,
    pub live_video_path: Option<String>,
    pub live_photo_hash: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PersonItem {
    pub id: i64,
    pub name: String,
    pub photo_count: i64,
    pub cover_thumb: String,
    pub hidden: bool,
    // The people who matter most to the user: Best of focuses on their photos
    pub starred: bool,
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
    pub thumb_ok: bool,
    pub damaged: bool,
    // Size the thumbnail file was written at (0 = existing file reused); stored as photos.thumb_edge
    pub thumb_edge: u32,
    // Videos: length and size found by the frame pass (MTS/AVI/MPEG files don't state them in a header)
    pub duration_ms: Option<u64>,
}

#[derive(Serialize, Clone)]
pub struct ThumbBatchProgress {
    pub items: Vec<ThumbBatchItem>,
    pub duplicate_groups: HashMap<String, usize>,
    pub completed: usize,
    pub total: usize,
    // Folder this pass belongs to, so the UI can ignore batches from a folder it has since left
    pub folder: String,
}

#[derive(Serialize, Clone)]
pub struct ExifRefreshResult {
    pub hash: String,
    pub captured_at: String,
    pub camera_model: String,
    pub location: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub focal_length: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub iso: Option<String>,
    pub lens_model: Option<String>,
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
    pub damaged_count: usize,
    // First 50 damaged file paths, for the Library Health list
    pub damaged_files: Vec<String>,
    // Rows whose file is gone (deleted outside Lumina): kept so a file moved elsewhere keeps its values when
    // it is found again; Library Health can forget them
    pub missing_count: usize,
    // People left on no photo and no face (from before Lumina took them off the list by itself)
    pub unused_people: usize,
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
    pub perf: AiPerf,
}

// Per-photo timing breakdown; Ollama durations come from its own response (nanoseconds converted to ms)
#[derive(Serialize, Clone, Default)]
pub struct AiPerf {
    pub image_kb: usize,
    pub encode_ms: u64,
    pub request_ms: u64,
    pub post_ms: u64,
    pub total_ms: u64,
    pub ollama_load_ms: u64,
    pub prompt_tokens: u64,
    pub prompt_eval_ms: u64,
    pub output_tokens: u64,
    pub output_eval_ms: u64,
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

#[derive(Serialize, Clone)]
pub struct OllamaPullProgress {
    pub model: String,
    pub status: String,
    pub completed_mb: f64,
    pub total_mb: f64,
    pub percent: usize,
    pub done: bool,
}

#[derive(Serialize, Clone)]
pub struct SimilarFaceCandidate {
    pub face_id: String,
    pub hash: String,
    pub face_thumb: String,
    pub photo_name: String,
    pub photo_path: String,
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub current_person: Option<String>,
    pub similarity: f32,
}
