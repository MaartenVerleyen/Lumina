// What a request may refer to, looked up in the database: a library root the server keeps, a photo's stored
// path by its hash, a face crop by its id. A path is never built from request text.
use super::ApiError;
use axum::http::StatusCode;
use lumina_core::host::Host;
use lumina_core::{db, libraries};
use rusqlite::{Connection, OptionalExtension};

// The library with this root (as the client got it from list_libraries), in its stored spelling
pub fn library_root(host: &dyn Host, root: &str) -> Result<String, ApiError> {
    let conn = db::open_global_db(host)?;
    let wanted = libraries::normalize_root(root);
    libraries::list(&conn)?
        .into_iter()
        .map(|l| l.root)
        .find(|r| libraries::normalize_root(r) == wanted)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not a library on this server"))
}

// A photo's (or video's) file, if it is in one of the server's libraries
pub fn photo_path(conn: &Connection, hash: &str) -> Result<Option<String>, ApiError> {
    conn.query_row(
        "SELECT current_path FROM photos WHERE hash = ?1 AND library_id IS NOT NULL",
        [hash],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| ApiError::from(e.to_string()))
}

// A path a client sends back must be the stored path of that photo
pub fn check_photo_path(host: &dyn Host, hash: &str, path: &str) -> Result<(), ApiError> {
    let conn = db::open_global_db(host)?;
    match photo_path(&conn, hash)? {
        Some(stored) if stored == path => Ok(()),
        _ => Err(ApiError::new(StatusCode::BAD_REQUEST, "Not the path of that photo")),
    }
}

// The crop file of a face (a person's cover is one of their faces)
pub fn face_thumb(conn: &Connection, face_id: &str) -> Result<Option<String>, ApiError> {
    conn.query_row("SELECT face_thumb FROM photo_faces WHERE face_id = ?1", [face_id], |r| r.get::<_, Option<String>>(0))
        .optional()
        .map(|v| v.flatten().filter(|p| !p.is_empty()))
        .map_err(|e| ApiError::from(e.to_string()))
}
