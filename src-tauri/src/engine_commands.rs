// Tauri commands whose work is done in lumina-core: each one only hands its arguments to the engine.
use crate::*;

// On-Demand 1920px High-Res Preview Generator for RAW & HEIC (only called when viewing a photo in Loupe / Compare!)
#[tauri::command]
pub async fn ensure_high_res_preview(app: AppHandle, hash: String, source_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || decode::ensure_high_res_preview(&app, &hash, &source_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_face_match_config() -> face_engine::FaceMatchConfig {
    face_engine::get_face_match_config()
}

#[tauri::command]
pub fn cancel_semantic_index() {
    clip::cancel_semantic_index()
}

#[tauri::command]
pub async fn semantic_status(app: AppHandle, root_folder: Option<String>) -> Result<clip::SemanticStatus, String> {
    clip::semantic_status(Arc::new(app), root_folder).await
}

#[tauri::command]
pub async fn start_semantic_index(app: AppHandle, root_folder: String) -> Result<usize, String> {
    clip::start_semantic_index(Arc::new(app), root_folder).await
}

#[tauri::command]
pub async fn semantic_search(app: AppHandle, query: String) -> Result<Vec<clip::SemanticHit>, String> {
    clip::semantic_search(Arc::new(app), query).await
}

#[tauri::command]
pub async fn find_similar_photos(app: AppHandle, hash: String) -> Result<Vec<clip::SemanticHit>, String> {
    clip::find_similar_photos(Arc::new(app), hash).await
}

#[tauri::command]
pub fn existing_playable_copy(app: AppHandle, hash: String) -> Option<String> {
    ffmpeg::existing_playable_copy(Arc::new(app), hash)
}

#[tauri::command]
pub async fn make_playable_copy(app: AppHandle, hash: String) -> Result<String, String> {
    ffmpeg::make_playable_copy(Arc::new(app), hash).await
}

#[tauri::command]
pub fn cancel_playable_copy() {
    ffmpeg::cancel_playable_copy()
}

#[tauri::command]
pub fn video_cache_info(app: AppHandle) -> ffmpeg::VideoCacheInfo {
    ffmpeg::video_cache_info(Arc::new(app))
}

#[tauri::command]
pub fn clear_video_cache(app: AppHandle) -> usize {
    ffmpeg::clear_video_cache(Arc::new(app))
}

#[tauri::command]
pub fn cancel_folder_scan() {
    scan::cancel_folder_scan()
}

#[tauri::command]
pub fn cancel_thumbnail_pass() {
    scan::cancel_thumbnail_pass()
}

#[tauri::command]
pub async fn scan_folder(app: AppHandle, folder_path: String, force_reprocess: Option<bool>) -> Result<Vec<PhotoItem>, String> {
    scan::scan_folder(Arc::new(app), folder_path, force_reprocess).await
}

#[tauri::command]
pub async fn rescan_exif_batch(app: AppHandle, hashes: Vec<String>) -> Result<Vec<ExifRefreshResult>, String> {
    scan::rescan_exif_batch(Arc::new(app), hashes).await
}
