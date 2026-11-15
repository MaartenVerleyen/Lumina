// Export and Download for the web client: the photos a user picked, as one zip they download with the browser.
//
//   POST /api/export        {hashes, originals, longEdge, quality, stripGps} -> {id, exported, failed: [name]}
//   GET  /api/export/{id}   the zip, as a download (Range works, so a browser can resume it)
//
// `originals`: the files as they are (Download); otherwise JPEGs at the size asked (Export), as the desktop app
// makes them. The zip is made in <data>/exports/ under the user's id, so only that user can fetch it, and is
// removed an hour later (when the next export starts). Only photos the user may see go in.
use super::{blocking, media, ApiError, Shared};
use crate::accounts::User;
use crate::host::ServerHost;
use crate::scope::Scope;
use axum::extract::{Path as UrlPath, Request, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use lumina_core::host::Host;
use lumina_core::{db, export};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

// More than this in one go is better done in parts (each photo is decoded and encoded on the server)
const MOST_PHOTOS: usize = 2000;
const KEPT_FOR: Duration = Duration::from_secs(3600);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    hashes: Vec<String>,
    #[serde(default)]
    originals: bool,
    #[serde(default)]
    long_edge: u32,
    #[serde(default = "default_quality")]
    quality: u8,
    #[serde(default)]
    strip_gps: bool,
}

fn default_quality() -> u8 {
    90
}

fn exports_dir(host: &ServerHost) -> PathBuf {
    host.data_dir().join("exports")
}

fn zip_path(host: &ServerHost, user: &User, id: &str) -> PathBuf {
    exports_dir(host).join(format!("{}-{id}.zip", user.id))
}

// Zips older than an hour (fetched or not) go; so do the work folders of an export the server was stopped in
fn remove_old(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > KEPT_FOR);
        if old {
            let path = entry.path();
            let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        }
    }
}

pub async fn start(State(state): State<Shared>, Extension(user): Extension<User>, Json(req): Json<ExportRequest>) -> Result<Json<JsonValue>, ApiError> {
    if req.hashes.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "No photos to export"));
    }
    if req.hashes.len() > MOST_PHOTOS {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("{} photos is more than one export takes ({MOST_PHOTOS}); export them in parts", req.hashes.len()),
        ));
    }
    let host = state.host.clone();
    blocking(move || {
        let conn = db::open_global_db(&*host)?;
        let visible = Scope::load(&conn, &user)?.visible(&conn, &req.hashes)?;
        drop(conn);
        if visible.is_empty() {
            return Err("None of these photos can be exported".to_string());
        }
        let dir = exports_dir(&host);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Can't make the export: {e}"))?;
        remove_old(&dir);
        let mut bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut bytes);
        let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let options = export::ExportOptions {
            hashes: visible,
            dest_dir: String::new(),
            long_edge: req.long_edge,
            quality: req.quality,
            strip_gps: req.strip_gps,
            fetched: Vec::new(),
        };
        let result = export::export_zip(&*host, &options, req.originals, &zip_path(&host, &user, &id))?;
        // File names only: where the library is on the server isn't the user's business
        let failed: Vec<String> = result
            .failures
            .iter()
            .map(|f| Path::new(&f.file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
            .collect();
        Ok(Json(json!({ "id": id, "exported": result.exported, "failed": failed })))
    })
    .await
}

pub async fn fetch(State(state): State<Shared>, Extension(user): Extension<User>, UrlPath(id): UrlPath<String>, req: Request) -> Response {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return ApiError::new(StatusCode::NOT_FOUND, "No such export").into_response();
    }
    let path = zip_path(&state.host, &user, &id);
    if !path.is_file() {
        return ApiError::new(StatusCode::NOT_FOUND, "This export is gone (they are kept for an hour): export again").into_response();
    }
    let mut resp = media::send_file(path, req).await;
    if let Ok(v) = HeaderValue::from_str(&media::attachment("Lumina export.zip")) {
        resp.headers_mut().insert("content-disposition", v);
    }
    resp.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    resp
}
