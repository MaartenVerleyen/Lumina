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
         );",
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
