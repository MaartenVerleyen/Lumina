// The phone's backup to a server (docs/plans/android.md, milestone 3). Android runs it in the background
// (BackupWorker in Backup.kt, also with the app closed) and calls `pass` with the media store's list; Back up now
// in the app starts the same worker. A pass reads the content id of each new photo (phone.rs keeps them), asks
// the server which ones it lacks, and uploads those two at a time with the desktop's protocol (transfer.rs:
// resumable, BLAKE3-checked). Photos the server has are remembered in client.db (`phone_backup`), so a pass after
// that only looks at new photos. The server files uploads in uploads/<user>/ and analyses them itself.
use crate::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Progress {
    running: bool,
    // "Reading new photos", "Asking cachy what it already has", "Uploading"
    stage: String,
    // Photos to upload in this pass, and how far it is with them
    files: usize,
    done: usize,
    failed: usize,
    bytes_total: u64,
    bytes_done: u64,
    current: Vec<String>,
    // The content ids of the photos in flight (the grid shows them uploading)
    uploading: Vec<String>,
    failures: Vec<(String, String)>,
}

// How the last pass ended (phone-backup.json in the app's data folder)
#[derive(Serialize, Deserialize, Clone, Default)]
struct Last {
    at: i64,
    server: String,
    uploaded: usize,
    failed: usize,
    // "done", "retry: <why>" (Android tries again later), "signed-out", "error: <why>"
    outcome: String,
}

#[derive(Serialize)]
pub struct Status {
    progress: Progress,
    // A Back up now Android hasn't started yet (it waits for Wi-Fi when that is set)
    waiting: bool,
    last: Option<Last>,
    // Of the phone's photos (and videos when they are backed up too): how many the server has
    backed_up: usize,
    total: usize,
}

#[cfg(target_os = "android")]
mod imp {
    use super::*;
    use crate::android::PhoneMedia;
    use crate::remote::Remote;
    use crate::transfer::{self, Conn, Failure, UploadFile};
    use crate::{client_db, phone};
    use futures_util::StreamExt;
    use rusqlite::params;
    use std::os::fd::AsRawFd;
    use std::sync::atomic::AtomicU64;
    use std::sync::{LazyLock, Mutex};

    pub const ONLY: &str = "phone-backup-only.json";
    static RUNNING: AtomicBool = AtomicBool::new(false);
    static CANCEL: AtomicBool = AtomicBool::new(false);
    static STATE: LazyLock<Mutex<Progress>> = LazyLock::new(|| Mutex::new(Progress::default()));
    // The files in flight by content id: their name, and the bytes sent so far
    static INFLIGHT: LazyLock<Mutex<HashMap<String, (String, Arc<AtomicU64>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

    fn now() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
    }

    fn update(f: impl FnOnce(&mut Progress)) {
        f(&mut STATE.lock().unwrap());
    }

    pub fn progress() -> Progress {
        let mut p = STATE.lock().unwrap().clone();
        let inflight = INFLIGHT.lock().unwrap();
        p.bytes_done += inflight.values().map(|(_, b)| b.load(Ordering::Relaxed)).sum::<u64>();
        p.current = inflight.values().map(|(name, _)| name.clone()).collect();
        p.uploading = inflight.keys().cloned().collect();
        p
    }

    pub fn cancel() {
        CANCEL.store(true, Ordering::SeqCst);
    }

    pub fn ensure_table(conn: &rusqlite::Connection) -> Result<(), String> {
        phone::ensure_table(conn)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS phone_backup (
                 server TEXT NOT NULL,
                 hash TEXT NOT NULL,
                 at INTEGER NOT NULL,
                 PRIMARY KEY (server, hash)
             );",
        )
        .map_err(|e| e.to_string())
    }

    fn remember(conn: &rusqlite::Connection, server: &str, hash: &str) {
        let _ = conn.execute("INSERT OR IGNORE INTO phone_backup (server, hash, at) VALUES (?1, ?2, ?3)", params![server, hash, now()]);
    }

    // `selection`: a Back up for chosen photos; with none left to do it does nothing (never a whole backup)
    pub fn pass(dir: &Path, server: &str, media: &str, videos: bool, folders: &[String], selection: bool) -> String {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return "busy".into();
        }
        CANCEL.store(false, Ordering::SeqCst);
        *STATE.lock().unwrap() = Progress { running: true, stage: "Looking for new photos".into(), ..Default::default() };
        let outcome = run(dir, server, media, videos, folders, selection).unwrap_or_else(|e| e);
        let p = STATE.lock().unwrap().clone();
        let last = Last { at: now(), server: server.to_string(), uploaded: p.done, failed: p.failed, outcome: outcome.clone() };
        if let Ok(bytes) = serde_json::to_vec(&last) {
            let _ = fs::write(dir.join("phone-backup.json"), bytes);
        }
        update(|p| {
            p.running = false;
            p.stage.clear();
        });
        RUNNING.store(false, Ordering::SeqCst);
        outcome
    }

    fn failure(f: Failure) -> String {
        match f {
            Failure::Network(e) => format!("retry: {e}"),
            Failure::SignedOut => "signed-out".into(),
            Failure::Refused(e) => format!("error: {e}"),
            Failure::Cancelled => "done".into(),
        }
    }

    fn run(dir: &Path, server: &str, media: &str, videos: bool, folders: &[String], selection: bool) -> Result<String, String> {
        let only = read_only(dir);
        if selection && only.is_none() {
            return Ok("done".into());
        }
        #[allow(unused_mut)]
        let mut media: Vec<PhoneMedia> = serde_json::from_str::<Vec<PhoneMedia>>(media)
            .map_err(|e| format!("error: the phone's list of photos: {e}"))?
            .into_iter()
            .filter(|m| videos || !m.video)
            .collect();
        // Debug builds only: a test backs up just the newest few (phone-backup-limit holds how many); a selection
        // (Back up for chosen photos) is never cut short
        #[cfg(debug_assertions)]
        if let Some(limit) = fs::read_to_string(dir.join("phone-backup-limit"))
            .ok()
            .and_then(|s| s.trim().parse::<usize>().ok())
            .filter(|_| only.is_none())
        {
            media.sort_by_key(|m| std::cmp::Reverse(if m.taken > 0 { m.taken / 1000 } else { m.modified }));
            media.truncate(limit);
        }
        let conn = client_db::open_at(dir).map_err(|e| format!("error: {e}"))?;
        ensure_table(&conn).map_err(|e| format!("error: {e}"))?;

        // 1. The content id of each photo (read once, for photos new since the app last saw them)
        let unknown = media.iter().filter(|m| phone::known_id(&conn, m).is_none()).count();
        let mut read = 0;
        let mut photos: Vec<(PhoneMedia, String)> = Vec::with_capacity(media.len());
        for m in media {
            if CANCEL.load(Ordering::SeqCst) {
                return Ok("done".into());
            }
            let hash = match phone::known_id(&conn, &m) {
                Some(hash) => hash,
                None => {
                    read += 1;
                    update(|p| p.stage = format!("Reading new photos ({read} of {unknown})"));
                    match phone::read_id(&conn, &m) {
                        Ok(hash) => hash,
                        Err(e) => {
                            eprintln!("[backup] {}: {e}", m.name);
                            continue;
                        }
                    }
                }
            };
            photos.push((m, hash));
        }

        // 2. Those not known to be on the server yet, each once
        let backed: HashSet<String> = {
            let mut stmt = conn.prepare("SELECT hash FROM phone_backup WHERE server = ?1").map_err(|e| format!("error: {e}"))?;
            let rows = stmt.query_map([server], |r| r.get::<_, String>(0)).map_err(|e| format!("error: {e}"))?;
            rows.filter_map(Result::ok).collect()
        };
        // Back up for a selection: only those photos this time (phone-backup-only.json, phone_backup_selected), in
        // whatever folder; else the folders chosen
        let mut seen = HashSet::new();
        let todo: Vec<(PhoneMedia, String)> = photos
            .into_iter()
            .filter(|(m, h)| {
                let wanted = match &only {
                    Some(o) => o.contains(h),
                    None => folders.iter().any(|f| *f == m.folder),
                };
                wanted && !backed.contains(h) && seen.insert(h.clone())
            })
            .collect();
        if todo.is_empty() {
            forget_only(dir, only.as_ref());
            return Ok("done".into());
        }

        let remote = Remote::load(dir.to_path_buf());
        let entry = remote.server(server).map_err(|e| format!("error: {e}"))?;
        let Some(token) = remote.token(server) else { return Ok("signed-out".into()) };
        let conn_server = Conn { http: remote.http.clone(), base: entry.url.clone(), token };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| format!("error: {e}"))?;
        let label = crate::remote::label_of(server);
        let outcome = runtime.block_on(send(&conn, &conn_server, server, &label, todo));
        if outcome.as_deref() == Ok("done") {
            forget_only(dir, only.as_ref());
        }
        outcome
    }

    // The photos chosen for a Back up of a selection, still to do
    pub fn read_only(dir: &Path) -> Option<HashSet<String>> {
        fs::read(dir.join(ONLY)).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }

    // A selection done: those photos leave the list; ones chosen meanwhile (a second selection) stay for the
    // next pass
    fn forget_only(dir: &Path, done: Option<&HashSet<String>>) {
        let Some(done) = done else { return };
        let left: Vec<String> = read_only(dir).unwrap_or_default().into_iter().filter(|h| !done.contains(h)).collect();
        if left.is_empty() {
            let _ = fs::remove_file(dir.join(ONLY));
        } else if let Ok(bytes) = serde_json::to_vec(&left) {
            let _ = fs::write(dir.join(ONLY), bytes);
        }
    }

    async fn send(db: &rusqlite::Connection, c: &Conn, server: &str, label: &str, todo: Vec<(PhoneMedia, String)>) -> Result<String, String> {
        // 3. Ask the server which of them it lacks; what it has is remembered
        let mut missing_all = Vec::new();
        for batch in todo.chunks(500) {
            if CANCEL.load(Ordering::SeqCst) {
                return Ok("done".into());
            }
            update(|p| p.stage = format!("Asking {label} what it already has"));
            let files: Vec<(String, u64, String)> = batch.iter().map(|(m, h)| (h.clone(), m.size, m.name.clone())).collect();
            let missing: HashSet<String> = transfer::check_missing(c, &files).await.map_err(failure)?.into_iter().collect();
            for (m, hash) in batch {
                if missing.contains(hash) {
                    missing_all.push((m.clone(), hash.clone()));
                } else {
                    remember(db, server, hash);
                }
            }
        }
        if missing_all.is_empty() {
            return Ok("done".into());
        }

        // 4. Send what's missing, two at a time
        update(|p| {
            p.stage = "Uploading".into();
            p.files = missing_all.len();
            p.bytes_total = missing_all.iter().map(|(m, _)| m.size).sum();
        });
        let outcome: Mutex<Option<String>> = Mutex::new(None);
        let landed: Mutex<Vec<String>> = Mutex::new(Vec::new());
        futures_util::stream::iter(missing_all)
            .for_each_concurrent(2, |(m, hash)| {
                let (outcome, landed) = (&outcome, &landed);
                async move {
                    if CANCEL.load(Ordering::SeqCst) || outcome.lock().unwrap().is_some() {
                        return;
                    }
                    let sent = Arc::new(AtomicU64::new(0));
                    INFLIGHT.lock().unwrap().insert(hash.clone(), (m.name.clone(), sent.clone()));
                    let result = upload(c, &m, &hash, &sent).await;
                    INFLIGHT.lock().unwrap().remove(&hash);
                    match result {
                        Ok(()) => {
                            landed.lock().unwrap().push(hash);
                            update(|p| {
                                p.done += 1;
                                p.bytes_done += m.size;
                            });
                        }
                        Err(Failure::Refused(e)) => update(|p| {
                            p.failed += 1;
                            if p.failures.len() < 50 {
                                p.failures.push((m.name.clone(), e));
                            }
                        }),
                        Err(Failure::Cancelled) => {}
                        Err(f) => {
                            outcome.lock().unwrap().get_or_insert(failure(f));
                        }
                    }
                }
            })
            .await;
        for hash in landed.into_inner().unwrap() {
            remember(db, server, &hash);
        }
        Ok(outcome.into_inner().unwrap().unwrap_or_else(|| "done".into()))
    }

    async fn upload(c: &Conn, m: &PhoneMedia, hash: &str, sent: &AtomicU64) -> Result<(), Failure> {
        let file = crate::android::open_media(m.id, m.video).map_err(Failure::Refused)?;
        // transfer.rs reads files by path: the open file's own path, so it is this file whatever its name
        let path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
        let size = file.metadata().map(|meta| meta.len()).map_err(|e| Failure::Refused(e.to_string()))?;
        if size != m.size {
            return Err(Failure::Refused("The photo changed since the phone listed it".into()));
        }
        let read = path.clone();
        let full_hash = tokio::task::spawn_blocking(move || transfer::file_blake3(&read))
            .await
            .map_err(|e| Failure::Refused(e.to_string()))?
            .map_err(|e| Failure::Refused(format!("Couldn't read the photo: {e}")))?;
        // The date it was taken, else its file's date
        let modified = if m.taken > 0 { m.taken / 1000 } else { m.modified };
        let upload = UploadFile { path: &path, name: &m.name, size, hash, full_hash: &full_hash, modified };
        transfer::upload_one(c, &upload, sent, &CANCEL, "phone-backup").await?;
        drop(file);
        Ok(())
    }

    pub fn status(dir: &Path, server: &str, videos: bool, folders: &[String]) -> Result<Status, String> {
        let conn = client_db::open_at(dir)?;
        ensure_table(&conn)?;
        let folders = serde_json::to_string(folders).unwrap_or_default();
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT hash) FROM phone_media WHERE (?1 OR video = 0) AND folder IN (SELECT value FROM json_each(?2))",
                params![videos, folders],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let backed_up: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT m.hash) FROM phone_media m JOIN phone_backup b ON b.hash = m.hash AND b.server = ?2
                 WHERE (?1 OR m.video = 0) AND m.folder IN (SELECT value FROM json_each(?3))",
                params![videos, server, folders],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let last = fs::read(dir.join("phone-backup.json")).ok().and_then(|b| serde_json::from_slice::<Last>(&b).ok()).filter(|l| l.server == server);
        Ok(Status { progress: progress(), waiting: false, last, backed_up: backed_up as usize, total: total as usize })
    }

    // The phone's folders: how many photos each holds, how many of them `server` has, the newest as its cover,
    // and their content ids (the Albums tab opens a folder with them)
    pub fn folders(dir: &Path, server: Option<&str>) -> Result<Vec<Folder>, String> {
        let conn = client_db::open_at(dir)?;
        ensure_table(&conn)?;
        let mut stmt = conn
            .prepare(
                "SELECT m.folder, m.id, m.video, m.modified, m.hash, b.hash IS NOT NULL
                 FROM phone_media m LEFT JOIN phone_backup b ON b.hash = m.hash AND b.server = ?1
                 ORDER BY m.modified DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([server.unwrap_or("")], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, bool>(2)?, r.get::<_, String>(4)?, r.get::<_, bool>(5)?))
            })
            .map_err(|e| e.to_string())?;
        let mut by_folder: Vec<Folder> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for (folder, id, video, hash, backed) in rows.filter_map(Result::ok) {
            let i = *index.entry(folder.clone()).or_insert_with(|| {
                by_folder.push(Folder {
                    name: folder_name(&folder),
                    cover: format!("phone:{}:{id}", if video { "v" } else { "p" }),
                    folder,
                    count: 0,
                    backed_up: 0,
                    hashes: Vec::new(),
                });
                by_folder.len() - 1
            });
            let f = &mut by_folder[i];
            f.count += 1;
            if backed {
                f.backed_up += 1;
            }
            f.hashes.push(hash);
        }
        // The same name in two places ("Screenshots" in DCIM and in Pictures): the folder above it tells them apart
        let mut names: HashMap<String, usize> = HashMap::new();
        for f in &by_folder {
            *names.entry(f.name.clone()).or_default() += 1;
        }
        for f in by_folder.iter_mut().filter(|f| names[&f.name] > 1) {
            let mut parts = f.folder.trim_end_matches('/').rsplit('/');
            let (name, parent) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            if !parent.is_empty() {
                f.name = format!("{parent} / {name}");
            }
        }
        by_folder.sort_by(|a, b| b.count.cmp(&a.count));
        Ok(by_folder)
    }

    // "DCIM/Camera/" → "Camera", ".../WhatsApp/Media/WhatsApp Images/" → "WhatsApp Images"
    fn folder_name(folder: &str) -> String {
        let name = folder.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        if name.is_empty() { "Phone".to_string() } else { name.to_string() }
    }
}

// A folder of the phone (Albums, the backup's choice of folders)
#[derive(Serialize)]
pub struct Folder {
    folder: String,
    name: String,
    count: usize,
    backed_up: usize,
    // The newest photo's path, for its thumbnail
    cover: String,
    hashes: Vec<String>,
}

// The phone's folders, with how many `server` has of each
#[tauri::command]
pub fn phone_folders(app: AppHandle, server: Option<String>) -> Result<Vec<Folder>, String> {
    #[cfg(target_os = "android")]
    {
        imp::folders(&get_app_storage_dir(&app), server.as_deref())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, server);
        Ok(Vec::new())
    }
}

#[cfg(target_os = "android")]
pub use imp::{cancel, pass, progress};

// Settings → Backup: how far the phone's backup to `server` is
// Off the main thread: the window asks every second, also while it is busy loading All photos
#[tauri::command]
pub async fn phone_backup_status(app: AppHandle, server: String, videos: bool, folders: Vec<String>) -> Result<Status, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let mut status = imp::status(&get_app_storage_dir(&app), &server, videos, &folders)?;
            if !status.progress.running {
                status.waiting = crate::android::call(&app, "backupWaiting", serde_json::json!({}))
                    .map(|a| a["waiting"].as_bool().unwrap_or(false))
                    .unwrap_or(false);
            }
            Ok(status)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, server, videos, folders);
        Err("Backing up a phone is the phone app's".into())
    }
}

// The backup's settings (kept by Android: Backup.kt): enabled, server, wifiOnly, charging, videos
#[tauri::command]
pub fn phone_backup_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        crate::android::call(&app, "backupSettings", serde_json::json!({}))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Backing up a phone is the phone app's".into())
    }
}

#[tauri::command]
pub fn set_phone_backup(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::android::call(&app, "setBackup", settings).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, settings);
        Err("Backing up a phone is the phone app's".into())
    }
}

// Back up now (on Wi-Fi only when that is set, unless `any_network`)
#[tauri::command]
pub fn phone_backup_now(app: AppHandle, any_network: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::android::call(&app, "backupNow", serde_json::json!({ "anyNetwork": any_network })).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, any_network);
        Err("Backing up a phone is the phone app's".into())
    }
}

// Back up for a selection: these photos now, also when they are in a folder the backup leaves out
#[tauri::command]
pub fn phone_backup_selected(app: AppHandle, hashes: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        // Added to photos chosen before and not done yet
        let dir = get_app_storage_dir(&app);
        let mut all = imp::read_only(&dir).unwrap_or_default();
        all.extend(hashes);
        let bytes = serde_json::to_vec(&all).map_err(|e| e.to_string())?;
        fs::write(dir.join(imp::ONLY), bytes).map_err(|e| e.to_string())?;
        crate::android::call(&app, "backupNow", serde_json::json!({ "anyNetwork": false, "selection": true })).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, hashes);
        Err("Backing up a phone is the phone app's".into())
    }
}

#[tauri::command]
pub fn phone_backup_stop() {
    #[cfg(target_os = "android")]
    imp::cancel();
}
