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

// A server library's photos, kept by the app itself as the server's answer came (remote.rs, rpc_text): the
// same file the window reads with offline_load. Next to it the tag the server gave that list, when it gave one.
#[derive(Clone)]
pub struct KeptList {
    file: PathBuf,
}

impl KeptList {
    pub fn of(app: &AppHandle, server: &str, root: &str) -> KeptList {
        KeptList { file: list_file(app, &format!("photos:{server}|{root}")) }
    }

    fn tag_file(&self) -> PathBuf {
        self.file.with_extension("etag")
    }

    // The kept list's tag; none without the list itself
    pub fn tag(&self) -> Option<String> {
        if !self.file.is_file() {
            return None;
        }
        fs::read_to_string(self.tag_file()).ok().filter(|t| !t.is_empty())
    }

    // The kept list, which the server just said is still the library: seen now
    pub fn read(&self) -> Option<String> {
        let text = fs::read_to_string(&self.file).ok()?;
        if let Ok(f) = fs::OpenOptions::new().write(true).open(&self.file) {
            let _ = f.set_modified(std::time::SystemTime::now());
        }
        Some(text)
    }

    // Not kept is no error: the next open asks for the whole list. The tag goes first and comes back last, so
    // it never names another list than the one in the file.
    pub fn write(&self, text: &str, tag: Option<&str>) {
        let _ = fs::remove_file(self.tag_file());
        let Some(dir) = self.file.parent() else { return };
        let tmp = self.file.with_extension("tmp");
        if fs::create_dir_all(dir).is_err() || fs::write(&tmp, text).is_err() || fs::rename(&tmp, &self.file).is_err() {
            let _ = fs::remove_file(&tmp);
            return;
        }
        if let Some(tag) = tag {
            let _ = fs::write(self.tag_file(), tag);
        }
    }
}

// A list the window shows (the server's libraries, its names), kept for the next time. A library's photos
// are kept by KeptList above.
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
pub async fn offline_load(app: AppHandle, key: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = list_file(&app, &key);
        // The file is JSON already: it goes to the window as text, not read into a value and written out
        // again (a large library's list is tens of megabytes)
        let Ok(text) = fs::read_to_string(&file) else { return Ok(tauri::ipc::Response::new("null".to_string())) };
        let at = fs::metadata(&file).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
        let at = at.map(|d| d.as_secs()).unwrap_or(0);
        Ok(tauri::ipc::Response::new(["{\"value\":", text.trim(), ",\"at\":", &at.to_string(), "}"].concat()))
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

#[cfg(test)]
mod tests {
    use super::KeptList;

    #[test]
    fn a_kept_list_has_its_tag_only_while_both_are_there() {
        let dir = std::env::temp_dir().join(format!("lumina-kept-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let list = KeptList { file: dir.join("offline").join("photos.json") };
        assert_eq!(list.tag(), None);
        assert_eq!(list.read(), None);

        list.write("[1]", Some("\"a-0\""));
        assert_eq!(list.tag().as_deref(), Some("\"a-0\""));
        assert_eq!(list.read().as_deref(), Some("[1]"));

        // A list that came without a tag (a guest's) takes the old tag away with it
        list.write("[2]", None);
        assert_eq!(list.tag(), None);
        assert_eq!(list.read().as_deref(), Some("[2]"));

        // The tag alone names nothing
        list.write("[3]", Some("\"a-1\""));
        std::fs::remove_file(&list.file).unwrap();
        assert_eq!(list.tag(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
