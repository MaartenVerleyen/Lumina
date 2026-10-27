use base64::{engine::general_purpose, Engine as _};
use exif::{Reader, Tag, Value};
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageFormat};
use rayon::prelude::*;
use reverse_geocoder::ReverseGeocoder;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

mod db;
mod imaging;
mod face_engine;
mod scan;
mod exif_meta;
mod decode;
mod library;
mod files;
mod face_scan;
mod face_review;
mod people;
mod ai;
mod system;
mod perf;
mod storage;
mod fastdecode;
mod thumbs;
mod face_ort;
mod clip;
mod albums;
mod export;
mod face_match;
mod prepare;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod face_eval;

use db::*;
use imaging::*;
use face_engine::*;
use scan::*;
use exif_meta::*;
use decode::*;
use library::*;
use face_review::*;
use perf::*;
use storage::*;
use fastdecode::*;
use thumbs::*;
use face_ort::*;
use face_match::*;

static GEOCODER: LazyLock<ReverseGeocoder> = LazyLock::new(ReverseGeocoder::new);
static DB_SCHEMA_READY: AtomicBool = AtomicBool::new(false);
static SPLASH_CLOSED: AtomicBool = AtomicBool::new(false);
static WIC_COUNTER: AtomicUsize = AtomicUsize::new(1);

static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_default()
});

static FAST_STATUS_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1200))
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
}

#[derive(Serialize, Clone)]
pub struct PersonItem {
    pub id: i64,
    pub name: String,
    pub photo_count: i64,
    pub cover_thumb: String,
    pub hidden: bool,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Lumina Setup downloads the models through the app itself, without a window (see prepare.rs)
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--prepare-models") {
        let steps = args.get(i + 1).map(String::as_str).unwrap_or("faces,clip");
        std::process::exit(prepare::run(steps));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let _ = open_global_db(app.handle());
            // Warm up lazily-built resources off the UI thread, so the first scan doesn't stall on them:
            // the offline geocoder's city index (first photo with GPS) and the background thread pool
            std::thread::spawn(|| {
                LazyLock::force(&GEOCODER);
                LazyLock::force(&BG_POOL);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan::scan_folder,
            library::set_photos_rating,
            library::add_tag_batch,
            library::remove_tag,
            library::remove_tag_batch,
            library::set_photo_flag,
            library::set_photo_color_label,
            library::set_photo_rotation,
            library::set_photos_rotation_exact,
            scan::rescan_exif_batch,
            library::search_cities_offline,
            library::set_manual_location,
            library::stage_photo_move,
            library::stage_photos_move,
            library::clear_all_staged,
            library::get_staged_operations,
            files::commit_staged_operations,
            library::set_photo_basket,
            library::shift_capture_timestamps,
            files::export_xmp_sidecars,
            files::get_library_health_stats,
            files::prune_orphaned_cache,
            people::get_people,
            people::add_person_to_photos,
            people::remove_person_from_photo,
            people::remove_person_from_photos,
            people::rename_person,
            people::set_person_hidden,
            people::set_person_cover,
            albums::get_trip_names,
            albums::set_trip_name,
            face_review::find_similar_faces,
            face_review::get_confirmed_faces_for_person,
            face_review::get_rejected_faces_for_person,
            face_review::assign_faces_to_person_batch,
            face_review::unassign_faces_batch,
            face_review::reject_face_candidates_batch,
            face_review::unreject_face_candidates_batch,
            face_review::get_pending_face_match_counts,
            face_scan::detect_faces_in_photo,
            face_scan::scan_library_faces_batch,
            face_scan::cancel_face_scan,
            scan::cancel_folder_scan,
            export::export_photos,
            export::cancel_export,
            albums::get_albums,
            albums::create_album,
            albums::rename_album,
            albums::delete_album,
            albums::add_to_album,
            albums::remove_from_album,
            albums::get_saved_searches,
            albums::save_search,
            albums::delete_saved_search,
            clip::semantic_status,
            clip::start_semantic_index,
            clip::cancel_semantic_index,
            clip::semantic_search,
            clip::find_similar_photos,
            scan::cancel_thumbnail_pass,
            ai::cancel_ollama_pull,
            face_scan::get_outdated_face_photos,
            face_review::get_unknown_face_clusters,
            face_engine::get_face_match_config,
            face_review::assign_face_region_and_automatch,
            face_review::remove_face_box,
            ai::ai_analyze_photo,
            ai::prepare_ai_image,
            ai::cancel_ai_analysis,
            ai::ollama_tuning_status,
            ai::enable_ollama_flash_attention,
            ai::check_ollama_status,
            ai::start_ollama_service,
            ai::preload_ollama_vram,
            ai::unload_ollama_vram,
            ai::pull_ollama_model,
            files::empty_library_trash_to_os,
            system::open_in_default_app,
            system::reveal_in_file_manager,
            system::create_library_subfolder,
            system::get_app_data_dir,
            system::copy_image_to_clipboard,
            decode::ensure_high_res_preview,
            system::close_splashscreen
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
