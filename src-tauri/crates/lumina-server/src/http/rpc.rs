// POST /api/rpc/{command}: the desktop's engine commands, by the same names and with the same JSON the
// frontend sends to Tauri's invoke (camelCase arguments), each with the lowest role allowed to call it.
// Commands not in the table don't exist on the server (404).
use super::{ApiError, Shared};
use crate::accounts::{Role, User};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use lumina_core::host::Host;
use axum::{Extension, Json};
use super::lookup;
use lumina_core::host::SharedHost;
use crate::changes;
use lumina_core::{ai, albums, clip, db, decode, duplicates, face_engine, face_quality, face_review, face_scan, ffmpeg, files, highlights, libraries, library, people, scan};
use serde::de::DeserializeOwned;
use serde_json::Value as JsonValue;
use std::future::Future;
use std::pin::Pin;

type CallFuture = Pin<Box<dyn Future<Output = Result<(JsonValue, Changed), ApiError>> + Send>>;

pub struct Command {
    pub name: &'static str,
    pub role: Role,
    call: fn(SharedHost, JsonValue) -> CallFuture,
}

// What an editing command changed, for the `changes` table and the events other users' clients refresh from
#[derive(Default, Debug)]
pub struct Changed {
    pub photos: Vec<String>,
    pub people: bool,
    pub albums: bool,
}

impl Changed {
    fn photos(hashes: impl IntoIterator<Item = String>) -> Changed {
        Changed { photos: hashes.into_iter().collect(), ..Default::default() }
    }
    fn people() -> Changed {
        Changed { people: true, ..Default::default() }
    }
    fn albums() -> Changed {
        Changed { albums: true, ..Default::default() }
    }
    fn and_people(mut self) -> Changed {
        self.people = true;
        self
    }
    fn and_albums(mut self) -> Changed {
        self.albums = true;
        self
    }
    pub fn is_empty(&self) -> bool {
        self.photos.is_empty() && !self.people && !self.albums
    }
}

fn parse_args<T: DeserializeOwned>(args: JsonValue) -> Result<T, ApiError> {
    serde_json::from_value(args).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("Bad arguments: {e}")))
}

fn answer<T: serde::Serialize, E: Into<ApiError>>(result: Result<T, E>) -> Result<JsonValue, ApiError> {
    let value = result.map_err(Into::into)?;
    serde_json::to_value(value).map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

// One line per command:
//   ROLE async|blocking NAME(arg: Type, ...) |host| expression giving Result<T, String or ApiError>
//        [=> before|after expression giving Result<Changed, String>];
// `async` expressions may .await; `blocking` ones run on a blocking thread (SQLite, files). Argument names
// are the Rust ones; the client sends them in camelCase, as to Tauri. The optional effect says what the
// command changed; it sees the same arguments and runs on a blocking thread, before the command (when the
// command removes what the effect looks up) or after it.
macro_rules! commands {
    ($( $role:ident $kind:ident $name:ident ( $($arg:ident : $ty:ty),* $(,)? ) |$host:ident| $body:expr $( => $when:ident $effect:expr )? ; )*) => {
        pub static COMMANDS: &[Command] = &[
            $( Command {
                name: stringify!($name),
                role: Role::$role,
                call: |$host, args| Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args { $( $arg: $ty ),* }
                    #[allow(unused_variables)]
                    let (effect_host, effect_args) = ($host.clone(), args.clone());
                    #[allow(unused_mut, unused_assignments)]
                    let mut changed = Changed::default();
                    commands!(@effect before, changed, effect_host, effect_args, $host, [$($arg),*] $(, $when $effect)?);
                    #[allow(unused_variables)]
                    let Args { $( $arg ),* } = parse_args::<Args>(args)?;
                    let value = commands!(@run $kind $body)?;
                    commands!(@effect after, changed, effect_host, effect_args, $host, [$($arg),*] $(, $when $effect)?);
                    Ok((value, changed))
                }),
            } ),*
        ];
    };
    (@effect before, $c:ident, $eh:ident, $ej:ident, $host:ident, [$($arg:ident),*], before $effect:expr) => {
        $c = commands!(@compute $eh, $ej, $host, [$($arg),*], $effect);
    };
    (@effect after, $c:ident, $eh:ident, $ej:ident, $host:ident, [$($arg:ident),*], after $effect:expr) => {
        $c = commands!(@compute $eh, $ej, $host, [$($arg),*], $effect);
    };
    (@effect $at:ident, $c:ident, $eh:ident, $ej:ident, $host:ident, [$($arg:ident),*] $(, $when:ident $effect:expr)?) => {};
    (@compute $eh:ident, $ej:ident, $host:ident, [$($arg:ident),*], $effect:expr) => {{
        #[allow(unused_variables)]
        let $host = $eh.clone();
        let json = $ej.clone();
        match tokio::task::spawn_blocking(move || -> Result<Changed, ApiError> {
            #[allow(unused_variables)]
            let Args { $( $arg ),* } = parse_args::<Args>(json)?;
            let effect: Result<Changed, String> = $effect;
            effect.map_err(ApiError::from)
        })
        .await
        {
            Ok(result) => result?,
            Err(e) => return Err(ApiError::from(e.to_string())),
        }
    }};
    (@run async $body:expr) => { answer($body) };
    (@run blocking $body:expr) => {
        match tokio::task::spawn_blocking(move || $body).await {
            Ok(result) => answer(result),
            Err(e) => Err(ApiError::from(e.to_string())),
        }
    };
}

// The photos that hold these faces (looked up before a command that may remove them)
fn photos_of_faces(host: &SharedHost, face_ids: &[String]) -> Result<Vec<String>, String> {
    let conn = db::open_global_db(&**host)?;
    let ids = serde_json::to_string(face_ids).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT DISTINCT hash FROM photo_faces WHERE face_id IN (SELECT value FROM json_each(?1))")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([ids], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

// Every photo with this person on it (after a change that can reach far beyond the photos it names:
// a rename, a merge, an automatic match)
fn photos_of_person(host: &SharedHost, name: &str) -> Result<Changed, String> {
    let conn = db::open_global_db(&**host)?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT hash FROM photo_people WHERE lower(person_name) = lower(?1)
             UNION SELECT DISTINCT hash FROM photo_faces WHERE lower(person_name) = lower(?1)",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([name.trim()], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    Ok(Changed::photos(rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?).and_people())
}

fn staged_photos(host: &SharedHost, root_folder: Option<String>) -> Result<Changed, String> {
    Ok(Changed::photos(library::get_staged_operations(host.clone(), root_folder)?.into_iter().map(|op| op.hash)))
}

// An optional library root from a client: one of the server's libraries, or none (all of them)
fn optional_root(host: &SharedHost, root: Option<String>) -> Result<Option<String>, ApiError> {
    root.map(|r| lookup::library_root(&**host, &r)).transpose()
}

commands! {
    // Browsing (viewer and up). scan_folder lists a library from the database: the server keeps its
    // libraries up to date itself; a rescan is admin work (rescan_library).
    Viewer async scan_folder(folder_path: String, force_reprocess: Option<bool>) |host| {
        let _ = force_reprocess;
        let root = lookup::library_root(&*host, &folder_path)?;
        scan::list_library(host, root).await.map_err(ApiError::from)
    };
    Viewer blocking list_libraries() |host| libraries::list(&db::open_global_db(&*host)?);
    // Photos another user changed, to refresh just those
    Viewer blocking get_photos(hashes: Vec<String>) |host| scan::photos_by_hash(&*host, &hashes);
    Viewer blocking get_photo_history(hash: String) |host|
        changes::history(&db::open_global_db(&*host)?, &hash, 50);
    // The server watches its libraries by itself
    Viewer blocking watch_library(root: Option<String>) |host| { let _ = (host, root); Ok::<(), String>(()) };
    Viewer async get_people(root_folder: Option<String>) |host| {
        let root = optional_root(&host, root_folder)?;
        people::get_people(host, root).await.map_err(ApiError::from)
    };
    Viewer blocking get_albums() |host| albums::get_albums(host);
    Viewer blocking get_saved_searches() |host| albums::get_saved_searches(host);
    Viewer blocking get_trip_names() |host| albums::get_trip_names(host);
    Viewer async semantic_status(root_folder: Option<String>) |host| {
        let root = optional_root(&host, root_folder)?;
        clip::semantic_status(host, root).await.map_err(ApiError::from)
    };
    Viewer async semantic_search(query: String) |host| clip::semantic_search(host, query).await;
    Viewer async find_similar_photos(hash: String) |host| clip::find_similar_photos(host, hash).await;
    Viewer blocking search_cities_offline(query: String) |host| { let _ = host; library::search_cities_offline(query) };
    Viewer blocking get_face_match_config() |host| { let _ = host; Ok::<_, String>(face_engine::get_face_match_config()) };
    Viewer async get_confirmed_faces_for_person(person_name: String) |host|
        face_review::get_confirmed_faces_for_person(host, person_name).await;
    Viewer async pick_highlights(candidates: Vec<highlights::HighlightCandidate>, count: usize) |host|
        highlights::pick_highlights(host, candidates, count).await;
    Viewer blocking existing_playable_copy(hash: String) |host| Ok::<_, String>(ffmpeg::existing_playable_copy(host, hash));
    Viewer async make_playable_copy(hash: String) |host| ffmpeg::make_playable_copy(host, hash).await;
    Viewer blocking cancel_playable_copy() |host| { let _ = host; ffmpeg::cancel_playable_copy(); Ok::<(), String>(()) };
    Viewer blocking ensure_high_res_preview(hash: String, source_path: String) |host| {
        lookup::check_photo_path(&*host, &hash, &source_path)?;
        decode::ensure_high_res_preview(&*host, &hash, &source_path).map_err(ApiError::from)
    };
    Viewer async check_ollama_status() |host| { let _ = host; ai::check_ollama_status().await };

    // Editing photos (editor and up)
    Editor blocking set_photos_rating(hashes: Vec<String>, rating: i32) |host| library::set_photos_rating(host, hashes, rating)
        => after Ok(Changed::photos(hashes));
    Editor blocking set_photo_flag(hashes: Vec<String>, flag: Option<String>) |host| library::set_photo_flag(host, hashes, flag)
        => after Ok(Changed::photos(hashes));
    Editor blocking set_photo_color_label(hashes: Vec<String>, color: Option<String>) |host|
        library::set_photo_color_label(host, hashes, color)
        => after Ok(Changed::photos(hashes));
    Editor blocking set_photo_rotation(hashes: Vec<String>, delta_degrees: i32) |host|
        library::set_photo_rotation(host, hashes, delta_degrees)
        => after Ok(Changed::photos(hashes));
    Editor blocking set_photos_rotation_exact(ops: Vec<library::RotationResetInput>) |host| library::set_photos_rotation_exact(host, ops)
        => after Ok(Changed::photos(ops.into_iter().map(|o| o.hash)));
    Editor blocking set_photo_basket(hashes: Vec<String>, in_basket: bool) |host| library::set_photo_basket(host, hashes, in_basket)
        => after Ok(Changed::photos(hashes));
    Editor blocking add_tag_batch(hashes: Vec<String>, tag: String) |host| library::add_tag_batch(host, hashes, tag)
        => after Ok(Changed::photos(hashes));
    Editor blocking remove_tag(hash: String, tag: String) |host| library::remove_tag(host, hash, tag)
        => after Ok(Changed::photos([hash]));
    Editor blocking remove_tag_batch(hashes: Vec<String>, tag: String) |host| library::remove_tag_batch(host, hashes, tag)
        => after Ok(Changed::photos(hashes));
    Editor blocking set_manual_location(hashes: Vec<String>, location: String, latitude: Option<f64>, longitude: Option<f64>) |host|
        library::set_manual_location(host, hashes, location, latitude, longitude)
        => after Ok(Changed::photos(hashes));
    Editor blocking shift_capture_timestamps(hashes: Vec<String>, offset_minutes: i64) |host|
        library::shift_capture_timestamps(host, hashes, offset_minutes)
        => after Ok(Changed::photos(hashes));
    Editor async rescan_exif_batch(hashes: Vec<String>) |host| scan::rescan_exif_batch(host, hashes).await
        => after Ok(Changed::photos(hashes));

    // People and faces
    Editor blocking add_person_to_photos(hashes: Vec<String>, name: String) |host| people::add_person_to_photos(host, hashes, name)
        => after Ok(Changed::photos(hashes).and_people());
    Editor blocking remove_person_from_photo(hash: String, name: String) |host| people::remove_person_from_photo(host, hash, name)
        => after Ok(Changed::photos([hash]).and_people());
    Editor blocking remove_person_from_photos(hashes: Vec<String>, name: String) |host|
        people::remove_person_from_photos(host, hashes, name)
        => after Ok(Changed::photos(hashes).and_people());
    Editor async rename_person(old_name: String, new_name: String) |host| people::rename_person(host, old_name, new_name).await
        => after photos_of_person(&host, &new_name);
    Editor blocking set_person_hidden(name: String, hidden: bool) |host| people::set_person_hidden(host, name, hidden)
        => after Ok(Changed::people());
    Editor blocking set_person_starred(name: String, starred: bool) |host| people::set_person_starred(host, name, starred)
        => after Ok(Changed::people());
    Editor blocking set_person_cover(name: String, face_id: String) |host| people::set_person_cover(host, name, face_id)
        => after Ok(Changed::people());
    Editor async find_similar_faces(person_name: String, root_folder: Option<String>, force_refresh: Option<bool>) |host| {
        let root = optional_root(&host, root_folder)?;
        face_review::find_similar_faces(host, person_name, root, force_refresh).await.map_err(ApiError::from)
    };
    Editor async get_rejected_faces_for_person(person_name: String) |host|
        face_review::get_rejected_faces_for_person(host, person_name).await;
    Editor async assign_faces_to_person_batch(face_ids: Vec<String>, person_name: String) |host|
        face_review::assign_faces_to_person_batch(host, face_ids, person_name).await
        => after Ok(Changed::photos(photos_of_faces(&host, &face_ids)?).and_people());
    Editor async unassign_faces_batch(face_ids: Vec<String>, person_name: String) |host|
        face_review::unassign_faces_batch(host, face_ids, person_name).await
        => after Ok(Changed::photos(photos_of_faces(&host, &face_ids)?).and_people());
    Editor async reject_face_candidates_batch(face_ids: Vec<String>, person_name: String) |host|
        face_review::reject_face_candidates_batch(host, face_ids, person_name).await
        => after Ok(Changed::people());
    Editor async unreject_face_candidates_batch(face_ids: Vec<String>, person_name: String) |host|
        face_review::unreject_face_candidates_batch(host, face_ids, person_name).await
        => after Ok(Changed::people());
    Editor async ignore_faces(face_ids: Vec<String>, ignore: bool) |host| face_review::ignore_faces(host, face_ids, ignore).await
        => before Ok(Changed::photos(photos_of_faces(&host, &face_ids)?).and_people());
    Editor async get_pending_face_match_counts(root_folder: Option<String>) |host| {
        let root = optional_root(&host, root_folder)?;
        face_review::get_pending_face_match_counts(host, root).await.map_err(ApiError::from)
    };
    Editor async get_unknown_face_clusters(root_folder: Option<String>) |host| {
        let root = optional_root(&host, root_folder)?;
        face_review::get_unknown_face_clusters(host, root).await.map_err(ApiError::from)
    };
    Editor async assign_face_region_and_automatch(hash: String, image_path: String, bbox_x: f64, bbox_y: f64, bbox_w: f64, bbox_h: f64, person_name: String) |host| {
        lookup::check_photo_path(&*host, &hash, &image_path)?;
        face_review::assign_face_region_and_automatch(host, hash, image_path, bbox_x, bbox_y, bbox_w, bbox_h, person_name)
            .await
            .map_err(ApiError::from)
    }
        => after photos_of_person(&host, &person_name).map(|c| Changed::photos(c.photos.into_iter().chain([hash])).and_people());
    Editor blocking remove_face_box(face_id: String, hash: String) |host| face_review::remove_face_box(host, face_id, hash)
        => after Ok(Changed::photos([hash]).and_people());
    Editor async detect_faces_in_photo(hash: String, image_path: String, force_onnx: Option<bool>) |host| {
        lookup::check_photo_path(&*host, &hash, &image_path)?;
        face_scan::detect_faces_in_photo(host, hash, image_path, force_onnx).await.map_err(ApiError::from)
    }
        => after Ok(Changed::photos([hash]).and_people());
    Editor async get_outdated_face_photos(root_folder: Option<String>) |host| {
        let root = optional_root(&host, root_folder)?;
        face_scan::get_outdated_face_photos(host, root).await.map_err(ApiError::from)
    };

    // Albums, saved searches and trips
    Editor blocking create_album(name: String) |host| albums::create_album(host, name) => after Ok(Changed::albums());
    Editor blocking rename_album(id: i64, name: String) |host| albums::rename_album(host, id, name) => after Ok(Changed::albums());
    Editor blocking delete_album(id: i64) |host| albums::delete_album(host, id) => after Ok(Changed::albums());
    Editor blocking add_to_album(id: i64, hashes: Vec<String>) |host| albums::add_to_album(host, id, hashes)
        => after Ok(Changed::photos(hashes).and_albums());
    Editor blocking remove_from_album(id: i64, hashes: Vec<String>) |host| albums::remove_from_album(host, id, hashes)
        => after Ok(Changed::photos(hashes).and_albums());
    Editor blocking save_search(name: String, query: String) |host| albums::save_search(host, name, query) => after Ok(Changed::albums());
    Editor blocking delete_saved_search(id: i64) |host| albums::delete_saved_search(host, id) => after Ok(Changed::albums());
    Editor blocking set_trip_name(trip_id: String, name: String) |host| albums::set_trip_name(host, trip_id, name)
        => after Ok(Changed::albums());

    // AI on single photos (a batch is admin work; while one runs, these answer "Batch AI is running")
    Editor async ai_analyze_photo(hash: String, image_path_for_ai: String, model_name: String, existing_tags: Vec<String>) |host| {
        lookup::check_photo_path(&*host, &hash, &image_path_for_ai)?;
        ai::ai_analyze_photo(host, hash, image_path_for_ai, model_name, existing_tags).await.map_err(ApiError::from)
    }
        => after Ok(Changed::photos([hash]));
    Editor async prepare_ai_image(hash: String, image_path: String) |host| {
        lookup::check_photo_path(&*host, &hash, &image_path)?;
        ai::prepare_ai_image(host, hash, image_path).await.map_err(ApiError::from)
    };
    Editor blocking cancel_ai_analysis() |host| { let _ = host; ai::cancel_ai_analysis(); Ok::<(), String>(()) };

    // Duplicates and planned moves: only marked here; files change at commit_staged_operations (admin)
    Editor async find_duplicates(root_folder: Option<String>) |host| {
        let root = optional_root(&host, root_folder)?;
        duplicates::find_duplicates(host, root).await.map_err(ApiError::from)
    };
    Editor async stage_duplicate_extras(sets: Vec<duplicates::DuplicateStageInput>) |host| duplicates::stage_duplicate_extras(host, sets).await
        => after Ok(Changed::photos(sets.into_iter().flat_map(|s| std::iter::once(s.keep).chain(s.extras))).and_albums().and_people());
    Editor blocking stage_photo_move(hash: String, target_subfolder: Option<String>) |host| library::stage_photo_move(host, hash, target_subfolder)
        => after Ok(Changed::photos([hash]));
    Editor blocking stage_photos_move(ops: Vec<library::StagedMoveInput>) |host| library::stage_photos_move(host, ops)
        => after Ok(Changed::photos(ops.into_iter().map(|o| o.hash)));
    Editor blocking get_staged_operations(root_folder: Option<String>) |host| {
        let root = optional_root(&host, root_folder)?;
        library::get_staged_operations(host, root).map_err(ApiError::from)
    };

    // Administration: files on disk, caches, and the long jobs (their cancel flags are process-wide)
    Admin async commit_staged_operations(root_folder: String, smart_rename: Option<bool>) |host| {
        let root = lookup::library_root(&*host, &root_folder)?;
        files::commit_staged_operations(host, root, smart_rename).await.map_err(ApiError::from)
    }
        => before staged_photos(&host, Some(root_folder));
    Admin blocking clear_all_staged(root_folder: Option<String>) |host| {
        let root = optional_root(&host, root_folder)?;
        library::clear_all_staged(host, root).map_err(ApiError::from)
    }
        => before staged_photos(&host, root_folder);
    Admin async trash_summary(root_folder: String) |host| {
        let root = lookup::library_root(&*host, &root_folder)?;
        files::trash_summary(host, root).await.map_err(ApiError::from)
    };
    // The server has no Recycle Bin: emptying _Trash always deletes for good (the client asks first)
    Admin async empty_library_trash_to_os(root_folder: String, permanent: Option<bool>) |host| {
        let _ = permanent;
        let root = lookup::library_root(&*host, &root_folder)?;
        files::empty_library_trash_to_os(host, root, Some(true)).await.map_err(ApiError::from)
    };
    Admin async export_xmp_sidecars(hashes: Option<Vec<String>>, root_folder: Option<String>) |host| {
        let root = optional_root(&host, root_folder)?;
        files::export_xmp_sidecars(host, hashes, root).await.map_err(ApiError::from)
    };
    Admin async get_library_health_stats(root_folder: Option<String>) |host| {
        let root = optional_root(&host, root_folder)?;
        files::get_library_health_stats(host, root).await.map_err(ApiError::from)
    };
    Admin async prune_orphaned_cache() |host| files::prune_orphaned_cache(host).await;
    Admin blocking video_cache_info() |host| Ok::<_, String>(ffmpeg::video_cache_info(host));
    Admin blocking clear_video_cache() |host| Ok::<_, String>(ffmpeg::clear_video_cache(host));
    // A rescan walks the library's folders (the listing above doesn't)
    Admin async rescan_library(folder_path: String) |host| {
        let root = lookup::library_root(&*host, &folder_path)?;
        scan::scan_folder(host, root, Some(false)).await.map_err(ApiError::from)
    };
    Admin blocking cancel_folder_scan() |host| { let _ = host; scan::cancel_folder_scan(); Ok::<(), String>(()) };
    Admin blocking cancel_thumbnail_pass() |host| { let _ = host; scan::cancel_thumbnail_pass(); Ok::<(), String>(()) };
    Admin async scan_library_faces_batch(hashes: Vec<String>) |host| face_scan::scan_library_faces_batch(host, hashes).await;
    Admin blocking cancel_face_scan() |host| { let _ = host; face_scan::cancel_face_scan(); Ok::<(), String>(()) };
    Admin async measure_face_quality(root_folder: String) |host| {
        let root = lookup::library_root(&*host, &root_folder)?;
        face_quality::measure_face_quality(host, root).await.map_err(ApiError::from)
    };
    Admin async start_semantic_index(root_folder: String) |host| {
        let root = lookup::library_root(&*host, &root_folder)?;
        clip::start_semantic_index(host, root).await.map_err(ApiError::from)
    };
    Admin blocking cancel_semantic_index() |host| { let _ = host; clip::cancel_semantic_index(); Ok::<(), String>(()) };
    Admin async run_caption_batch(hashes: Vec<String>, model_name: String) |host| ai::run_caption_batch(host, hashes, model_name).await;
    Admin async ollama_tuning_status() |host| { let _ = host; Ok::<_, String>(ai::ollama_tuning_status().await) };
    Admin async preload_ollama_vram(model_name: String) |host| { let _ = host; ai::preload_ollama_vram(model_name).await };
    Admin async unload_ollama_vram(model_name: String) |host| { let _ = host; ai::unload_ollama_vram(model_name).await };
    Admin async pull_ollama_model(model_name: String) |host| ai::pull_ollama_model(host, model_name).await;
    Admin blocking cancel_ollama_pull() |host| { let _ = host; ai::cancel_ollama_pull(); Ok::<(), String>(()) };
}

// Desktop commands that have no place on a server: they act on the computer the app runs on (open a file,
// the clipboard, a card reader, a local Ollama) or write to its folders. Downloads and uploads replace some
// of them in phase 3.
pub const NOT_ON_SERVER: &[&str] = &[
    "open_in_default_app",
    "reveal_in_file_manager",
    "create_library_subfolder",
    "get_app_data_dir",
    "copy_image_to_clipboard",
    "close_splashscreen",
    "restart_app",
    "list_import_sources",
    "preview_import",
    "start_import",
    "cancel_import",
    "export_photos",
    "cancel_export",
    "export_gallery",
    "backup_library",
    "export_library_csv",
    "start_ollama_service",
    "enable_ollama_flash_attention",
];

pub fn lookup(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.name == name)
}

pub async fn call(
    State(state): State<Shared>,
    Extension(user): Extension<User>,
    Path(command): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<JsonValue>, ApiError> {
    if NOT_ON_SERVER.contains(&command.as_str()) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, format!("{command} isn't available on the server")));
    }
    let cmd = lookup(&command).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Unknown command: {command}")))?;
    if user.role < cmd.role {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("{command} needs the {} role", cmd.role.as_str())));
    }
    let args = if body.iter().all(|b| b.is_ascii_whitespace()) {
        serde_json::json!({})
    } else {
        serde_json::from_slice(&body).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("Bad JSON: {e}")))?
    };
    let host: SharedHost = state.host.clone();
    let (value, changed) = (cmd.call)(host, args).await?;
    if !changed.is_empty() {
        // The window that made the change already shows it; it names itself so it can skip the echo
        let origin = headers.get("x-lumina-client").and_then(|v| v.to_str().ok()).unwrap_or("").chars().take(64).collect();
        announce(&state, &user, cmd.name, changed, origin).await;
    }
    Ok(Json(value))
}

// Writes who changed what, and tells every connected client which photos, people or albums to refresh
async fn announce(state: &Shared, user: &User, what: &'static str, mut changed: Changed, origin: String) {
    changed.photos.sort();
    changed.photos.dedup();
    let host = state.host.clone();
    let (user_id, hashes) = (user.id, changed.photos.clone());
    let recorded = tokio::task::spawn_blocking(move || {
        let mut conn = db::open_global_db(&*host)?;
        changes::record(&mut conn, user_id, &hashes, what)
    })
    .await;
    if let Ok(Err(e)) | Err(e) = recorded.map_err(|e| e.to_string()) {
        eprintln!("[changes] couldn't record {what}: {e}");
    }
    let by = serde_json::json!({ "by": user.name, "origin": origin });
    if !changed.photos.is_empty() {
        let mut payload = by.clone();
        payload["hashes"] = serde_json::json!(changed.photos);
        state.host.emit_value("photos-changed", payload);
    }
    if changed.people {
        state.host.emit_value("people-changed", by.clone());
    }
    if changed.albums {
        state.host.emit_value("albums-changed", by);
    }
}
