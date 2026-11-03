// Uploads into the library, resumable, after checking what the server already has:
//
//   POST /api/upload/check        {files: [{hash, size, name}]} -> {missing: [hash, ...]}
//   POST /api/upload              {name, size, hash, full_hash, modified} -> {id, received}
//   PUT  /api/upload/{id}         Upload-Offset: N, up to 8 MB of the file -> {received}
//   GET  /api/upload/{id}         -> {received, size}
//   POST /api/upload/{id}/finish  -> the new PhotoItem (null for a sidecar)
//
// `hash` is Lumina's content hash (imaging::hash_and_read_head), `full_hash` the BLAKE3 of the whole file,
// checked at the end. A partial upload is a file in <data>/incoming/; what has arrived is its length, so an
// upload survives a server restart. Uploads go to <upload library>/uploads/<user>/ and are indexed at once.
// Every route needs the uploader role on the upload library.
use super::{ApiError, Shared};
use crate::accounts::{Role, User};
use crate::host::ServerHost;
use crate::scope::Scope;
use axum::body::Bytes;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use lumina_core::host::Host;
use lumina_core::{db, libraries, scan};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// The largest chunk a PUT may carry
pub const MAX_CHUNK: usize = 8 * 1024 * 1024;
// Room the server keeps free on its disk
const KEEP_FREE: u64 = 5 * 1024 * 1024 * 1024;
// A partial upload without a new chunk for this long is given up
const ABANDONED_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);
// Sidecars are uploaded next to their photo
const SIDECAR_EXTENSIONS: &[&str] = &["xmp"];

pub fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS uploads (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            hash TEXT NOT NULL,
            full_hash TEXT NOT NULL,
            modified INTEGER NOT NULL,
            created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS full_hashes (
            hash TEXT PRIMARY KEY,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            blake3 TEXT NOT NULL
         );",
    )
    .map_err(|e| e.to_string())
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn incoming_dir(host: &ServerHost) -> PathBuf {
    host.data_dir().join("incoming")
}

fn part_path(host: &ServerHost, id: &str) -> PathBuf {
    incoming_dir(host).join(format!("{id}.part"))
}

fn bad(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, message)
}

// The library uploads go to: the configured one, or the first
fn upload_root(state: &Shared, conn: &Connection) -> Result<(i64, String), ApiError> {
    let libs = libraries::list(conn)?;
    let wanted = state.upload_library.as_deref().map(libraries::normalize_root);
    libs.into_iter()
        .find(|l| wanted.as_deref().is_none_or(|w| libraries::normalize_root(&l.root) == w))
        .map(|l| (l.id, l.root))
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "There is no library to upload to"))
}

// The upload library, if this user may upload into it
fn may_upload(state: &Shared, user: &User) -> Result<(Connection, String), ApiError> {
    let conn = db::open_global_db(&*state.host)?;
    let (library, root) = upload_root(state, &conn)?;
    let scope = Scope::load(&conn, user)?;
    if !scope.admin() && scope.role_on(library) < Role::Uploader {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Uploading needs the uploader role"));
    }
    Ok((conn, root))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, ApiError> + Send + 'static) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f).await.map_err(|e| ApiError::from(e.to_string()))?
}

// A name every file system takes: letters, digits, space, '.', '-', '_' and '(' ')' kept, anything else '_';
// no leading dots, nothing Windows reserves
pub fn safe_name(text: &str, fallback: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_alphanumeric() || " .-_()".contains(c) { c } else { '_' })
        .collect::<String>()
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .chars()
        .take(120)
        .collect();
    if cleaned.is_empty() {
        return fallback.to_string();
    }
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    if reserved { format!("_{cleaned}") } else { cleaned }
}

// "name.jpg", or "name (2).jpg", "name (3).jpg"... whichever doesn't exist yet
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap()
}

// Partial uploads nobody added to for a week
fn forget_abandoned(host: &ServerHost, conn: &Connection) {
    let dir = incoming_dir(host);
    let Ok(mut stmt) = conn.prepare("SELECT id, created_at FROM uploads") else { return };
    let rows: Vec<(String, i64)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|r| r.flatten().collect()).unwrap_or_default();
    for (id, created) in rows {
        let part = dir.join(format!("{id}.part"));
        let last = part
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(created);
        if now() - last > ABANDONED_AFTER.as_secs() as i64 {
            let _ = std::fs::remove_file(&part);
            let _ = conn.execute("DELETE FROM uploads WHERE id = ?1", [&id]);
        }
    }
}

#[derive(Deserialize)]
pub struct CheckFile {
    hash: String,
    size: u64,
    #[allow(dead_code)]
    name: Option<String>,
}

#[derive(Deserialize)]
pub struct CheckBody {
    files: Vec<CheckFile>,
}

pub async fn check(State(state): State<Shared>, Extension(user): Extension<User>, body: Bytes) -> Result<Json<JsonValue>, ApiError> {
    let body: CheckBody = serde_json::from_slice(&body).map_err(|e| bad(format!("Bad arguments: {e}")))?;
    blocking(move || {
        let (conn, _) = may_upload(&state, &user)?;
        let mut missing = Vec::new();
        for f in body.files {
            if scan::find_by_content(&conn, &f.hash, f.size)?.is_none() {
                missing.push(f.hash);
            }
        }
        Ok(Json(json!({ "missing": missing })))
    })
    .await
}

#[derive(Deserialize)]
pub struct StartBody {
    name: String,
    size: u64,
    hash: String,
    full_hash: String,
    // Seconds since 1970: the file's modification time, put back at the end
    modified: i64,
}

fn received(host: &ServerHost, id: &str) -> u64 {
    part_path(host, id).metadata().map(|m| m.len()).unwrap_or(0)
}

pub async fn start(State(state): State<Shared>, Extension(user): Extension<User>, body: Bytes) -> Result<Json<JsonValue>, ApiError> {
    let body: StartBody = serde_json::from_slice(&body).map_err(|e| bad(format!("Bad arguments: {e}")))?;
    blocking(move || {
        let (conn, _) = may_upload(&state, &user)?;
        let host = &state.host;
        forget_abandoned(host, &conn);
        // Only a file's own name, never a path
        let name = Path::new(body.name.trim()).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let name = safe_name(&name, "");
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
        let readable = scan::PHOTO_EXTENSIONS.contains(&ext.as_str())
            || lumina_core::video_meta::is_video_ext(&ext)
            || SIDECAR_EXTENSIONS.contains(&ext.as_str());
        if name.is_empty() || !readable {
            return Err(bad(format!("Lumina doesn't keep files like \"{}\" (photos, videos and .xmp sidecars only)", body.name)));
        }
        if body.size == 0 {
            return Err(bad("The file is empty"));
        }
        let hex = |t: &str, len: usize| t.len() == len && t.bytes().all(|b| b.is_ascii_hexdigit());
        if !hex(&body.hash, 16) || !hex(&body.full_hash, 64) {
            return Err(bad("hash must be Lumina's 16-character content hash, full_hash the file's 64-character BLAKE3"));
        }
        // The same file again from the same user: carry on where it stopped
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM uploads WHERE user_id = ?1 AND hash = ?2 AND size = ?3 AND full_hash = ?4",
                params![user.id, body.hash, body.size as i64, body.full_hash.to_lowercase()],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| ApiError::from(e.to_string()))?;
        if let Some(id) = existing {
            return Ok(Json(json!({ "id": id, "received": received(host, &id) })));
        }
        if let Some((free, _)) = crate::restore::disk_space(&host.data_dir()) {
            if body.size.saturating_add(KEEP_FREE) > free {
                return Err(ApiError::new(
                    StatusCode::INSUFFICIENT_STORAGE,
                    format!(
                        "The server's disk is nearly full: {:.1} GB free, and it keeps 5 GB free. Make room first.",
                        free as f64 / 1e9
                    ),
                ));
            }
        }
        let mut bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut bytes);
        let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        std::fs::create_dir_all(incoming_dir(host)).map_err(|e| ApiError::from(e.to_string()))?;
        std::fs::File::create(part_path(host, &id)).map_err(|e| ApiError::from(e.to_string()))?;
        conn.execute(
            "INSERT INTO uploads (id, user_id, name, size, hash, full_hash, modified, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, user.id, name, body.size as i64, body.hash, body.full_hash.to_lowercase(), body.modified, now()],
        )
        .map_err(|e| ApiError::from(e.to_string()))?;
        Ok(Json(json!({ "id": id, "received": 0 })))
    })
    .await
}

struct Upload {
    name: String,
    size: u64,
    full_hash: String,
    modified: i64,
}

// This user's upload with that id (someone else's is "not found")
fn find(conn: &Connection, user: &User, id: &str) -> Result<Upload, ApiError> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "No such upload"));
    }
    conn.query_row(
        "SELECT name, size, full_hash, modified FROM uploads WHERE id = ?1 AND user_id = ?2",
        params![id, user.id],
        |r| Ok(Upload { name: r.get(0)?, size: r.get::<_, i64>(1)? as u64, full_hash: r.get(2)?, modified: r.get(3)? }),
    )
    .optional()
    .map_err(|e| ApiError::from(e.to_string()))?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "No such upload"))
}

pub async fn progress(State(state): State<Shared>, Extension(user): Extension<User>, UrlPath(id): UrlPath<String>) -> Result<Json<JsonValue>, ApiError> {
    blocking(move || {
        let (conn, _) = may_upload(&state, &user)?;
        let upload = find(&conn, &user, &id)?;
        Ok(Json(json!({ "received": received(&state.host, &id), "size": upload.size })))
    })
    .await
}

pub async fn chunk(
    State(state): State<Shared>,
    Extension(user): Extension<User>,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let offset: u64 = headers
        .get("upload-offset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
        .ok_or_else(|| bad("Send the chunk's position in the Upload-Offset header"))?;
    if body.len() > MAX_CHUNK {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "A chunk can be at most 8 MB"));
    }
    blocking(move || {
        let (conn, _) = may_upload(&state, &user)?;
        let upload = find(&conn, &user, &id)?;
        let have = received(&state.host, &id);
        // Not where the file stands: tell the client where to carry on
        if offset != have {
            return Ok((StatusCode::CONFLICT, Json(json!({ "error": format!("Expected the chunk at {have}"), "offset": have }))).into_response());
        }
        if have + body.len() as u64 > upload.size {
            return Err(bad("That is more than the file's size"));
        }
        let mut file = std::fs::OpenOptions::new().append(true).open(part_path(&state.host, &id)).map_err(|e| ApiError::from(e.to_string()))?;
        file.write_all(&body).map_err(|e| ApiError::from(format!("Couldn't save the chunk: {e}")))?;
        file.flush().map_err(|e| ApiError::from(e.to_string()))?;
        Ok(Json(json!({ "received": have + body.len() as u64 })).into_response())
    })
    .await
}

pub fn file_blake3(path: &Path) -> Result<String, String> {
    let mut hasher = blake3::Hasher::new();
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(hasher.finalize().to_hex().to_string())
}

// Moves a file, also onto another disk (the data folder and the library needn't share one)
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|e| format!("Couldn't put the file in the library: {e}"))?;
    std::fs::remove_file(from).map_err(|e| e.to_string())
}

pub async fn finish(
    State(state): State<Shared>,
    Extension(user): Extension<User>,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
) -> Result<Json<JsonValue>, ApiError> {
    let origin: String = headers.get("x-lumina-client").and_then(|v| v.to_str().ok()).unwrap_or("").chars().take(64).collect();
    let state2 = state.clone();
    let user2 = user.clone();
    let (photo, dest) = blocking(move || {
        let (conn, root) = may_upload(&state2, &user2)?;
        let upload = find(&conn, &user2, &id)?;
        let host = &state2.host;
        let part = part_path(host, &id);
        let have = received(host, &id);
        if have != upload.size {
            return Err(ApiError::new(StatusCode::CONFLICT, format!("Only {have} of {} bytes have arrived", upload.size)));
        }
        let forget = || {
            let _ = std::fs::remove_file(&part);
            let _ = conn.execute("DELETE FROM uploads WHERE id = ?1", [&id]);
        };
        if file_blake3(&part)? != upload.full_hash {
            forget();
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "The file that arrived isn't the one that was sent (its BLAKE3 differs): upload it again",
            ));
        }
        let dir = PathBuf::from(&root).join("uploads").join(safe_name(&user2.name, "user"));
        std::fs::create_dir_all(&dir).map_err(|e| ApiError::from(e.to_string()))?;
        let dest = free_name(&dir, &upload.name);
        move_file(&part, &dest)?;
        let _ = conn.execute("DELETE FROM uploads WHERE id = ?1", [&id]);
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&dest) {
            let _ = f.set_modified(UNIX_EPOCH + Duration::from_secs(upload.modified.max(0) as u64));
        }
        let ext = dest.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let photo = if SIDECAR_EXTENSIONS.contains(&ext.as_str()) {
            None
        } else {
            Some(scan::index_new_file(host.clone(), &root, &dest)?)
        };
        Ok((photo, dest))
    })
    .await?;
    println!("[upload] {} uploaded {}", user.name, dest.display());
    if let Some(p) = &photo {
        let host = state.host.clone();
        let (uid, hash) = (user.id, p.hash.clone());
        let _ = tokio::task::spawn_blocking(move || {
            let mut conn = db::open_global_db(&*host)?;
            crate::changes::record(&mut conn, uid, &[hash], "upload")
        })
        .await;
        state.host.emit_value("photos-changed", json!({ "hashes": [p.hash], "by": user.name, "origin": origin }));
    }
    Ok(Json(serde_json::to_value(photo).map_err(|e| ApiError::from(e.to_string()))?))
}
