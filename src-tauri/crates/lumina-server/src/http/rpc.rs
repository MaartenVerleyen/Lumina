// POST /api/rpc/{command}: the desktop's engine commands, by the same names and with the same JSON the
// frontend sends to Tauri's invoke (camelCase arguments), each with the lowest role allowed to call it.
// Commands not in the table don't exist on the server (404).
use super::{ApiError, Shared};
use crate::accounts::{Role, User};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use super::lookup;
use lumina_core::host::SharedHost;
use lumina_core::{ai, albums, clip, db, decode, face_engine, face_review, ffmpeg, highlights, libraries, library, people, scan};
use serde::de::DeserializeOwned;
use serde_json::Value as JsonValue;
use std::future::Future;
use std::pin::Pin;

type CallFuture = Pin<Box<dyn Future<Output = Result<JsonValue, ApiError>> + Send>>;

pub struct Command {
    pub name: &'static str,
    pub role: Role,
    call: fn(SharedHost, JsonValue) -> CallFuture,
}

fn parse_args<T: DeserializeOwned>(args: JsonValue) -> Result<T, ApiError> {
    serde_json::from_value(args).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("Bad arguments: {e}")))
}

fn answer<T: serde::Serialize, E: Into<ApiError>>(result: Result<T, E>) -> Result<JsonValue, ApiError> {
    let value = result.map_err(Into::into)?;
    serde_json::to_value(value).map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

// One line per command:
//   ROLE async|blocking NAME(arg: Type, ...) |host| expression giving Result<T, String or ApiError>;
// `async` expressions may .await; `blocking` ones run on a blocking thread (SQLite, files). Argument names
// are the Rust ones; the client sends them in camelCase, as to Tauri.
macro_rules! commands {
    ($( $role:ident $kind:ident $name:ident ( $($arg:ident : $ty:ty),* $(,)? ) |$host:ident| $body:expr ; )*) => {
        pub static COMMANDS: &[Command] = &[
            $( Command {
                name: stringify!($name),
                role: Role::$role,
                call: |$host, args| Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args { $( $arg: $ty ),* }
                    #[allow(unused_variables)]
                    let Args { $( $arg ),* } = parse_args::<Args>(args)?;
                    commands!(@run $kind $body)
                }),
            } ),*
        ];
    };
    (@run async $body:expr) => { answer($body) };
    (@run blocking $body:expr) => {
        match tokio::task::spawn_blocking(move || $body).await {
            Ok(result) => answer(result),
            Err(e) => Err(ApiError::from(e.to_string())),
        }
    };
}

commands! {
    // Browsing (viewer and up). scan_folder lists a library from the database: the server keeps its
    // libraries up to date itself; a rescan is admin work.
    Viewer async scan_folder(folder_path: String, force_reprocess: Option<bool>) |host| {
        let _ = force_reprocess;
        let root = lookup::library_root(&*host, &folder_path)?;
        scan::list_library(host, root).await.map_err(ApiError::from)
    };
    Viewer blocking list_libraries() |host| libraries::list(&db::open_global_db(&*host)?);
    // The server watches its libraries by itself
    Viewer blocking watch_library(root: Option<String>) |host| { let _ = (host, root); Ok::<(), String>(()) };
    Viewer async get_people(root_folder: Option<String>) |host| people::get_people(host, root_folder).await;
    Viewer blocking get_albums() |host| albums::get_albums(host);
    Viewer blocking get_saved_searches() |host| albums::get_saved_searches(host);
    Viewer blocking get_trip_names() |host| albums::get_trip_names(host);
    Viewer async semantic_status(root_folder: Option<String>) |host| clip::semantic_status(host, root_folder).await;
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

    // Editing (editor and up): milestone 3 adds the rest
    Editor blocking create_album(name: String) |host| albums::create_album(host, name);
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
    Ok(Json((cmd.call)(host, args).await?))
}
