// The phone app without a connection (docs/plans/android.md, milestone 4). The window keeps the last list of each
// server library here, opens from them and shows them when a server is out of reach, and asks for the new ones
// meanwhile. Thumbnails the grid has shown stay in the server cache (remote.rs); Keep all
// thumbnails fills that cache with every thumbnail of a library, in the background, while the app is open.
use crate::remote;
use crate::*;
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::{LazyLock, Mutex};

fn lists_dir(app: &AppHandle) -> PathBuf {
    get_app_storage_dir(app).join("offline")
}

fn list_file(app: &AppHandle, key: &str) -> PathBuf {
    lists_dir(app).join(format!("{}.json", remote::safe(key)))
}

// A list the window shows (a server library's photos, the server's libraries), kept for the next time
#[tauri::command]
pub async fn offline_save(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = list_file(&app, &key);
        fs::create_dir_all(lists_dir(&app)).map_err(|e| e.to_string())?;
        let tmp = file.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &file).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// The list as last kept, and when (seconds since 1970); null when there is none
#[tauri::command]
pub async fn offline_load(app: AppHandle, key: String) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = list_file(&app, &key);
        let Ok(bytes) = fs::read(&file) else { return Ok(None) };
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let at = fs::metadata(&file).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
        Ok(Some(serde_json::json!({ "value": value, "at": at.map(|d| d.as_secs()).unwrap_or(0) })))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Keep all thumbnails: how far it is
#[derive(Serialize, Clone, Default)]
pub struct KeepProgress {
    // The server whose thumbnails these are
    server: String,
    running: bool,
    total: usize,
    done: usize,
    // Already kept before this run
    had: usize,
    failed: usize,
    error: Option<String>,
}

static KEEP: LazyLock<Mutex<KeepProgress>> = LazyLock::new(|| Mutex::new(KeepProgress::default()));
static KEEP_STOP: AtomicBool = AtomicBool::new(false);

// A thumbnail takes about this much (the cache is raised to hold them all)
const THUMB_KB: u64 = 50;

// Every thumbnail of these photos into the cache, four at a time; already kept ones are skipped
#[tauri::command]
pub fn keep_thumbs(app: AppHandle, server: String, hashes: Vec<String>) -> Result<(), String> {
    {
        let mut p = KEEP.lock().unwrap();
        if p.running {
            return Ok(());
        }
        *p = KeepProgress { server: server.clone(), running: true, total: hashes.len(), ..Default::default() };
    }
    KEEP_STOP.store(false, Ordering::SeqCst);
    remote::raise_cache_limit(&app, hashes.len() as u64 * THUMB_KB / 1024 + 512)?;
    tauri::async_runtime::spawn(async move {
        futures_util::stream::iter(hashes)
            .for_each_concurrent(4, |hash| {
                let (app, server) = (&app, &server);
                async move {
                    if KEEP_STOP.load(Ordering::SeqCst) {
                        return;
                    }
                    let outcome = remote::cache_thumb(app, server, &hash).await;
                    let mut p = KEEP.lock().unwrap();
                    match outcome {
                        Ok(true) => p.done += 1,
                        Ok(false) => p.had += 1,
                        Err(e) => {
                            p.failed += 1;
                            p.error = Some(e);
                            // Out of reach: no use asking for the rest now
                            if p.failed >= 20 && p.done == 0 {
                                KEEP_STOP.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                }
            })
            .await;
        KEEP.lock().unwrap().running = false;
    });
    Ok(())
}

#[tauri::command]
pub fn keep_thumbs_progress() -> KeepProgress {
    KEEP.lock().unwrap().clone()
}

#[tauri::command]
pub fn stop_keep_thumbs() {
    KEEP_STOP.store(true, Ordering::SeqCst);
}
