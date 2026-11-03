// What a command touches, checked against the caller's Scope, and the filtering of read results to what the
// caller may see. One place for both, so a command can't forget either: the RPC table names a Target per
// command, and the read commands pass their results through the filters here.
use super::ApiError;
use crate::accounts::Role;
use crate::scope::Scope;
use axum::http::StatusCode;
use rusqlite::Connection;
use serde_json::Value as JsonValue;
use std::collections::HashSet;

pub enum Target {
    // Server work (files on disk, the long jobs, users): admins only
    Server,
    // Something not tied to a library (a new album, a saved search): the role on any library will do
    AnyLibrary,
    // One library, by root (as the client got it from list_libraries)
    Root(String),
    // One library, or all of them (None)
    OptRoot(Option<String>),
    // These photos: the role on each one's library
    Photos(Vec<String>),
    // The photos these faces are on
    Faces(Vec<String>),
    // Every library with this person on a photo (people are shared by all libraries)
    Person(String),
    // Every library with a photo in this album
    Album(i64),
}

fn refused(role: Role) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, format!("This needs the {} role", role.as_str()))
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Not found")
}

fn query_strings(conn: &Connection, sql: &str, param: &dyn rusqlite::ToSql) -> Result<Vec<String>, ApiError> {
    let mut stmt = conn.prepare(sql).map_err(|e| ApiError::from(e.to_string()))?;
    let rows = stmt.query_map([param], |r| r.get::<_, String>(0)).map_err(|e| ApiError::from(e.to_string()))?;
    rows.collect::<Result<_, _>>().map_err(|e| ApiError::from(e.to_string()))
}

fn libraries_of_photos(conn: &Connection, hashes: &[String]) -> Result<HashSet<i64>, ApiError> {
    Ok(Scope::libraries_of(conn, hashes)?.into_values().collect())
}

pub fn photos_of_faces(conn: &Connection, face_ids: &[String]) -> Result<Vec<String>, ApiError> {
    let ids = serde_json::to_string(face_ids).map_err(|e| ApiError::from(e.to_string()))?;
    query_strings(conn, "SELECT DISTINCT hash FROM photo_faces WHERE face_id IN (SELECT value FROM json_each(?1))", &ids)
}

fn photos_of_person(conn: &Connection, name: &str) -> Result<Vec<String>, ApiError> {
    query_strings(
        conn,
        "SELECT hash FROM photo_people WHERE lower(person_name) = lower(?1)
         UNION SELECT hash FROM photo_faces WHERE lower(person_name) = lower(?1)",
        &name.trim(),
    )
}

// The role on every one of these libraries (none at all: on any library)
fn on_all(scope: &Scope, libraries: &HashSet<i64>, role: Role) -> Result<(), ApiError> {
    let ok = if libraries.is_empty() { scope.anywhere(role) } else { libraries.iter().all(|l| scope.role_on(*l) >= role) };
    if ok { Ok(()) } else { Err(refused(role)) }
}

// May this user do something needing `role` to `target`? Photos they can't see at all answer 404, so
// guessing hashes tells nothing; photos they see but may not change answer 403.
pub fn authorize(conn: &Connection, scope: &Scope, role: Role, target: Target) -> Result<(), ApiError> {
    if scope.admin() {
        return Ok(());
    }
    match target {
        Target::Server => Err(refused(Role::Admin)),
        Target::AnyLibrary => {
            if scope.anywhere(role) { Ok(()) } else { Err(refused(role)) }
        }
        Target::OptRoot(None) => {
            if scope.everywhere(role) { Ok(()) } else { Err(refused(role)) }
        }
        Target::Root(root) | Target::OptRoot(Some(root)) => {
            let Some(id) = scope.library_id_of_root(&root) else {
                return Err(ApiError::new(StatusCode::NOT_FOUND, "Not a library on this server"));
            };
            if scope.role_on(id) >= role {
                Ok(())
            } else if role <= Role::Viewer && shared_in_library(conn, scope, id)? {
                // A guest looks at what is shared with them in that library
                Ok(())
            } else if scope.role_on(id) >= Role::Viewer || shared_in_library(conn, scope, id)? {
                Err(refused(role))
            } else {
                Err(ApiError::new(StatusCode::NOT_FOUND, "Not a library on this server"))
            }
        }
        Target::Photos(hashes) => {
            let found = Scope::libraries_of(conn, &hashes)?;
            for hash in &hashes {
                let Some(library) = found.get(hash) else { continue };
                let own = scope.role_on(*library);
                if own >= role || (role <= Role::Viewer && scope.is_shared(hash)) {
                    continue;
                }
                return Err(if own >= Role::Viewer || scope.is_shared(hash) { refused(role) } else { not_found() });
            }
            Ok(())
        }
        Target::Faces(face_ids) => {
            let hashes = photos_of_faces(conn, &face_ids)?;
            authorize(conn, scope, role, Target::Photos(hashes))
        }
        Target::Person(name) => on_all(scope, &libraries_of_photos(conn, &photos_of_person(conn, &name)?)?, role),
        Target::Album(id) => {
            let hashes = query_strings(conn, "SELECT hash FROM album_photos WHERE album_id = ?1", &id)?;
            on_all(scope, &libraries_of_photos(conn, &hashes)?, role)
        }
    }
}

fn shared_in_library(conn: &Connection, scope: &Scope, library_id: i64) -> Result<bool, ApiError> {
    let shared: Vec<String> = scope.shared_hashes().cloned().collect();
    Ok(Scope::libraries_of(conn, &shared)?.values().any(|l| *l == library_id))
}

// Every photo this user may see in one library (None: in all of them)
pub fn visible_photos(conn: &Connection, scope: &Scope, library: Option<i64>) -> Result<HashSet<String>, ApiError> {
    let mut stmt = conn
        .prepare("SELECT hash, library_id FROM photos WHERE library_id IS NOT NULL")
        .map_err(|e| ApiError::from(e.to_string()))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| ApiError::from(e.to_string()))?;
    let mut out = HashSet::new();
    for row in rows {
        let (hash, lib) = row.map_err(|e| ApiError::from(e.to_string()))?;
        if library.is_some_and(|l| l != lib) {
            continue;
        }
        if scope.role_on(lib) >= Role::Viewer || scope.is_shared(&hash) {
            out.insert(hash);
        }
    }
    Ok(out)
}

// Keeps the items of a JSON list whose `hash` this user may see (a list of photos, hits or faces)
pub fn keep_visible(conn: &Connection, scope: &Scope, list: JsonValue) -> Result<JsonValue, ApiError> {
    if scope.sees_all() {
        return Ok(list);
    }
    let JsonValue::Array(items) = list else { return Ok(list) };
    let hashes: Vec<String> = items.iter().filter_map(|i| i["hash"].as_str().map(str::to_string)).collect();
    let visible: HashSet<String> = scope.visible(conn, &hashes)?.into_iter().collect();
    Ok(JsonValue::Array(items.into_iter().filter(|i| i["hash"].as_str().is_some_and(|h| visible.contains(h))).collect()))
}

// People as someone who sees only part of the photos may know them: only those on photos they see, counted
// over those photos, with a cover from one of them
pub fn people_for(conn: &Connection, scope: &Scope, library: Option<i64>, people: JsonValue) -> Result<JsonValue, ApiError> {
    let JsonValue::Array(items) = people else { return Ok(people) };
    let visible = visible_photos(conn, scope, library)?;
    let wanted = serde_json::to_string(&visible.iter().collect::<Vec<_>>()).map_err(|e| ApiError::from(e.to_string()))?;
    let mut counts = std::collections::HashMap::<String, i64>::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT lower(person_name), COUNT(DISTINCT hash) FROM photo_people
                 WHERE hash IN (SELECT value FROM json_each(?1)) GROUP BY lower(person_name)",
            )
            .map_err(|e| ApiError::from(e.to_string()))?;
        let rows = stmt
            .query_map([&wanted], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| ApiError::from(e.to_string()))?;
        for row in rows {
            let (name, n) = row.map_err(|e| ApiError::from(e.to_string()))?;
            counts.insert(name, n);
        }
    }
    let mut out = Vec::new();
    for mut person in items {
        let name = person["name"].as_str().unwrap_or("").to_string();
        let Some(n) = counts.get(&name.to_lowercase()) else { continue };
        person["photo_count"] = JsonValue::from(*n);
        // The cover must be a face on a photo this user sees
        let cover = person["cover_thumb"].as_str().unwrap_or("").to_string();
        let cover_visible = !cover.is_empty()
            && query_strings(conn, "SELECT hash FROM photo_faces WHERE face_thumb = ?1", &cover)?
                .iter()
                .any(|h| visible.contains(h));
        if !cover_visible {
            let mut stmt = conn
                .prepare(
                    "SELECT face_thumb FROM photo_faces WHERE lower(person_name) = lower(?1) AND face_thumb != ''
                     AND hash IN (SELECT value FROM json_each(?2)) LIMIT 1",
                )
                .map_err(|e| ApiError::from(e.to_string()))?;
            let thumb: Option<String> = stmt.query_row([&name, &wanted], |r| r.get(0)).ok();
            person["cover_thumb"] = JsonValue::from(thumb.unwrap_or_default());
        }
        out.push(person);
    }
    Ok(JsonValue::Array(out))
}

// Albums as this user may see them: the photos in them they can see, and the albums with any (or shared)
pub fn albums_for(conn: &Connection, scope: &Scope, albums: JsonValue) -> Result<JsonValue, ApiError> {
    if scope.sees_all() {
        return Ok(albums);
    }
    let JsonValue::Array(items) = albums else { return Ok(albums) };
    let mut out = Vec::new();
    for mut album in items {
        let hashes: Vec<String> =
            album["hashes"].as_array().map(|a| a.iter().filter_map(|h| h.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let visible = scope.visible(conn, &hashes)?;
        let shared = album["id"].as_i64().is_some_and(|id| scope.shared_albums.contains(&id));
        if visible.is_empty() && !shared {
            continue;
        }
        album["hashes"] = serde_json::json!(visible);
        out.push(album);
    }
    Ok(JsonValue::Array(out))
}
