use base64::{engine::general_purpose, Engine as _};
use image::{imageops::FilterType, DynamicImage, GenericImageView};
use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

pub use lumina_core::{clip, db, decode, exif_meta, face_engine, face_ort, fastdecode, ffmpeg, face_match, host, imaging, perf, recycle, scan, storage, thumbs, types, video_frames, video_meta, GEOCODER};
pub use types::*;
mod engine_commands;
mod library;
mod files;
mod face_scan;
mod face_review;
mod people;
mod ai;
mod system;
mod albums;
mod export;
mod prepare;
mod import;
mod watch;
mod face_quality;
mod highlights;
mod gallery;
mod backup;
mod duplicates;
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
use perf::*;
use storage::*;
use face_ort::*;
use face_match::*;
use host::*;

static SPLASH_CLOSED: AtomicBool = AtomicBool::new(false);

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // A restore chosen in Settings is moved in before anything opens the database
            backup::apply_pending_restore(&get_app_storage_dir(app.handle()));
            let _ = open_global_db(app.handle());
            // Warm up lazily-built resources off the UI thread, so the first scan doesn't stall on them:
            // the offline geocoder's city index (first photo with GPS) and the background thread pool
            std::thread::spawn(|| {
                LazyLock::force(&GEOCODER);
                LazyLock::force(&BG_POOL);
            });
            import::start_drive_watch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_commands::scan_folder,
            library::set_photos_rating,
            library::add_tag_batch,
            library::remove_tag,
            library::remove_tag_batch,
            library::set_photo_flag,
            library::set_photo_color_label,
            library::set_photo_rotation,
            library::set_photos_rotation_exact,
            engine_commands::rescan_exif_batch,
            library::search_cities_offline,
            library::set_manual_location,
            library::stage_photo_move,
            library::stage_photos_move,
            duplicates::find_duplicates,
            engine_commands::existing_playable_copy,
            engine_commands::make_playable_copy,
            engine_commands::cancel_playable_copy,
            engine_commands::video_cache_info,
            engine_commands::clear_video_cache,
            duplicates::stage_duplicate_extras,
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
            people::set_person_starred,
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
            face_review::ignore_faces,
            face_review::get_pending_face_match_counts,
            face_scan::detect_faces_in_photo,
            face_scan::scan_library_faces_batch,
            face_scan::cancel_face_scan,
            engine_commands::cancel_folder_scan,
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
            engine_commands::semantic_status,
            engine_commands::start_semantic_index,
            engine_commands::cancel_semantic_index,
            engine_commands::semantic_search,
            engine_commands::find_similar_photos,
            engine_commands::cancel_thumbnail_pass,
            ai::cancel_ollama_pull,
            face_scan::get_outdated_face_photos,
            face_review::get_unknown_face_clusters,
            engine_commands::get_face_match_config,
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
            files::trash_summary,
            system::open_in_default_app,
            system::reveal_in_file_manager,
            system::create_library_subfolder,
            system::get_app_data_dir,
            import::list_import_sources,
            import::preview_import,
            import::start_import,
            import::cancel_import,
            watch::watch_library,
            face_quality::measure_face_quality,
            highlights::pick_highlights,
            gallery::export_gallery,
            backup::backup_library,
            backup::inspect_backup,
            backup::restore_library,
            backup::restart_app,
            backup::export_library_csv,
            system::copy_image_to_clipboard,
            engine_commands::ensure_high_res_preview,
            system::close_splashscreen
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
