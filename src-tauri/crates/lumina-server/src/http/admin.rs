// The admin page's server side: the server's status and backlog, the accounts, and the upload of a backup
// to restore. Only admins get here (the RPC table checks it; the upload checks it itself).
use super::{ApiError, Shared};
use crate::accounts::{self, Role, User};
use crate::host::ServerHost;
use crate::restore;
use crate::scope;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use http_body_util::BodyExt;
use lumina_core::host::Host;
use lumina_core::{ai, clip, db, face_engine, face_ort, libraries, thumbs};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use tokio::io::AsyncWriteExt;

#[derive(Serialize)]
struct LibraryStatus {
    root: String,
    name: String,
    photos: usize,
    videos: i64,
    // What the pipeline still has to do
    thumbnails_missing: usize,
    faces_pending: i64,
    smart_search_pending: i64,
    captions_pending: i64,
}

fn count(conn: &rusqlite::Connection, sql: &str, library: i64) -> i64 {
    conn.query_row(sql, [library], |r| r.get(0)).unwrap_or(0)
}

pub async fn status(host: &ServerHost) -> Result<JsonValue, ApiError> {
    let ollama = ai::check_ollama_status().await.ok();
    let conn = db::open_global_db(host)?;
    let thumbs_dir = db::get_app_storage_dir(host).join("thumbnails");
    let mut libs = Vec::new();
    for l in libraries::list(&conn)? {
        let hashes: Vec<String> = {
            let mut stmt = conn.prepare("SELECT hash FROM photos WHERE library_id = ?1").map_err(|e| ApiError::from(e.to_string()))?;
            let rows = stmt.query_map([l.id], |r| r.get::<_, String>(0)).map_err(|e| ApiError::from(e.to_string()))?;
            rows.flatten().collect()
        };
        let thumbnails_missing = hashes
            .iter()
            .filter(|h| !thumbs_dir.join(format!("{h}.jpg")).metadata().is_ok_and(|m| m.len() > 256))
            .count();
        libs.push(LibraryStatus {
            videos: count(&conn, "SELECT COUNT(*) FROM photos WHERE library_id = ?1 AND media_type = 'video'", l.id),
            faces_pending: conn
                .query_row(
                    "SELECT COUNT(*) FROM photos WHERE library_id = ?1 AND COALESCE(faces_engine, '') != ?2",
                    rusqlite::params![l.id, face_engine::FACE_ENGINE_V2],
                    |r| r.get(0),
                )
                .unwrap_or(0),
            smart_search_pending: count(
                &conn,
                "SELECT COUNT(*) FROM photos WHERE library_id = ?1 AND hash NOT IN (SELECT hash FROM photo_clip)",
                l.id,
            ),
            captions_pending: count(
                &conn,
                "SELECT COUNT(*) FROM photos WHERE library_id = ?1 AND COALESCE(media_type, 'photo') != 'video'
                 AND COALESCE(ai_caption, '') = ''",
                l.id,
            ),
            root: l.root,
            name: l.name,
            photos: l.photos,
            thumbnails_missing,
        });
    }
    let board = host.jobs.board.lock().unwrap();
    let data_dir = host.data_dir();
    let disk = restore::disk_space(&data_dir).map(|(free, total)| json!({ "free": free, "total": total }));
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "data_dir": data_dir.to_string_lossy(),
        "disk": disk,
        "device": face_ort::last_device(),
        "caption_model": *host.jobs.caption_model.lock().unwrap(),
        "ollama": ollama,
        "jobs": {
            "current": board.current,
            "queued": board.queued,
            "thumbnails": thumbs::thumbnail_passes_running(),
            "smart_search": clip::semantic_index_running(),
            "captions": ai::batch_running(),
        },
        "libraries": libs,
    }))
}

#[derive(Serialize)]
pub struct AccountRow {
    name: String,
    // Their default role (admin: the whole server)
    role: Role,
    // Libraries where their role differs from the default
    libraries: Vec<JsonValue>,
}

pub fn accounts(host: &ServerHost) -> Result<Vec<AccountRow>, ApiError> {
    let conn = db::open_global_db(host)?;
    let roots: std::collections::HashMap<i64, String> = libraries::list(&conn)?.into_iter().map(|l| (l.id, l.root)).collect();
    let mut out = Vec::new();
    for u in accounts::list_users(&conn)? {
        let mut libs: Vec<JsonValue> = scope::library_roles_of(&conn, u.id)?
            .into_iter()
            .filter_map(|(id, role)| roots.get(&id).map(|root| json!({ "root": root, "role": role })))
            .collect();
        libs.sort_by(|a, b| a["root"].as_str().cmp(&b["root"].as_str()));
        out.push(AccountRow { name: u.name, role: u.role, libraries: libs });
    }
    Ok(out)
}

// Changes that could leave the server without an admin, or lock the admin out, are refused
pub fn check_not_last_admin(conn: &rusqlite::Connection, me: &User, name: &str, removing_admin: bool) -> Result<(), ApiError> {
    if !removing_admin {
        return Ok(());
    }
    if me.name.eq_ignore_ascii_case(name.trim()) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "You can't take your own admin role away or remove yourself"));
    }
    let admins = accounts::list_users(conn)?.into_iter().filter(|u| u.role == Role::Admin).count();
    let target_is_admin = accounts::find_user(conn, name)?.is_some_and(|u| u.role == Role::Admin);
    if target_is_admin && admins <= 1 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "The server needs at least one admin"));
    }
    Ok(())
}

// The largest backup the admin page takes (a library database and its face crops)
const MAX_UPLOAD: u64 = 20 * 1024 * 1024 * 1024;

// POST /api/admin/restore with the .luminabackup as the body: written to the data folder first (an
// earlier upload is replaced), answers the name to inspect and restore it by
pub async fn upload_backup(State(state): State<Shared>, Extension(user): Extension<User>, request: Request) -> Result<Json<JsonValue>, ApiError> {
    if user.role != Role::Admin {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Restoring a backup needs the admin role"));
    }
    let dir = restore::restores_dir(&state.host);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| ApiError::from(e.to_string()))?;
    if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let name = format!("upload-{stamp}.luminabackup");
    let part = dir.join(format!("{name}.part"));
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| ApiError::from(e.to_string()))?;
    let mut body = request.into_body();
    let mut written: u64 = 0;
    let failed = |e: String| {
        let part = part.clone();
        async move {
            let _ = tokio::fs::remove_file(&part).await;
            ApiError::from(e)
        }
    };
    while let Some(frame) = body.frame().await {
        let frame = match frame {
            Ok(f) => f,
            Err(e) => return Err(failed(format!("The upload broke off: {e}")).await),
        };
        let Ok(data) = frame.into_data() else { continue };
        written += data.len() as u64;
        if written > MAX_UPLOAD {
            return Err(failed("That file is larger than a backup can be (20 GB)".into()).await);
        }
        if let Err(e) = file.write_all(&data).await {
            return Err(failed(format!("Couldn't save the upload: {e}")).await);
        }
    }
    file.flush().await.map_err(|e| ApiError::from(e.to_string()))?;
    drop(file);
    tokio::fs::rename(&part, dir.join(&name)).await.map_err(|e| ApiError::from(e.to_string()))?;
    println!("[restore] {} uploaded a backup ({} MB)", user.name, written / 1_000_000);
    Ok(Json(json!({ "file": name, "bytes": written })))
}
