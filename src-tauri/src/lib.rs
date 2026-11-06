use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use tauri::{AppHandle, Manager};

pub use lumina_core::{ai, albums, backup, clip, db, decode, duplicates, exif_meta, export, face_engine, face_match, face_ort, face_quality, face_review, face_scan, fastdecode, ffmpeg, files, gallery, highlights, host, imaging, import, library, people, perf, recycle, scan, storage, thumbs, types, video_frames, video_meta, watch, GEOCODER, HTTP_CLIENT, FAST_STATUS_CLIENT};
pub use types::*;
mod engine_commands;
mod system;
mod prepare;
mod media_server;
mod remote;
mod client_db;
mod transfer;
mod transfers;
#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
mod android_jni;
mod phone;
mod phone_backup;
mod follows;

use db::*;
use storage::*;

static SPLASH_CLOSED: AtomicBool = AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    system::linux_webkit_workarounds();

    // Lumina Setup downloads the models through the app itself, without a window (see prepare.rs)
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--prepare-models") {
        let steps = args.get(i + 1).map(String::as_str).unwrap_or("faces,clip");
        std::process::exit(prepare::run(steps));
    }

    let builder = tauri::Builder::default();
    // The phone app's Kotlin side (android.rs), and the phone's own photos and videos (phone.rs)
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android::init()).register_asynchronous_uri_scheme_protocol("lumina-phone", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || responder.respond(phone::serve(&app, &request)));
    });
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Client mode: a server's thumbnails, photos and videos, fetched with the session token (remote.rs)
        .register_asynchronous_uri_scheme_protocol("lumina-remote", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(remote::serve_media(app, request).await);
            });
        })
        .setup(|app| {
            // A restore chosen in Settings is moved in before anything opens the database
            backup::apply_pending_restore(&get_app_storage_dir(app.handle()));
            let _ = open_global_db(app.handle());
            // Thumbnails, previews and face crops: the scope covers the usual data folder, this adds one set
            // with LUMINA_DATA_DIR (a test library)
            host::Host::allow_media_dir(app.handle(), &get_app_storage_dir(app.handle()));
            // Warm up lazily-built resources off the UI thread, so the first scan doesn't stall on them:
            // the offline geocoder's city index (first photo with GPS) and the background thread pool
            std::thread::spawn(|| {
                LazyLock::force(&GEOCODER);
                LazyLock::force(&BG_POOL);
            });
            import::start_drive_watch(Arc::new(app.handle().clone()));
            #[cfg(any(target_os = "linux", target_os = "android"))]
            media_server::start(app.handle().clone());
            // Servers this app is signed in to: their events, and uploads or downloads still waiting
            app.manage(Arc::new(remote::Remote::load(get_app_storage_dir(app.handle()))));
            app.manage(transfers::init(app.handle()));
            remote::start(app.handle());
            transfers::resume(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_commands::scan_folder,
            engine_commands::set_photos_rating,
            engine_commands::add_tag_batch,
            engine_commands::remove_tag,
            engine_commands::remove_tag_batch,
            engine_commands::set_photo_flag,
            engine_commands::set_photo_color_label,
            engine_commands::set_photo_rotation,
            engine_commands::set_photos_rotation_exact,
            engine_commands::rescan_exif_batch,
            engine_commands::search_cities_offline,
            engine_commands::set_manual_location,
            engine_commands::stage_photo_move,
            engine_commands::stage_photos_move,
            engine_commands::find_duplicates,
            engine_commands::existing_playable_copy,
            engine_commands::make_playable_copy,
            engine_commands::cancel_playable_copy,
            engine_commands::video_cache_info,
            engine_commands::clear_video_cache,
            engine_commands::stage_duplicate_extras,
            engine_commands::clear_all_staged,
            engine_commands::get_staged_operations,
            engine_commands::commit_staged_operations,
            engine_commands::set_photo_basket,
            engine_commands::shift_capture_timestamps,
            engine_commands::export_xmp_sidecars,
            engine_commands::get_library_health_stats,
            engine_commands::forget_missing_files,
            engine_commands::prune_orphaned_cache,
            engine_commands::get_people,
            engine_commands::add_person_to_photos,
            engine_commands::remove_person_from_photo,
            engine_commands::remove_person_from_photos,
            engine_commands::rename_person,
            engine_commands::set_person_hidden,
            engine_commands::set_person_starred,
            engine_commands::set_person_cover,
            engine_commands::get_trip_names,
            engine_commands::set_trip_name,
            engine_commands::find_similar_faces,
            engine_commands::get_confirmed_faces_for_person,
            engine_commands::get_rejected_faces_for_person,
            engine_commands::assign_faces_to_person_batch,
            engine_commands::unassign_faces_batch,
            engine_commands::reject_face_candidates_batch,
            engine_commands::unreject_face_candidates_batch,
            engine_commands::ignore_faces,
            engine_commands::get_pending_face_match_counts,
            engine_commands::detect_faces_in_photo,
            engine_commands::scan_library_faces_batch,
            engine_commands::cancel_face_scan,
            engine_commands::cancel_folder_scan,
            engine_commands::export_photos,
            engine_commands::cancel_export,
            engine_commands::get_albums,
            engine_commands::create_album,
            engine_commands::rename_album,
            engine_commands::delete_album,
            engine_commands::add_to_album,
            engine_commands::remove_from_album,
            engine_commands::get_saved_searches,
            engine_commands::save_search,
            engine_commands::delete_saved_search,
            engine_commands::semantic_status,
            engine_commands::start_semantic_index,
            engine_commands::cancel_semantic_index,
            engine_commands::semantic_search,
            engine_commands::find_similar_photos,
            engine_commands::cancel_thumbnail_pass,
            engine_commands::cancel_ollama_pull,
            engine_commands::get_outdated_face_photos,
            engine_commands::get_unknown_face_clusters,
            engine_commands::get_face_match_config,
            engine_commands::assign_face_region_and_automatch,
            engine_commands::remove_face_box,
            engine_commands::ai_analyze_photo,
            engine_commands::prepare_ai_image,
            engine_commands::cancel_ai_analysis,
            engine_commands::run_caption_batch,
            engine_commands::ollama_tuning_status,
            engine_commands::enable_ollama_flash_attention,
            engine_commands::check_ollama_status,
            engine_commands::start_ollama_service,
            engine_commands::preload_ollama_vram,
            engine_commands::unload_ollama_vram,
            engine_commands::pull_ollama_model,
            engine_commands::empty_library_trash_to_os,
            engine_commands::trash_summary,
            system::open_in_default_app,
            system::reveal_in_file_manager,
            system::create_library_subfolder,
            system::get_app_data_dir,
            engine_commands::list_import_sources,
            engine_commands::preview_import,
            engine_commands::start_import,
            engine_commands::cancel_import,
            engine_commands::watch_library,
            engine_commands::watch_libraries,
            engine_commands::person_centroids,
            engine_commands::measure_face_quality,
            engine_commands::pick_highlights,
            engine_commands::export_gallery,
            engine_commands::backup_library,
            engine_commands::inspect_backup,
            engine_commands::restore_library,
            engine_commands::restart_app,
            engine_commands::export_library_csv,
            system::copy_image_to_clipboard,
            engine_commands::ensure_high_res_preview,
            media_server::local_media_server,
            remote::server_list,
            remote::server_login,
            remote::server_logout,
            remote::server_remove,
            remote::server_me,
            remote::server_call,
            remote::remote_cache_info,
            remote::set_remote_cache_limit,
            remote::clear_remote_cache,
            transfers::upload_paths,
            transfers::back_up,
            transfers::share_photos,
            transfers::save_to_phone,
            transfers::open_with,
            phone::phone_photos,
            phone::phone_haptic,
            phone_backup::phone_backup_selected,
            phone_backup::phone_folders,
            phone::phone_thumbs_info,
            phone::clear_phone_thumbs,
            phone_backup::phone_backup_status,
            phone_backup::phone_backup_settings,
            phone_backup::set_phone_backup,
            phone_backup::phone_backup_now,
            phone_backup::phone_backup_stop,
            follows::album_follows,
            follows::follow_album,
            follows::unfollow_album,
            follows::sync_follows,
            transfers::download_originals,
            transfers::transfer_progress,
            transfers::cancel_transfers,
            transfers::clear_transfers,
            transfers::retry_transfers,
            transfers::client_id,
            client_db::on_device,
            client_db::remove_local_copies,
            client_db::device_basket,
            client_db::set_device_basket,
            client_db::local_libraries,
            client_db::list_local_library,
            client_db::local_copy_ids,
            client_db::forget_local_library,
            system::close_splashscreen
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
