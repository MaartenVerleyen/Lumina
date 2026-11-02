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
