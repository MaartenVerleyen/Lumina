// Following an album shared with you (docs/plans/one-view.md, milestone 4). Its photos are downloaded into a
// folder on this PC (a library of yours) or relayed to a library on a server of yours where you may upload,
// with their tags and people names (as you call those people); the sharer's ratings, flags and labels stay
// theirs. New photos in the album follow when the server says albums or shares changed, when its event socket
// (re)connects and when the app starts. A photo taken out of the album stays; when the album is no longer
// shared with you the follow ends and the photos stay. The follows are this device's (client.db).
use crate::client_db;
use crate::remote::{self, remote};
use crate::transfers;
use crate::*;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

fn open(app: &AppHandle) -> Result<Connection, String> {
    let conn = client_db::open(app)?;
    ensure_tables(&conn)?;
    Ok(conn)
}

// The follows of this device (also the phone's background pass, which has no window: phone_backup.rs)
pub fn ensure_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS album_follows (
             server TEXT NOT NULL,
             album_id INTEGER NOT NULL,
             album_name TEXT NOT NULL,
             -- Where the photos land; for a server target, the folder they wait in until uploaded
             folder TEXT NOT NULL,
             upload_to TEXT,
             created_at INTEGER NOT NULL,
             PRIMARY KEY (server, album_id)
         );
         -- The album's photos already taken (downloaded, queued, or here already)
         CREATE TABLE IF NOT EXISTS follow_photos (
             server TEXT NOT NULL,
             album_id INTEGER NOT NULL,
             hash TEXT NOT NULL,
             PRIMARY KEY (server, album_id, hash)
         );",
    )
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct Follow {
    server: String,
    album_id: i64,
    album_name: String,
    folder: String,
    upload_to: Option<String>,
    // Photos taken so far
    photos: usize,
}

fn follows(conn: &Connection) -> Result<Vec<Follow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.server, f.album_id, f.album_name, f.folder, f.upload_to,
                    (SELECT COUNT(*) FROM follow_photos p WHERE p.server = f.server AND p.album_id = f.album_id)
             FROM album_follows f ORDER BY f.album_name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Follow {
                server: r.get(0)?,
                album_id: r.get(1)?,
                album_name: r.get(2)?,
                folder: r.get(3)?,
                upload_to: r.get(4)?,
                photos: r.get::<_, i64>(5)? as usize,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn album_follows(app: AppHandle) -> Result<Vec<Follow>, String> {
    follows(&open(&app)?)
}

// Follow an album of `server`: into `folder` on this PC, or (upload_to) into that server's upload library
#[tauri::command]
pub async fn follow_album(
    app: AppHandle,
    server: String,
    album_id: i64,
    album_name: String,
    folder: Option<String>,
    upload_to: Option<String>,
) -> Result<(), String> {
    remote(&app).server(&server)?;
    let folder = match (&upload_to, folder) {
        (Some(target), _) => {
            remote(&app).server(target)?;
            get_app_storage_dir(&app).join("follow-staging").join(remote::safe(&server)).join(album_id.to_string()).to_string_lossy().to_string()
        }
        (None, Some(f)) if !f.trim().is_empty() => f,
        _ => return Err("Choose a folder for the album's photos".into()),
    };
    fs::create_dir_all(&folder).map_err(|e| format!("Can't make {folder}: {e}"))?;
    if upload_to.is_none() {
        // The folder is part of your libraries (a library of its own unless it lies in one)
        lumina_core::libraries::open(&open_global_db(&app)?, &folder)?;
    }
    open(&app)?
        .execute(
            "INSERT OR REPLACE INTO album_follows (server, album_id, album_name, folder, upload_to, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))",
            params![server, album_id, album_name, folder, upload_to],
        )
        .map_err(|e| e.to_string())?;
    nudge(&app);
    Ok(())
}

// New downloads stop; what came stays
#[tauri::command]
pub fn unfollow_album(app: AppHandle, server: String, album_id: i64) -> Result<(), String> {
    let conn = open(&app)?;
    conn.execute("DELETE FROM album_follows WHERE server = ?1 AND album_id = ?2", params![server, album_id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM follow_photos WHERE server = ?1 AND album_id = ?2", params![server, album_id]).map_err(|e| e.to_string())?;
    Ok(())
}

// A follow of the phone app: its photos go into this folder of the phone's gallery (`phone:Pictures/Lumina/<album>`)
pub const PHONE_FOLLOW: &str = "phone:";

static SYNCING: AtomicBool = AtomicBool::new(false);
static AGAIN: AtomicBool = AtomicBool::new(false);

// Look at the followed albums soon (a burst of events is one look). The phone's follows are its background
// worker's: it runs for them now.
pub fn nudge(app: &AppHandle) {
    #[cfg(target_os = "android")]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let followed = open(&app)
                .and_then(|c| c.query_row("SELECT COUNT(*) FROM album_follows WHERE folder LIKE 'phone:%'", [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string()))
                .unwrap_or(0);
            if followed > 0 {
                let _ = crate::android::call(&app, "backupNow", json!({ "followsOnly": true }));
            }
        });
    }
    if SYNCING.swap(true, Ordering::SeqCst) {
        AGAIN.store(true, Ordering::SeqCst);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            AGAIN.store(false, Ordering::SeqCst);
            if let Err(e) = sync(&app).await {
                eprintln!("[follow] {e}");
            }
            if !AGAIN.load(Ordering::SeqCst) {
                break;
            }
        }
        SYNCING.store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
pub fn sync_follows(app: AppHandle) {
    nudge(&app);
}

async fn call(app: &AppHandle, server: &str, command: &str, args: Value) -> Result<Value, String> {
    remote::server_call(app.clone(), server.to_string(), command.to_string(), Some(args), None).await
}

async fn sync(app: &AppHandle) -> Result<(), String> {
    let list = follows(&open(app)?)?;
    let mut ended = Vec::new();
    for f in list {
        // The phone's follows land in its gallery: its background pass takes them (phone_backup.rs)
        if remote(app).token(&f.server).is_none() || f.folder.starts_with(PHONE_FOLLOW) {
            continue;
        }
        // An unreachable server is looked at again next time
        let Ok(albums) = call(app, &f.server, "get_albums", json!({})).await else { continue };
        let Some(album) = albums.as_array().and_then(|a| a.iter().find(|a| a["id"].as_i64() == Some(f.album_id))) else {
            // No longer shared with you: the follow ends, the photos stay
            unfollow_album(app.clone(), f.server.clone(), f.album_id)?;
            ended.push(f.album_name.clone());
            continue;
        };
        let hashes: Vec<String> = album["hashes"].as_array().map(|h| h.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let conn = open(app)?;
        let taken: HashSet<String> = {
            let mut stmt = conn.prepare("SELECT hash FROM follow_photos WHERE server = ?1 AND album_id = ?2").map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![f.server, f.album_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };
        let mut new: Vec<String> = hashes.into_iter().filter(|h| !taken.contains(h)).collect();
        if f.upload_to.is_none() {
            // Photos your library has already aren't downloaded again
            let library = open_global_db(app)?;
            let mut here = library.prepare("SELECT 1 FROM photos WHERE hash = ?1").map_err(|e| e.to_string())?;
            let (have, need): (Vec<String>, Vec<String>) = new.into_iter().partition(|h| here.exists([h]).unwrap_or(false));
            for h in have {
                conn.execute("INSERT OR IGNORE INTO follow_photos (server, album_id, hash) VALUES (?1, ?2, ?3)", params![f.server, f.album_id, h])
                    .map_err(|e| e.to_string())?;
            }
            new = need;
        }
        if new.is_empty() {
            continue;
        }
        let photos = call(app, &f.server, "get_photos", json!({ "hashes": new })).await?;
        let values = call(app, &f.server, "photo_values", json!({ "hashes": new })).await.unwrap_or(json!([]));
        let values: HashMap<String, Value> = values
            .as_array()
            .map(|v| v.iter().filter_map(|m| Some((m["hash"].as_str()?.to_string(), m.clone()))).collect())
            .unwrap_or_default();
        let items: Vec<transfers::FollowedPhoto> = photos
            .as_array()
            .map(|p| {
                p.iter()
                    .filter_map(|p| {
                        let hash = p["hash"].as_str()?.to_string();
                        Some(transfers::FollowedPhoto {
                            name: p["name"].as_str().unwrap_or(&hash).to_string(),
                            values: values.get(&hash).cloned(),
                            hash,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        println!("[follow] {}: {} new photo(s)", f.album_name, items.len());
        for item in &items {
            conn.execute("INSERT OR IGNORE INTO follow_photos (server, album_id, hash) VALUES (?1, ?2, ?3)", params![f.server, f.album_id, item.hash])
                .map_err(|e| e.to_string())?;
        }
        transfers::download_followed(app, &f.server, items, &f.folder, f.upload_to.clone())?;
    }
    if !ended.is_empty() {
        let _ = app.emit("follows-ended", json!({ "albums": ended }));
    }
    Ok(())
}
