// GET /media/{thumb|original|preview|face}/{id}: the files the window shows, by hash or face id (the kinds of
// MediaRef in src/api/transport.ts). Every file is found through the database; tower-http's ServeFile sends
// it with its type, Range support (seeking in videos) and If-Modified-Since.
use super::{blocking, lookup, ApiError, Shared};
use crate::accounts::User;
use crate::scope::Scope;
use axum::body::Body;
use axum::extract::{Extension, Path, Request, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use lumina_core::{db, decode, ffmpeg};
use std::path::PathBuf;
use tower::ServiceExt;
use tower_http::services::ServeFile;

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "No such media")
}

// Hashes and face ids are short words of letters, digits, '_' and '-'; anything else can't be one
fn check_id(id: &str) -> Result<(), ApiError> {
    if id.is_empty() || id.len() > 200 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(not_found());
    }
    Ok(())
}

// Only photos this user may see (their libraries, or albums shared with them): anything else is "no such
// media", whether it exists or not
fn may_see(conn: &rusqlite::Connection, user: &User, hash: &str) -> Result<bool, String> {
    Scope::load(conn, user)?.can_see(conn, hash)
}

async fn send_file(path: PathBuf, req: Request) -> Response {
    if !path.is_file() {
        return not_found().into_response();
    }
    match ServeFile::new(&path).oneshot(req).await {
        Ok(resp) => {
            let mut resp = resp.map(Body::new);
            // Files change rarely (a thumbnail is remade, a rotation), and only this user's browser keeps them
            resp.headers_mut().insert("cache-control", HeaderValue::from_static("private, max-age=3600"));
            resp
        }
        Err(e) => ApiError::from(e.to_string()).into_response(),
    }
}

pub async fn thumb(State(state): State<Shared>, Extension(user): Extension<User>, Path(hash): Path<String>, req: Request) -> Response {
    let found = async {
        check_id(&hash)?;
        let host = state.host.clone();
        blocking(move || {
            let conn = db::open_global_db(&*host)?;
            if !may_see(&conn, &user, &hash)? {
                return Ok(None);
            }
            Ok(lookup::photo_path(&conn, &hash).map_err(|e| e.1)?.map(|_| {
                db::get_app_storage_dir(&*host).join("thumbnails").join(format!("{hash}.jpg"))
            }))
        })
        .await?
        .ok_or_else(not_found)
    };
    match found.await {
        Ok(path) => send_file(path, req).await,
        Err(e) => e.into_response(),
    }
}

// The photo or video itself; a RAW or HEIC file as its 1920 px preview, which a browser can show
pub async fn original(State(state): State<Shared>, Extension(user): Extension<User>, Path(hash): Path<String>, req: Request) -> Response {
    let found = async {
        check_id(&hash)?;
        let host = state.host.clone();
        blocking(move || {
            let conn = db::open_global_db(&*host)?;
            if !may_see(&conn, &user, &hash)? {
                return Ok(None);
            }
            let Some(path) = lookup::photo_path(&conn, &hash).map_err(|e| e.1)? else { return Ok(None) };
            let ext = std::path::Path::new(&path)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if decode::is_raw_or_heic_ext(&ext) {
                return decode::ensure_high_res_preview(&*host, &hash, &path).map(|p| Some(PathBuf::from(p)));
            }
            Ok(Some(PathBuf::from(path)))
        })
        .await?
        .ok_or_else(not_found)
    };
    match found.await {
        Ok(path) => send_file(path, req).await,
        Err(e) => e.into_response(),
    }
}

// The playable copy of a video, once make_playable_copy has made it
pub async fn preview(State(state): State<Shared>, Extension(user): Extension<User>, Path(hash): Path<String>, req: Request) -> Response {
    let found = async {
        check_id(&hash)?;
        let host = state.host.clone();
        blocking(move || {
            let conn = db::open_global_db(&*host)?;
            if !may_see(&conn, &user, &hash)? || lookup::photo_path(&conn, &hash).map_err(|e| e.1)?.is_none() {
                return Ok(None);
            }
            Ok(ffmpeg::existing_playable_copy(host, hash).map(PathBuf::from))
        })
        .await?
        .ok_or_else(not_found)
    };
    match found.await {
        Ok(path) => send_file(path, req).await,
        Err(e) => e.into_response(),
    }
}

// A face crop by its face id (the frontend names it by the crop's file name, which is the face id)
pub async fn face(State(state): State<Shared>, Extension(user): Extension<User>, Path(face_id): Path<String>, req: Request) -> Response {
    let face_id = face_id.trim_end_matches(".jpg").to_string();
    let found = async {
        check_id(&face_id)?;
        let host = state.host.clone();
        blocking(move || {
            let conn = db::open_global_db(&*host)?;
            // A face is shown to those who may see its photo
            let on = super::access::photos_of_faces(&conn, &[face_id.clone()]).map_err(|e| e.1)?;
            if !on.iter().try_fold(false, |seen, h| may_see(&conn, &user, h).map(|s| seen || s))? {
                return Ok(None);
            }
            Ok(lookup::face_thumb(&conn, &face_id).map_err(|e| e.1)?.map(PathBuf::from))
        })
        .await?
        .ok_or_else(not_found)
    };
    match found.await {
        Ok(path) => send_file(path, req).await,
        Err(e) => e.into_response(),
    }
}
