// Which photos of a server are on this computer ("On this device"). The client keeps its own small database
// (client.db in the app's data folder), never touching the library database: a row per file downloaded from
// or uploaded to a server. A photo also counts when a local library has the same content (its content hash),
// so a copy that moved into a library folder is found again once that folder is scanned.
use crate::remote;
use crate::*;
use rusqlite::{params, Connection};
use serde::Serialize;

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn open(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(get_app_storage_dir(app).join("client.db")).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS local_copies (
             server TEXT NOT NULL,
             hash TEXT NOT NULL,
             path TEXT NOT NULL,
             size INTEGER NOT NULL,
             verified_at INTEGER NOT NULL,
             PRIMARY KEY (server, hash, path)
         );
         -- The basket of this device, for photos of any library, here or on a server: it is never sent
         -- to a server, so each device (and each person) has their own
         CREATE TABLE IF NOT EXISTS basket (hash TEXT PRIMARY KEY);
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn add_copy(app: &AppHandle, server: &str, hash: &str, path: &Path, size: u64) -> Result<(), String> {
    open(app)?
        .execute(
            "INSERT OR REPLACE INTO local_copies (server, hash, path, size, verified_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![server, hash, path.to_string_lossy(), size as i64, now()],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

// The copies recorded for a server whose file is still there with its size; rows of files that moved or
// changed are dropped
fn copies(conn: &Connection, server: &str) -> Result<Vec<(String, PathBuf)>, String> {
    let mut stmt = conn.prepare("SELECT hash, path, size FROM local_copies WHERE server = ?1").map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, i64)> = stmt
        .query_map([server], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    let mut kept = Vec::new();
    for (hash, path, size) in rows {
        let ok = fs::metadata(&path).map(|m| m.len() == size as u64).unwrap_or(false);
        if ok {
            kept.push((hash, Path::new(&path).components().collect()));
        } else {
            let _ = conn.execute("DELETE FROM local_copies WHERE server = ?1 AND hash = ?2 AND path = ?3", params![server, hash, path]);
        }
    }
    Ok(kept)
}

// Of these photos of the server, the ones on this computer
#[tauri::command]
pub async fn on_device(app: AppHandle, server: String, hashes: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let wanted: HashSet<String> = hashes.into_iter().collect();
        let mut found: HashSet<String> = copies(&open(&app)?, &server)?.into_iter().map(|c| c.0).filter(|h| wanted.contains(h)).collect();
        // The same content in a library on this computer
        let library = open_global_db(&app)?;
        let mut stmt = library.prepare("SELECT 1 FROM photos WHERE hash = ?1").map_err(|e| e.to_string())?;
        for h in &wanted {
            if !found.contains(h) && stmt.exists([h]).unwrap_or(false) {
                found.insert(h.clone());
            }
        }
        Ok(found.into_iter().collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct RemovedCopies {
    removed: usize,
    // Photos the server doesn't have (or this user can't see there): their copies stay
    kept_not_on_server: usize,
    // Photos whose only copy here is in a library folder: Lumina doesn't remove library files this way
    in_library: usize,
    failed: Vec<String>,
}

// Moves the downloaded or uploaded copies of these photos to the Recycle Bin, only for photos the server
// has. The server's file is never touched.
#[tauri::command]
pub async fn remove_local_copies(app: AppHandle, server: String, hashes: Vec<String>) -> Result<RemovedCopies, String> {
    let on_server: Vec<String> = serde_json::from_value(
        remote::server_call(app.clone(), server.clone(), "content_hashes".into(), Some(serde_json::json!({ "hashes": hashes })), None).await?,
    )
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let on_server: HashSet<String> = on_server.into_iter().collect();
        let wanted: HashSet<&String> = hashes.iter().collect();
        let conn = open(&app)?;
        let all = copies(&conn, &server)?;
        let mut paths = Vec::new();
        let mut with_copy = HashSet::new();
        for (hash, path) in &all {
            if wanted.contains(hash) && on_server.contains(hash) {
                paths.push(path.clone());
                with_copy.insert(hash.clone());
            }
        }
        let kept_not_on_server = hashes.iter().filter(|h| !on_server.contains(*h)).count();
        let in_library = hashes.iter().filter(|h| on_server.contains(*h) && !with_copy.contains(*h)).count();
        let outcome = recycle::recycle(&paths);
        for p in &outcome.gone {
            let _ = conn.execute("DELETE FROM local_copies WHERE server = ?1 AND path = ?2", params![server, p.to_string_lossy()]);
        }
        Ok(RemovedCopies {
            removed: outcome.gone.len(),
            kept_not_on_server,
            in_library,
            failed: outcome.failed.iter().map(|(p, why)| format!("{}: {why}", p.display())).collect(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// The photos in this device's basket. The first time, the basket of the libraries on this computer (kept in
// the library database before) moves in.
#[tauri::command]
pub fn device_basket(app: AppHandle) -> Result<Vec<String>, String> {
    let conn = open(&app)?;
    let moved: bool = conn.query_row("SELECT 1 FROM meta WHERE key = 'basket_moved'", [], |_| Ok(true)).unwrap_or(false);
    if !moved {
        let library = open_global_db(&app)?;
        let mut stmt = library.prepare("SELECT hash FROM photos WHERE in_basket = 1").map_err(|e| e.to_string())?;
        let hashes: Vec<String> = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
        for h in &hashes {
            conn.execute("INSERT OR IGNORE INTO basket (hash) VALUES (?1)", [h]).map_err(|e| e.to_string())?;
        }
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('basket_moved', '1')", []).map_err(|e| e.to_string())?;
    }
    let mut stmt = conn.prepare("SELECT hash FROM basket").map_err(|e| e.to_string())?;
    let hashes = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
    Ok(hashes)
}

#[tauri::command]
pub fn set_device_basket(app: AppHandle, hashes: Vec<String>, in_basket: bool) -> Result<(), String> {
    let mut conn = open(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for h in &hashes {
        let sql = if in_basket { "INSERT OR IGNORE INTO basket (hash) VALUES (?1)" } else { "DELETE FROM basket WHERE hash = ?1" };
        tx.execute(sql, [h]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

// The libraries on this computer (every folder opened here): All photos shows them unless taken off its list
#[tauri::command]
pub fn local_libraries(app: AppHandle) -> Result<Vec<lumina_core::libraries::Library>, String> {
    lumina_core::libraries::list(&open_global_db(&app)?)
}

// A library on this computer as its database has it, without walking the folder: All photos lists every
// library this way (a scan of one folder would stop another's scan and thumbnail pass)
#[tauri::command]
pub async fn list_local_library(app: AppHandle, root: String) -> Result<Vec<PhotoItem>, String> {
    tauri::async_runtime::spawn_blocking(move || scan::list_library_photos(&app, &root)).await.map_err(|e| e.to_string())?
}

// Files on this PC that are a copy of a server's photo under another id: a second copy of a file on this PC
// gets a path-salted id, while the server knows it by its content. The upload queue records which server
// photo each file is (uploaded, or found there already); All photos shows such a pair as one photo.
// Answers (id here, id on the server).
#[tauri::command]
pub async fn local_copy_ids(app: AppHandle) -> Result<Vec<(String, String)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let servers: Vec<String> = {
            let mut stmt = conn.prepare("SELECT DISTINCT server FROM local_copies").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok).collect()
        };
        let library = open_global_db(&app)?;
        let mut here = library.prepare("SELECT hash FROM photos WHERE current_path = ?1").map_err(|e| e.to_string())?;
        let mut pairs = Vec::new();
        for server in servers {
            for (hash, path) in copies(&conn, &server)? {
                if let Ok(own) = here.query_row([path.to_string_lossy()], |r| r.get::<_, String>(0)) {
                    if own != hash {
                        pairs.push((own, hash));
                    }
                }
            }
        }
        Ok(pairs)
    })
    .await
    .map_err(|e| e.to_string())?
}
