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
pub async fn scan_folder(
    app: AppHandle,
    folder_path: String,
    force_reprocess: Option<bool>,
    keep_others: Option<bool>,
) -> Result<Vec<PhotoItem>, String> {
    scan::scan_library(Arc::new(app), folder_path, force_reprocess, !keep_others.unwrap_or(false)).await
}

#[tauri::command]
pub async fn rescan_exif_batch(app: AppHandle, hashes: Vec<String>) -> Result<Vec<ExifRefreshResult>, String> {
    scan::rescan_exif_batch(Arc::new(app), hashes).await
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub async fn check_ollama_status() -> Result<OllamaStatus, String> {
    ai::check_ollama_status().await
}

#[tauri::command]
pub async fn start_ollama_service() -> Result<String, String> {
    ai::start_ollama_service().await
}

#[tauri::command]
pub async fn ollama_tuning_status() -> ai::OllamaTuningStatus {
    ai::ollama_tuning_status().await
}

#[tauri::command]
pub async fn enable_ollama_flash_attention() -> Result<(), String> {
    ai::enable_ollama_flash_attention().await
}

#[tauri::command]
pub async fn preload_ollama_vram(model_name: String) -> Result<String, String> {
    ai::preload_ollama_vram(model_name).await
}

#[tauri::command]
pub async fn unload_ollama_vram(model_name: String) -> Result<String, String> {
    ai::unload_ollama_vram(model_name).await
}

#[tauri::command]
pub async fn pull_ollama_model(app: AppHandle, model_name: String) -> Result<String, String> {
    ai::pull_ollama_model(Arc::new(app), model_name).await
}

#[tauri::command]
pub async fn prepare_ai_image(app: AppHandle, hash: String, image_path: String) -> Result<(), String> {
    ai::prepare_ai_image(Arc::new(app), hash, image_path).await
}

#[tauri::command]
pub fn cancel_ai_analysis() {
    ai::cancel_ai_analysis()
}

#[tauri::command]
pub fn cancel_ollama_pull() {
    ai::cancel_ollama_pull()
}

#[tauri::command]
pub async fn ai_analyze_photo(app: AppHandle, hash: String, image_path_for_ai: String, model_name: String, existing_tags: Vec<String>) -> Result<AiAnalysisResult, String> {
    ai::ai_analyze_photo(Arc::new(app), hash, image_path_for_ai, model_name, existing_tags).await
}

#[tauri::command]
pub fn get_albums(app: AppHandle) -> Result<Vec<albums::Album>, String> {
    albums::get_albums(Arc::new(app))
}

#[tauri::command]
pub fn create_album(app: AppHandle, name: String) -> Result<i64, String> {
    albums::create_album(Arc::new(app), name)
}

#[tauri::command]
pub fn rename_album(app: AppHandle, id: i64, name: String) -> Result<(), String> {
    albums::rename_album(Arc::new(app), id, name)
}

#[tauri::command]
pub fn delete_album(app: AppHandle, id: i64) -> Result<(), String> {
    albums::delete_album(Arc::new(app), id)
}

#[tauri::command]
pub fn add_to_album(app: AppHandle, id: i64, hashes: Vec<String>) -> Result<Vec<String>, String> {
    albums::add_to_album(Arc::new(app), id, hashes)
}

#[tauri::command]
pub fn remove_from_album(app: AppHandle, id: i64, hashes: Vec<String>) -> Result<Vec<String>, String> {
    albums::remove_from_album(Arc::new(app), id, hashes)
}

#[tauri::command]
pub fn get_saved_searches(app: AppHandle) -> Result<Vec<albums::SavedSearch>, String> {
    albums::get_saved_searches(Arc::new(app))
}

#[tauri::command]
pub fn save_search(app: AppHandle, name: String, query: String, smart: Option<bool>) -> Result<i64, String> {
    albums::save_search(Arc::new(app), name, query, smart.unwrap_or(false))
}

#[tauri::command]
pub fn delete_saved_search(app: AppHandle, id: i64) -> Result<(), String> {
    albums::delete_saved_search(Arc::new(app), id)
}

#[tauri::command]
pub fn get_trip_names(app: AppHandle) -> Result<HashMap<String, String>, String> {
    albums::get_trip_names(Arc::new(app))
}

#[tauri::command]
pub fn set_trip_name(app: AppHandle, trip_id: String, name: String) -> Result<(), String> {
    albums::set_trip_name(Arc::new(app), trip_id, name)
}

#[tauri::command]
pub async fn backup_library(app: AppHandle, dest_dir: String, name: String, known_roots: Vec<String>, settings: String, keep: Option<usize>, keep_prefix: Option<String>) -> Result<backup::BackupResult, String> {
    backup::backup_library(Arc::new(app), dest_dir, name, known_roots, settings, keep, keep_prefix).await
}

#[tauri::command]
pub async fn inspect_backup(path: String) -> Result<backup::BackupManifest, String> {
    backup::inspect_backup(path).await
}

#[tauri::command]
pub async fn restore_library(app: AppHandle, path: String, remaps: Vec<backup::RootRemap>) -> Result<backup::RestoreResult, String> {
    backup::restore_library(Arc::new(app), path, remaps).await
}

#[tauri::command]
pub async fn export_library_csv(app: AppHandle, dest_path: String, root_folder: Option<String>) -> Result<usize, String> {
    backup::export_library_csv(Arc::new(app), dest_path, root_folder).await
}

#[tauri::command]
pub async fn find_duplicates(app: AppHandle, root_folder: Option<String>) -> Result<Vec<duplicates::DuplicateSet>, String> {
    duplicates::find_duplicates(Arc::new(app), root_folder).await
}

#[tauri::command]
pub async fn stage_duplicate_extras(app: AppHandle, sets: Vec<duplicates::DuplicateStageInput>) -> Result<usize, String> {
    duplicates::stage_duplicate_extras(Arc::new(app), sets).await
}

#[tauri::command]
pub fn cancel_export() {
    export::cancel_export()
}

#[tauri::command]
pub async fn export_photos(app: AppHandle, options: export::ExportOptions) -> Result<export::ExportResult, String> {
    export::export_photos(Arc::new(app), options).await
}

#[tauri::command]
pub async fn measure_face_quality(app: AppHandle, root_folder: String) -> Result<usize, String> {
    face_quality::measure_face_quality(Arc::new(app), root_folder).await
}

#[tauri::command]
pub async fn assign_face_region_and_automatch(app: AppHandle, hash: String, image_path: String, bbox_x: f64, bbox_y: f64, bbox_w: f64, bbox_h: f64, person_name: String) -> Result<Vec<FaceInstance>, String> {
    face_review::assign_face_region_and_automatch(Arc::new(app), hash, image_path, bbox_x, bbox_y, bbox_w, bbox_h, person_name).await
}

#[tauri::command]
pub fn remove_face_box(app: AppHandle, face_id: String, hash: String) -> Result<Vec<FaceInstance>, String> {
    face_review::remove_face_box(Arc::new(app), face_id, hash)
}

#[tauri::command]
pub async fn find_similar_faces(app: AppHandle, person_name: String, root_folder: Option<String>, force_refresh: Option<bool>) -> Result<Vec<SimilarFaceCandidate>, String> {
    face_review::find_similar_faces(Arc::new(app), person_name, root_folder, force_refresh).await
}

#[tauri::command]
pub async fn get_confirmed_faces_for_person(app: AppHandle, person_name: String) -> Result<Vec<SimilarFaceCandidate>, String> {
    face_review::get_confirmed_faces_for_person(Arc::new(app), person_name).await
}

#[tauri::command]
pub async fn get_rejected_faces_for_person(app: AppHandle, person_name: String) -> Result<Vec<SimilarFaceCandidate>, String> {
    face_review::get_rejected_faces_for_person(Arc::new(app), person_name).await
}

#[tauri::command]
pub async fn reject_face_candidates_batch(app: AppHandle, face_ids: Vec<String>, person_name: String) -> Result<usize, String> {
    face_review::reject_face_candidates_batch(Arc::new(app), face_ids, person_name).await
}

#[tauri::command]
pub async fn ignore_faces(app: AppHandle, face_ids: Vec<String>, ignore: bool) -> Result<usize, String> {
    face_review::ignore_faces(Arc::new(app), face_ids, ignore).await
}

#[tauri::command]
pub async fn unreject_face_candidates_batch(app: AppHandle, face_ids: Vec<String>, person_name: String) -> Result<usize, String> {
    face_review::unreject_face_candidates_batch(Arc::new(app), face_ids, person_name).await
}

#[tauri::command]
pub async fn unassign_faces_batch(app: AppHandle, face_ids: Vec<String>, person_name: String) -> Result<HashMap<String, Vec<FaceInstance>>, String> {
    face_review::unassign_faces_batch(Arc::new(app), face_ids, person_name).await
}

#[tauri::command]
pub async fn get_pending_face_match_counts(app: AppHandle, root_folder: Option<String>) -> Result<HashMap<String, usize>, String> {
    face_review::get_pending_face_match_counts(Arc::new(app), root_folder).await
}

#[tauri::command]
pub async fn assign_faces_to_person_batch(app: AppHandle, face_ids: Vec<String>, person_name: String) -> Result<HashMap<String, Vec<FaceInstance>>, String> {
    face_review::assign_faces_to_person_batch(Arc::new(app), face_ids, person_name).await
}

#[tauri::command]
pub async fn get_unknown_face_clusters(app: AppHandle, root_folder: Option<String>) -> Result<Vec<face_review::FaceCluster>, String> {
    face_review::get_unknown_face_clusters(Arc::new(app), root_folder).await
}

#[tauri::command]
pub async fn detect_faces_in_photo(app: AppHandle, hash: String, image_path: String, force_onnx: Option<bool>) -> Result<Vec<FaceInstance>, String> {
    face_scan::detect_faces_in_photo(Arc::new(app), hash, image_path, force_onnx).await
}

#[tauri::command]
pub async fn scan_library_faces_batch(app: AppHandle, hashes: Vec<String>) -> Result<usize, String> {
    face_scan::scan_library_faces_batch(Arc::new(app), hashes).await
}

#[tauri::command]
pub fn cancel_face_scan() {
    face_scan::cancel_face_scan()
}

#[tauri::command]
pub async fn get_outdated_face_photos(app: AppHandle, root_folder: Option<String>) -> Result<Vec<String>, String> {
    face_scan::get_outdated_face_photos(Arc::new(app), root_folder).await
}

#[tauri::command]
pub async fn commit_staged_operations(app: AppHandle, root_folder: String, smart_rename: Option<bool>) -> Result<files::CommitResult, String> {
    files::commit_staged_operations(Arc::new(app), root_folder, smart_rename).await
}

#[tauri::command]
pub async fn export_xmp_sidecars(app: AppHandle, hashes: Option<Vec<String>>, root_folder: Option<String>) -> Result<files::XmpExportResult, String> {
    files::export_xmp_sidecars(Arc::new(app), hashes, root_folder).await
}

#[tauri::command]
pub async fn get_library_health_stats(app: AppHandle, root_folder: Option<String>) -> Result<LibraryHealthStats, String> {
    files::get_library_health_stats(Arc::new(app), root_folder).await
}

#[tauri::command]
pub async fn forget_missing_files(app: AppHandle, root_folder: String) -> Result<usize, String> {
    files::forget_missing_files(Arc::new(app), root_folder).await
}

#[tauri::command]
pub async fn prune_orphaned_cache(app: AppHandle) -> Result<usize, String> {
    files::prune_orphaned_cache(Arc::new(app)).await
}

#[tauri::command]
pub async fn trash_summary(app: AppHandle, root_folder: String) -> Result<files::TrashSummary, String> {
    files::trash_summary(Arc::new(app), root_folder).await
}

#[tauri::command]
pub async fn empty_library_trash_to_os(app: AppHandle, root_folder: String, permanent: Option<bool>) -> Result<files::TrashResult, String> {
    files::empty_library_trash_to_os(Arc::new(app), root_folder, permanent).await
}

#[tauri::command]
pub async fn export_gallery(app: AppHandle, options: gallery::GalleryOptions) -> Result<gallery::GalleryResult, String> {
    gallery::export_gallery(Arc::new(app), options).await
}

#[tauri::command]
pub async fn pick_highlights(app: AppHandle, candidates: Vec<highlights::HighlightCandidate>, count: usize) -> Result<Vec<String>, String> {
    highlights::pick_highlights(Arc::new(app), candidates, count).await
}

#[tauri::command]
pub async fn preview_import(app: AppHandle, source: String, pattern: String) -> Result<import::ImportPreview, String> {
    import::preview_import(Arc::new(app), source, pattern).await
}

#[tauri::command]
pub async fn start_import(app: AppHandle, options: import::ImportOptions) -> Result<import::ImportResult, String> {
    import::start_import(Arc::new(app), options).await
}

#[tauri::command]
pub fn cancel_import() {
    import::cancel_import()
}

#[tauri::command]
pub fn list_import_sources() -> Vec<import::ImportSource> {
    import::list_import_sources()
}

#[tauri::command]
pub fn search_cities_offline(query: String) -> Result<Vec<CitySearchResult>, String> {
    library::search_cities_offline(query)
}

#[tauri::command]
pub fn set_manual_location(app: AppHandle, hashes: Vec<String>, location: String, latitude: Option<f64>, longitude: Option<f64>) -> Result<String, String> {
    library::set_manual_location(Arc::new(app), hashes, location, latitude, longitude)
}

#[tauri::command]
pub fn set_photo_flag(app: AppHandle, hashes: Vec<String>, flag: Option<String>) -> Result<(), String> {
    library::set_photo_flag(Arc::new(app), hashes, flag)
}

#[tauri::command]
pub fn set_photo_color_label(app: AppHandle, hashes: Vec<String>, color: Option<String>) -> Result<(), String> {
    library::set_photo_color_label(Arc::new(app), hashes, color)
}

#[tauri::command]
pub fn set_photo_rotation(app: AppHandle, hashes: Vec<String>, delta_degrees: i32) -> Result<HashMap<String, i32>, String> {
    library::set_photo_rotation(Arc::new(app), hashes, delta_degrees)
}

#[tauri::command]
pub fn set_photos_rotation_exact(app: AppHandle, ops: Vec<library::RotationResetInput>) -> Result<(), String> {
    library::set_photos_rotation_exact(Arc::new(app), ops)
}

#[tauri::command]
pub fn stage_photo_move(app: AppHandle, hash: String, target_subfolder: Option<String>) -> Result<(), String> {
    library::stage_photo_move(Arc::new(app), hash, target_subfolder)
}

#[tauri::command]
pub fn stage_photos_move(app: AppHandle, ops: Vec<library::StagedMoveInput>) -> Result<usize, String> {
    library::stage_photos_move(Arc::new(app), ops)
}

#[tauri::command]
pub fn clear_all_staged(app: AppHandle, root_folder: Option<String>) -> Result<usize, String> {
    library::clear_all_staged(Arc::new(app), root_folder)
}

#[tauri::command]
pub fn get_staged_operations(app: AppHandle, root_folder: Option<String>) -> Result<Vec<StagedOperation>, String> {
    library::get_staged_operations(Arc::new(app), root_folder)
}

#[tauri::command]
pub fn set_photo_basket(app: AppHandle, hashes: Vec<String>, in_basket: bool) -> Result<(), String> {
    library::set_photo_basket(Arc::new(app), hashes, in_basket)
}

#[tauri::command]
pub fn shift_capture_timestamps(app: AppHandle, hashes: Vec<String>, offset_minutes: i64) -> Result<Vec<TimestampShiftResult>, String> {
    library::shift_capture_timestamps(Arc::new(app), hashes, offset_minutes)
}

#[tauri::command]
pub fn set_photos_rating(app: AppHandle, hashes: Vec<String>, rating: i32) -> Result<(), String> {
    library::set_photos_rating(Arc::new(app), hashes, rating)
}

#[tauri::command]
pub fn add_tag_batch(app: AppHandle, hashes: Vec<String>, tag: String) -> Result<String, String> {
    library::add_tag_batch(Arc::new(app), hashes, tag)
}

#[tauri::command]
pub fn remove_tag(app: AppHandle, hash: String, tag: String) -> Result<Vec<String>, String> {
    library::remove_tag(Arc::new(app), hash, tag)
}

#[tauri::command]
pub fn remove_tag_batch(app: AppHandle, hashes: Vec<String>, tag: String) -> Result<(), String> {
    library::remove_tag_batch(Arc::new(app), hashes, tag)
}

#[tauri::command]
pub async fn get_people(app: AppHandle, root_folder: Option<String>) -> Result<Vec<PersonItem>, String> {
    people::get_people(Arc::new(app), root_folder).await
}

#[tauri::command]
pub fn add_person_to_photos(app: AppHandle, hashes: Vec<String>, name: String) -> Result<usize, String> {
    people::add_person_to_photos(Arc::new(app), hashes, name)
}

#[tauri::command]
pub fn remove_person_from_photos(app: AppHandle, hashes: Vec<String>, name: String) -> Result<(), String> {
    people::remove_person_from_photos(Arc::new(app), hashes, name)
}

#[tauri::command]
pub fn remove_person_from_photo(app: AppHandle, hash: String, name: String) -> Result<Vec<String>, String> {
    people::remove_person_from_photo(Arc::new(app), hash, name)
}

#[tauri::command]
pub async fn rename_person(app: AppHandle, old_name: String, new_name: String) -> Result<String, String> {
    people::rename_person(Arc::new(app), old_name, new_name).await
}

#[tauri::command]
pub fn set_person_hidden(app: AppHandle, name: String, hidden: bool) -> Result<(), String> {
    people::set_person_hidden(Arc::new(app), name, hidden)
}

#[tauri::command]
pub fn set_person_starred(app: AppHandle, name: String, starred: bool) -> Result<(), String> {
    people::set_person_starred(Arc::new(app), name, starred)
}

#[tauri::command]
pub fn set_person_cover(app: AppHandle, name: String, face_id: String) -> Result<(), String> {
    people::set_person_cover(Arc::new(app), name, face_id)
}

#[tauri::command]
pub fn watch_library(app: AppHandle, root: Option<String>) -> Result<(), String> {
    watch::watch_library(Arc::new(app), root)
}

// All photos watches every folder on this computer in it
#[tauri::command]
pub fn watch_libraries(app: AppHandle, roots: Vec<String>) -> Result<(), String> {
    watch::watch_libraries(Arc::new(app), roots)
}

#[tauri::command]
pub async fn run_caption_batch(app: AppHandle, hashes: Vec<String>, model_name: String) -> Result<ai::AiBatchSummary, String> {
    ai::run_caption_batch(Arc::new(app), hashes, model_name).await
}
