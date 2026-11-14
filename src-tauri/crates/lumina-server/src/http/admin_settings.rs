// The admin page's Libraries and Settings sections: the settings in force (and what an environment variable
// fixes), adding and taking off libraries, where uploads go, the caption model and Ollama's address, and a
// folder browser to pick a library on the server. Only admins get here (the RPC table checks it).
use super::ApiError;
use crate::host::ServerHost;
use crate::pipeline::Job;
use crate::settings;
use axum::http::StatusCode;
use lumina_core::host::Host;
use lumina_core::{ai, db, libraries, watch};
use serde_json::{json, Value as JsonValue};
use std::path::Path;
use std::sync::Arc;

pub fn settings_view(host: &ServerHost) -> Result<JsonValue, ApiError> {
    let live = settings::live();
    let conn = db::open_global_db(host)?;
    let all = libraries::list(&conn)?;
    let count = |root: &str| all.iter().find(|l| settings::same_root(&l.root, root)).map(|l| l.photos).unwrap_or(0);
    // The configured libraries, and any other the server has (a folder scanned from the command line)
    let mut roots: Vec<String> = live.libraries.clone();
    for l in settings::served(all.clone()) {
        if !roots.iter().any(|r| settings::same_root(r, &l.root)) {
            roots.push(l.root);
        }
    }
    let libs: Vec<JsonValue> = roots.iter().map(|r| json!({ "root": r, "photos": count(r) })).collect();
    let removed: Vec<JsonValue> = live.removed_libraries.iter().map(|r| json!({ "root": r, "photos": count(r) })).collect();
    Ok(json!({
        "libraries": libs,
        "removed": removed,
        "upload_library": live.upload_library,
        "caption_model": live.caption_model,
        "ollama_url": live.ollama_url.clone().unwrap_or_else(ai::ollama_url),
        "fixed": live.fixed,
    }))
}

fn bad(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, message)
}

fn not_fixed(name: &str, variable: &str) -> Result<(), ApiError> {
    if settings::live().fixed.iter().any(|f| f == name) {
        return Err(bad(format!("This is set by {variable} where the server starts; change it there")));
    }
    Ok(())
}

// Adds a folder as a library: watched from now on, and indexed by the pipeline (one job after the other).
// A folder inside a library is that library; a folder around libraries takes them in (libraries::open).
pub fn add_library(host: &Arc<ServerHost>, folder: &str) -> Result<JsonValue, ApiError> {
    not_fixed("libraries", "LUMINA_LIBRARIES")?;
    let folder = folder.trim();
    if folder.is_empty() || !Path::new(folder).is_dir() {
        return Err(bad(format!("There is no folder at {folder} on the server")));
    }
    let wanted = libraries::normalize_root(folder);
    let conn = db::open_global_db(&**host)?;
    let id = libraries::open(&conn, &wanted)?;
    let root = libraries::list(&conn)?.into_iter().find(|l| l.id == id).map(|l| l.root).unwrap_or_else(|| wanted.clone());
    let live = settings::live();
    if live.libraries.iter().any(|r| settings::same_root(r, &root)) && !settings::is_removed(&root) {
        return Err(bad(if settings::same_root(&root, &wanted) {
            format!("{root} is a library already")
        } else {
            format!("{wanted} is inside the library {root} already")
        }));
    }
    let updated = settings::update(|l| {
        // Libraries inside the new one are part of it now
        l.libraries.retain(|r| !Path::new(r).starts_with(&root) || settings::same_root(r, &root));
        if !l.libraries.iter().any(|r| settings::same_root(r, &root)) {
            l.libraries.push(root.clone());
        }
        l.removed_libraries.retain(|r| !Path::new(r).starts_with(&root));
        Ok(())
    })?;
    if let Err(e) = watch::watch_libraries(host.clone(), updated.libraries.clone()) {
        eprintln!("[library] {e}");
    }
    host.jobs.queue(Job::Update(root.clone()))?;
    host.emit_value("libraries-changed", json!({ "root": root }));
    println!("[library] added {root}");
    settings_view(host)
}

// Takes a library off the server: no longer scanned, watched or shown; its photos' values stay in the database
pub fn remove_library(host: &Arc<ServerHost>, root: &str) -> Result<JsonValue, ApiError> {
    not_fixed("libraries", "LUMINA_LIBRARIES")?;
    let conn = db::open_global_db(&**host)?;
    let served = settings::served(libraries::list(&conn)?);
    let live = settings::live();
    let mut all: Vec<String> = live.libraries.clone();
    for l in served {
        if !all.iter().any(|r| settings::same_root(r, &l.root)) {
            all.push(l.root);
        }
    }
    let Some(root) = all.iter().find(|r| settings::same_root(r, root)).cloned() else {
        return Err(bad(format!("{root} isn't one of the server's libraries")));
    };
    if all.len() <= 1 {
        return Err(bad("The server needs at least one library: add another before taking this one off"));
    }
    let updated = settings::update(|l| {
        l.libraries.retain(|r| !settings::same_root(r, &root));
        if !l.removed_libraries.iter().any(|r| settings::same_root(r, &root)) {
            l.removed_libraries.push(root.clone());
        }
        if l.upload_library.as_deref().is_some_and(|u| settings::same_root(u, &root)) {
            l.upload_library = None;
        }
        Ok(())
    })?;
    if let Err(e) = watch::watch_libraries(host.clone(), updated.libraries.clone()) {
        eprintln!("[library] {e}");
    }
    host.emit_value("libraries-changed", json!({ "root": root }));
    println!("[library] took {root} off the server");
    settings_view(host)
}

// Where uploads go, the caption model and Ollama's address. Each applies at once. None leaves one as it is;
// an empty text clears it (uploads to the first library, no captions, Ollama on this machine).
pub fn save_settings(
    host: &ServerHost,
    upload_library: Option<String>,
    caption_model: Option<String>,
    ollama_url: Option<String>,
) -> Result<JsonValue, ApiError> {
    if upload_library.is_some() {
        not_fixed("upload_library", "LUMINA_UPLOAD_LIBRARY")?;
    }
    if caption_model.is_some() {
        not_fixed("caption_model", "LUMINA_CAPTION_MODEL")?;
    }
    if ollama_url.is_some() {
        not_fixed("ollama_url", "LUMINA_OLLAMA_URL")?;
    }
    let clean = |v: Option<String>| v.map(|s| s.trim().to_string());
    let (upload_library, caption_model, ollama_url) = (clean(upload_library), clean(caption_model), clean(ollama_url));
    if let Some(url) = ollama_url.as_deref().filter(|u| !u.is_empty()) {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(bad("Ollama's address starts with http:// (for example http://127.0.0.1:11434)"));
        }
    }
    if let Some(root) = upload_library.as_deref().filter(|r| !r.is_empty()) {
        let conn = db::open_global_db(host)?;
        if !settings::served(libraries::list(&conn)?).iter().any(|l| settings::same_root(&l.root, root)) {
            return Err(bad(format!("{root} isn't one of the server's libraries")));
        }
    }
    let updated = settings::update(|l| {
        if let Some(root) = upload_library {
            l.upload_library = (!root.is_empty()).then_some(root);
        }
        if let Some(model) = caption_model {
            l.caption_model = (!model.is_empty()).then_some(model);
        }
        if let Some(url) = ollama_url {
            l.ollama_url = (!url.is_empty()).then_some(url);
        }
        Ok(())
    })?;
    host.jobs.set_caption_model(updated.caption_model.clone());
    ai::set_ollama_url(updated.ollama_url.as_deref().unwrap_or(""));
    settings_view(host)
}

// The folders in a folder on the server, to pick a library from (no path: the drives, or the usual places
// on Linux). Hidden folders are left out.
pub fn list_folders(path: Option<String>) -> Result<JsonValue, ApiError> {
    let Some(path) = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) else {
        let places: Vec<String> = if cfg!(windows) {
            (b'A'..=b'Z').map(|d| format!("{}:\\", d as char)).filter(|d| Path::new(d).is_dir()).collect()
        } else {
            let user = std::env::var("USER").unwrap_or_default();
            let home = std::env::var("HOME").unwrap_or_default();
            ["/".to_string(), home, "/mnt".into(), "/media".into(), format!("/run/media/{user}"), "/srv".into(), "/photos".into()]
                .into_iter()
                .filter(|p| !p.is_empty() && Path::new(p).is_dir())
                .collect()
        };
        let folders: Vec<JsonValue> = places.iter().map(|p| json!({ "name": p, "path": p })).collect();
        return Ok(json!({ "path": null, "parent": null, "folders": folders }));
    };
    let dir = Path::new(&path);
    let entries = std::fs::read_dir(dir).map_err(|e| bad(format!("Can't open {path}: {e}")))?;
    let mut folders: Vec<(String, String)> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path().to_string_lossy().to_string()))
        .filter(|(name, _)| !name.starts_with('.') && !name.starts_with('$'))
        .collect();
    folders.sort_by_key(|(name, _)| name.to_lowercase());
    let folders: Vec<JsonValue> = folders.into_iter().map(|(name, path)| json!({ "name": name, "path": path })).collect();
    Ok(json!({ "path": path, "parent": dir.parent().map(|p| p.to_string_lossy().to_string()), "folders": folders }))
}
