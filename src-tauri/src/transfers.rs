// The upload and download queues of client mode. Each is a list of files saved in the app's data folder
// (upload-queue.json, download-queue.json), so a closed laptop or a restart carries on where it stopped;
// the server keeps what has arrived of an upload, a download keeps its part file. Two files move at a time.
// When the server can't be reached the queue waits (2 s, 4 s, ... 60 s) and tries again, for as long as it
// takes; a file the server refuses is marked failed with the server's reason. Progress goes to the window
// twice a second as `upload-progress` / `download-progress`.
use crate::client_db;
use crate::remote::{self, remote};
use crate::transfer::{self, Conn, Failure, UploadFile};
use crate::*;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Upload,
    Download,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
enum ItemState {
    Waiting,
    Done,
    // Upload: the server already has it
    Skipped,
    Failed,
}

#[derive(Serialize, Deserialize, Clone)]
struct Item {
    server: String,
    // Upload: the file sent. Download: the file saved, once it is.
    #[serde(default)]
    path: Option<String>,
    // Download: the folder it goes into
    #[serde(default)]
    dir: Option<String>,
    name: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    modified: i64,
    // Lumina's content hash (download: the photo's id on the server)
    #[serde(default)]
    hash: Option<String>,
    #[serde(default)]
    full_hash: Option<String>,
    // Upload: the server was asked whether it has it
    #[serde(default)]
    checked: bool,
    state: ItemState,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize, Clone, Default)]
pub struct Progress {
    running: bool,
    files: usize,
    done: usize,
    skipped: usize,
    failed: usize,
    bytes_total: u64,
    bytes_done: u64,
    // What moves now
    current: Vec<String>,
    // "Reading files", "Asking the server what it has", "Uploading", or why it waits
    stage: String,
    failures: Vec<FailedFile>,
}

#[derive(Serialize, Clone)]
struct FailedFile {
    name: String,
    error: String,
}

pub struct Queue {
    kind: Kind,
    items: Mutex<Vec<Item>>,
    running: AtomicBool,
    cancel: Arc<AtomicBool>,
    dirty: AtomicBool,
    stage: Mutex<String>,
    // Bytes moved so far per file in flight, by the file's place in the list
    inflight: Mutex<HashMap<usize, (String, Arc<AtomicU64>)>>,
    file: PathBuf,
}

pub struct Transfers {
    uploads: Arc<Queue>,
    downloads: Arc<Queue>,
    // This app's name in the server's change events (its own uploads don't need announcing to it)
    pub client_id: String,
}

impl Queue {
    fn load(kind: Kind, file: PathBuf) -> Queue {
        let items: Vec<Item> = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Queue {
            kind,
            items: Mutex::new(items),
            running: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
            dirty: AtomicBool::new(false),
            stage: Mutex::new(String::new()),
            inflight: Mutex::new(HashMap::new()),
            file,
        }
    }

    fn save(&self) {
        let bytes = serde_json::to_vec(&*self.items.lock().unwrap()).unwrap_or_default();
        let tmp = self.file.with_extension("tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, &self.file);
        }
    }

    fn set_stage(&self, stage: impl Into<String>) {
        *self.stage.lock().unwrap() = stage.into();
    }

    fn update(&self, i: usize, f: impl FnOnce(&mut Item)) {
        if let Some(item) = self.items.lock().unwrap().get_mut(i) {
            f(item);
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    fn progress(&self) -> Progress {
        let items = self.items.lock().unwrap();
        let inflight = self.inflight.lock().unwrap();
        let mut p = Progress { running: self.running.load(Ordering::Relaxed), files: items.len(), stage: self.stage.lock().unwrap().clone(), ..Default::default() };
        for (i, item) in items.iter().enumerate() {
            p.bytes_total += item.size;
            match item.state {
                ItemState::Done => {
                    p.done += 1;
                    p.bytes_done += item.size;
                }
                ItemState::Skipped => {
                    p.skipped += 1;
                    p.bytes_done += item.size;
                }
                ItemState::Failed => {
                    p.failed += 1;
                    if p.failures.len() < 50 {
                        p.failures.push(FailedFile { name: item.name.clone(), error: item.error.clone().unwrap_or_default() });
                    }
                }
                ItemState::Waiting => {
                    if let Some((_, sent)) = inflight.get(&i) {
                        p.bytes_done += sent.load(Ordering::Relaxed);
                    }
                }
            }
        }
        p.current = inflight.values().map(|(name, _)| name.clone()).collect();
        p
    }

    fn event(&self) -> &'static str {
        match self.kind {
            Kind::Upload => "upload-progress",
            Kind::Download => "download-progress",
        }
    }
}

pub fn init(app: &AppHandle) -> Transfers {
    let dir = get_app_storage_dir(app);
    let mut bytes = [0u8; 6];
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = (seed >> (i * 8)) as u8 ^ (std::process::id() >> (i % 4 * 8)) as u8;
    }
    Transfers {
        uploads: Arc::new(Queue::load(Kind::Upload, dir.join("upload-queue.json"))),
        downloads: Arc::new(Queue::load(Kind::Download, dir.join("download-queue.json"))),
        client_id: format!("desktop-{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()),
    }
}

fn transfers(app: &AppHandle) -> &Transfers {
    app.state::<Transfers>().inner()
}

// After a restart: carry on with what was waiting
pub fn resume(app: &AppHandle) {
    let t = transfers(app);
    for q in [&t.uploads, &t.downloads] {
        if q.items.lock().unwrap().iter().any(|i| i.state == ItemState::Waiting) {
            start(app, q.clone());
        }
    }
}

fn conn(app: &AppHandle, server: &str) -> Option<Conn> {
    let r = remote(app);
    let entry = r.server(server).ok()?;
    Some(Conn { http: r.http.clone(), base: entry.url, token: r.token(server)? })
}

fn start(app: &AppHandle, q: Arc<Queue>) {
    if q.running.swap(true, Ordering::SeqCst) {
        return;
    }
    q.cancel.store(false, Ordering::SeqCst);
    // Progress twice a second, and the list saved when it changed
    let (app2, q2) = (app.clone(), q.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            let running = q2.running.load(Ordering::SeqCst);
            if q2.dirty.swap(false, Ordering::Relaxed) {
                q2.save();
            }
            let _ = app2.emit(q2.event(), q2.progress());
            if !running {
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut delay = Duration::from_secs(2);
        loop {
            let outcome = match q.kind {
                Kind::Upload => upload_pass(&app2, &q).await,
                Kind::Download => download_pass(&app2, &q).await,
            };
            let waiting = q.items.lock().unwrap().iter().any(|i| i.state == ItemState::Waiting);
            if q.cancel.load(Ordering::SeqCst) || !waiting {
                q.set_stage("");
                break;
            }
            match outcome {
                Pass::Finished => delay = Duration::from_secs(2),
                Pass::Unreachable(why) => {
                    q.set_stage(format!("Waiting for the server ({why}); trying again in {} s", delay.as_secs()));
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(60));
                }
                Pass::SignedOut(server) => {
                    q.set_stage(format!("Signed out of {server}: sign in again in Settings → Servers, and the rest follows"));
                    break;
                }
            }
        }
        // Cancelled: what was still waiting leaves the list now that no file is in flight
        if q.cancel.load(Ordering::SeqCst) {
            q.items.lock().unwrap().retain(|i| i.state != ItemState::Waiting);
        }
        q.dirty.store(true, Ordering::Relaxed);
        q.running.store(false, Ordering::SeqCst);
    });
}

enum Pass {
    Finished,
    Unreachable(String),
    SignedOut(String),
}

fn waiting(q: &Queue, f: impl Fn(&Item) -> bool) -> Vec<(usize, Item)> {
    q.items.lock().unwrap().iter().enumerate().filter(|(_, i)| i.state == ItemState::Waiting && f(i)).map(|(n, i)| (n, i.clone())).collect()
}

fn modified_secs(m: &fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
}

async fn upload_pass(app: &AppHandle, q: &Arc<Queue>) -> Pass {
    let client = transfers(app).client_id.clone();
    // 1. Lumina's content hash and the full BLAKE3 of each new file
    let unhashed = waiting(q, |i| i.hash.is_none());
    for (n, (i, item)) in unhashed.iter().enumerate() {
        if q.cancel.load(Ordering::SeqCst) {
            return Pass::Finished;
        }
        q.set_stage(format!("Reading files ({} of {})", n + 1, unhashed.len()));
        let path = PathBuf::from(item.path.clone().unwrap_or_default());
        match tauri::async_runtime::spawn_blocking(move || transfer::hash_file(&path)).await {
            Ok(Ok((hash, full, size))) => q.update(*i, |it| {
                it.hash = Some(hash);
                it.full_hash = Some(full);
                it.size = size;
            }),
            outcome => {
                let why = match outcome {
                    Ok(Err(e)) => e,
                    Err(e) => e.to_string(),
                    Ok(Ok(_)) => unreachable!(),
                };
                q.update(*i, |it| {
                    it.state = ItemState::Failed;
                    it.error = Some(format!("Couldn't read the file: {why}"));
                })
            }
        }
    }
    // 2. Ask each server which of them it lacks; what it has is skipped
    let unchecked = waiting(q, |i| i.hash.is_some() && !i.checked);
    let servers: HashSet<String> = unchecked.iter().map(|(_, i)| i.server.clone()).collect();
    for server in servers {
        let Some(c) = conn(app, &server) else { return Pass::SignedOut(server) };
        let mine: Vec<&(usize, Item)> = unchecked.iter().filter(|(_, i)| i.server == server).collect();
        for batch in mine.chunks(500) {
            q.set_stage("Asking the server what it already has");
            let files: Vec<(String, u64, String)> = batch.iter().map(|(_, i)| (i.hash.clone().unwrap_or_default(), i.size, i.name.clone())).collect();
            match transfer::check_missing(&c, &files).await {
                Ok(missing) => {
                    let missing: HashSet<String> = missing.into_iter().collect();
                    for (i, item) in batch {
                        let hash = item.hash.clone().unwrap_or_default();
                        let have = !missing.contains(&hash);
                        q.update(*i, |it| {
                            it.checked = true;
                            if have {
                                it.state = ItemState::Skipped;
                            }
                        });
                        if have {
                            if let Some(p) = &item.path {
                                let _ = client_db::add_copy(app, &server, &hash, Path::new(p), item.size);
                            }
                        }
                    }
                }
                Err(Failure::Network(e)) => return Pass::Unreachable(e),
                Err(Failure::SignedOut) => {
                    remote::signed_out(app, &server);
                    return Pass::SignedOut(server);
                }
                Err(Failure::Refused(e)) => {
                    for (i, _) in batch {
                        q.update(*i, |it| {
                            it.state = ItemState::Failed;
                            it.error = Some(e.clone());
                        });
                    }
                }
                Err(Failure::Cancelled) => return Pass::Finished,
            }
        }
    }
    // 3. Send what's missing, two at a time
    let todo = waiting(q, |i| i.checked);
    if todo.is_empty() {
        return Pass::Finished;
    }
    q.set_stage("Uploading");
    let outcome: Mutex<Option<Pass>> = Mutex::new(None);
    futures_util::stream::iter(todo)
        .for_each_concurrent(2, |(i, item)| {
            let (q, client, outcome) = (q.clone(), client.clone(), &outcome);
            async move {
                if q.cancel.load(Ordering::SeqCst) || outcome.lock().unwrap().is_some() {
                    return;
                }
                let Some(c) = conn(app, &item.server) else {
                    *outcome.lock().unwrap() = Some(Pass::SignedOut(item.server.clone()));
                    return;
                };
                let sent = Arc::new(AtomicU64::new(0));
                q.inflight.lock().unwrap().insert(i, (item.name.clone(), sent.clone()));
                let path = PathBuf::from(item.path.clone().unwrap_or_default());
                // The file must still be the one that was read
                let unchanged = fs::metadata(&path).map(|m| m.len() == item.size).unwrap_or(false);
                let result = if !unchanged {
                    Err(Failure::Refused("The file changed or moved since it was added".into()))
                } else {
                    let file = UploadFile {
                        path: &path,
                        name: &item.name,
                        size: item.size,
                        hash: item.hash.as_deref().unwrap_or_default(),
                        full_hash: item.full_hash.as_deref().unwrap_or_default(),
                        modified: item.modified,
                    };
                    transfer::upload_one(&c, &file, &sent, &q.cancel, &client).await
                };
                q.inflight.lock().unwrap().remove(&i);
                match result {
                    Ok(photo) => {
                        let hash = photo["hash"].as_str().map(str::to_string).or(item.hash.clone()).unwrap_or_default();
                        let _ = client_db::add_copy(app, &item.server, &hash, &path, item.size);
                        q.update(i, |it| it.state = ItemState::Done);
                    }
                    Err(Failure::Refused(e)) => q.update(i, |it| {
                        it.state = ItemState::Failed;
                        it.error = Some(e);
                    }),
                    Err(Failure::Network(e)) => {
                        outcome.lock().unwrap().get_or_insert(Pass::Unreachable(e));
                    }
                    Err(Failure::SignedOut) => {
                        remote::signed_out(app, &item.server);
                        *outcome.lock().unwrap() = Some(Pass::SignedOut(item.server.clone()));
                    }
                    Err(Failure::Cancelled) => {}
                }
            }
        })
        .await;
    outcome.into_inner().unwrap().unwrap_or(Pass::Finished)
}

async fn download_pass(app: &AppHandle, q: &Arc<Queue>) -> Pass {
    let todo = waiting(q, |_| true);
    q.set_stage("Downloading");
    let outcome: Mutex<Option<Pass>> = Mutex::new(None);
    futures_util::stream::iter(todo)
        .for_each_concurrent(2, |(i, item)| {
            let (q, outcome) = (q.clone(), &outcome);
            async move {
                if q.cancel.load(Ordering::SeqCst) || outcome.lock().unwrap().is_some() {
                    return;
                }
                let Some(c) = conn(app, &item.server) else {
                    *outcome.lock().unwrap() = Some(Pass::SignedOut(item.server.clone()));
                    return;
                };
                let received = Arc::new(AtomicU64::new(0));
                q.inflight.lock().unwrap().insert(i, (item.name.clone(), received.clone()));
                let hash = item.hash.clone().unwrap_or_default();
                let dir = PathBuf::from(item.dir.clone().unwrap_or_default());
                let result = transfer::download_one(&c, &hash, &dir, &received, &q.cancel).await;
                q.inflight.lock().unwrap().remove(&i);
                match result {
                    Ok((path, size)) => {
                        let _ = client_db::add_copy(app, &item.server, &hash, &path, size);
                        q.update(i, |it| {
                            it.state = ItemState::Done;
                            it.size = size;
                            it.name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                            it.path = Some(path.to_string_lossy().to_string());
                        });
                    }
                    Err(Failure::Refused(e)) => q.update(i, |it| {
                        it.state = ItemState::Failed;
                        it.error = Some(e);
                    }),
                    Err(Failure::Network(e)) => {
                        outcome.lock().unwrap().get_or_insert(Pass::Unreachable(e));
                    }
                    Err(Failure::SignedOut) => {
                        remote::signed_out(app, &item.server);
                        *outcome.lock().unwrap() = Some(Pass::SignedOut(item.server.clone()));
                    }
                    Err(Failure::Cancelled) => {}
                }
            }
        })
        .await;
    outcome.into_inner().unwrap().unwrap_or(Pass::Finished)
}

// A new batch while the queue rests starts a fresh list: what finished before (perhaps while the app was
// closed) doesn't count in its progress. A running queue keeps its list, whose places are in use.
fn forget_finished(q: &Queue, items: &mut Vec<Item>) {
    if !q.running.load(Ordering::SeqCst) {
        items.retain(|i| i.state == ItemState::Waiting);
    }
}

fn uploadable(path: &Path) -> bool {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    scan::PHOTO_EXTENSIONS.contains(&ext.as_str()) || video_meta::is_video_ext(&ext) || ext == "xmp"
}

#[derive(Serialize)]
pub struct Queued {
    queued: usize,
    // Files Lumina doesn't keep (documents, ...), and folders like _Trash
    ignored: usize,
}

// Files and folders (dropped on the window, or picked) to send to the server
#[tauri::command]
pub async fn upload_paths(app: AppHandle, server: String, paths: Vec<String>) -> Result<Queued, String> {
    remote(&app).server(&server)?;
    let app2 = app.clone();
    let queued = tauri::async_runtime::spawn_blocking(move || {
        let q = transfers(&app2).uploads.clone();
        let mut files = Vec::new();
        let mut ignored = 0;
        for p in &paths {
            if !Path::new(p).exists() {
                return Err(format!("{p} isn't there (moved or on a drive that's gone?)"));
            }
            for entry in walkdir::WalkDir::new(p)
                .into_iter()
                .filter_entry(|e| !e.file_name().to_string_lossy().starts_with(['.', '_']) || e.depth() == 0)
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file())
            {
                if uploadable(entry.path()) {
                    // The system's own separators throughout ("C:/x\y.jpg" from a mixed path is refused by the
                    // Recycle Bin later)
                    files.push(entry.path().components().collect::<PathBuf>());
                } else {
                    ignored += 1;
                }
            }
        }
        let mut items = q.items.lock().unwrap();
        forget_finished(&q, &mut items);
        let already: HashSet<(String, String)> =
            items.iter().filter(|i| i.state == ItemState::Waiting).filter_map(|i| Some((i.server.clone(), i.path.clone()?))).collect();
        let mut queued = 0;
        for f in files {
            let key = (server.clone(), f.to_string_lossy().to_string());
            if already.contains(&key) {
                continue;
            }
            let meta = fs::metadata(&f).ok();
            items.push(Item {
                server: server.clone(),
                name: f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                path: Some(key.1),
                dir: None,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta.as_ref().map(modified_secs).unwrap_or(0),
                hash: None,
                full_hash: None,
                checked: false,
                state: ItemState::Waiting,
                error: None,
            });
            queued += 1;
        }
        drop(items);
        q.save();
        Ok::<_, String>(Queued { queued, ignored })
    })
    .await
    .map_err(|e| e.to_string())??;
    start(&app, transfers(&app).uploads.clone());
    Ok(queued)
}

// Originals of these photos into a folder on this computer
#[tauri::command]
pub fn download_originals(app: AppHandle, server: String, photos: Vec<(String, String)>, folder: String) -> Result<usize, String> {
    remote(&app).server(&server)?;
    if folder.trim().is_empty() {
        return Err("Choose a folder to download into".into());
    }
    let q = transfers(&app).downloads.clone();
    let mut items = q.items.lock().unwrap();
    forget_finished(&q, &mut items);
    let already: HashSet<(String, String)> =
        items.iter().filter(|i| i.state == ItemState::Waiting).filter_map(|i| Some((i.hash.clone()?, i.dir.clone()?))).collect();
    let mut queued = 0;
    for (hash, name) in photos {
        if already.contains(&(hash.clone(), folder.clone())) {
            continue;
        }
        items.push(Item {
            server: server.clone(),
            path: None,
            dir: Some(folder.clone()),
            name,
            size: 0,
            modified: 0,
            hash: Some(hash),
            full_hash: None,
            checked: true,
            state: ItemState::Waiting,
            error: None,
        });
        queued += 1;
    }
    drop(items);
    q.save();
    start(&app, q);
    Ok(queued)
}

fn queue_of(app: &AppHandle, kind: &str) -> Result<Arc<Queue>, String> {
    let t = transfers(app);
    match kind {
        "upload" => Ok(t.uploads.clone()),
        "download" => Ok(t.downloads.clone()),
        _ => Err(format!("No such queue: {kind}")),
    }
}

#[tauri::command]
pub fn transfer_progress(app: AppHandle, kind: String) -> Result<Progress, String> {
    Ok(queue_of(&app, &kind)?.progress())
}

// Stops the queue; what was waiting is taken off the list (an upload the server started is removed there
// after a week)
#[tauri::command]
pub fn cancel_transfers(app: AppHandle, kind: String) -> Result<(), String> {
    let q = queue_of(&app, &kind)?;
    q.cancel.store(true, Ordering::SeqCst);
    // A running queue clears its list itself once the files in flight have stopped
    if !q.running.load(Ordering::SeqCst) {
        q.items.lock().unwrap().retain(|i| i.state != ItemState::Waiting);
        q.save();
    }
    let _ = app.emit(q.event(), q.progress());
    Ok(())
}

// Clears finished, skipped and failed files from the list
#[tauri::command]
pub fn clear_transfers(app: AppHandle, kind: String) -> Result<(), String> {
    let q = queue_of(&app, &kind)?;
    if q.running.load(Ordering::SeqCst) {
        // Places in the list are in use while it runs
        return Ok(());
    }
    q.items.lock().unwrap().retain(|i| i.state == ItemState::Waiting);
    q.save();
    let _ = app.emit(q.event(), q.progress());
    Ok(())
}

// Tries the failed files again, and starts a queue that stopped (signed out, say)
#[tauri::command]
pub fn retry_transfers(app: AppHandle, kind: String) -> Result<(), String> {
    let q = queue_of(&app, &kind)?;
    if !q.running.load(Ordering::SeqCst) {
        for i in q.items.lock().unwrap().iter_mut().filter(|i| i.state == ItemState::Failed) {
            i.state = ItemState::Waiting;
            i.error = None;
            i.checked = false;
        }
        q.save();
    }
    start(&app, q);
    Ok(())
}

#[tauri::command]
pub fn client_id(app: AppHandle) -> String {
    transfers(&app).client_id.clone()
}
