// The upload and download queues of client mode. Each is a list of files saved in the app's data folder
// (upload-queue.json, download-queue.json), so a closed laptop or a restart carries on where it stopped;
// the server keeps what has arrived of an upload, a download keeps its part file. Two files move at a time.
// When the server can't be reached the queue waits (2 s, 4 s, ... 60 s) and tries again, for as long as it
// takes; a file the server refuses is marked failed with the server's reason. Progress goes to the window
// twice a second as `upload-progress` / `download-progress`.
// A backup (All photos → Back up now) queues uploads that carry the photo's values on this PC (rating, tags,
// albums, people names: lumina_core::photo_meta); once the file is on the server, or was there already, the
// values are sent along (`apply_backup_values`), also after a restart.
use crate::client_db;
use crate::remote::{self, remote};
use crate::transfer::{self, Conn, Failure, UploadFile};
use crate::*;
use lumina_core::photo_meta;
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
    // Backup: the photo's values on this PC (a photo_meta::PhotoMeta), and whether the server has had them
    #[serde(default)]
    values: Option<serde_json::Value>,
    #[serde(default)]
    values_sent: bool,
    // Download of a followed album's photo (follows.rs): what comes with it, and the server it goes on to
    #[serde(default)]
    follow: Option<FollowStep>,
    // Upload of a followed photo passing through this PC: the file goes once the server has it
    #[serde(default)]
    delete_after: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct FollowStep {
    values: Option<serde_json::Value>,
    upload_to: Option<String>,
}

// A photo of a followed album to download (follows.rs)
pub struct FollowedPhoto {
    pub hash: String,
    pub name: String,
    pub values: Option<serde_json::Value>,
}

// A backed-up file whose values still have to go to the server
fn values_due(i: &Item) -> bool {
    i.values.is_some() && !i.values_sent && matches!(i.state, ItemState::Done | ItemState::Skipped)
}

// Something is left to do for this file
fn unfinished(i: &Item) -> bool {
    i.state == ItemState::Waiting || values_due(i)
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
    // Backup: photos whose values went on, or didn't (the reason is with the file); names put on faces,
    // waiting for the server to find the faces, and photos with a named face the server didn't find
    values_sent: usize,
    values_failed: usize,
    values_failures: Vec<FailedFile>,
    names_placed: usize,
    names_waiting: usize,
    names_unplaced: usize,
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
    // Backup: names placed, waiting and not placed since the list started (not saved)
    names: Mutex<(usize, usize, usize)>,
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
            names: Mutex::new((0, 0, 0)),
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
            if item.values.is_some() && item.values_sent && item.state != ItemState::Failed {
                if let Some(error) = &item.error {
                    p.values_failed += 1;
                    if p.values_failures.len() < 50 {
                        p.values_failures.push(FailedFile { name: item.name.clone(), error: error.clone() });
                    }
                } else {
                    p.values_sent += 1;
                }
            }
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
        (p.names_placed, p.names_waiting, p.names_unplaced) = *self.names.lock().unwrap();
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
        if q.items.lock().unwrap().iter().any(unfinished) {
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
            let waiting = q.items.lock().unwrap().iter().any(unfinished);
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
                                if item.delete_after {
                                    let _ = fs::remove_file(p);
                                } else {
                                    let _ = client_db::add_copy(app, &server, &hash, Path::new(p), item.size);
                                }
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
        return send_values(app, q, &client).await;
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
                        if item.delete_after {
                            let _ = fs::remove_file(&path);
                        } else {
                            let _ = client_db::add_copy(app, &item.server, &hash, &path, item.size);
                        }
                        // The server's id for it (another copy of the same photo there gets its own)
                        q.update(i, |it| {
                            it.state = ItemState::Done;
                            it.hash = Some(hash);
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
    match outcome.into_inner().unwrap() {
        Some(pass) => pass,
        None => send_values(app, q, &client).await,
    }
}

// 4. A backup's values, for the files that are on the server now (sent, or there already)
async fn send_values(app: &AppHandle, q: &Arc<Queue>, client: &str) -> Pass {
    let due: Vec<(usize, Item)> =
        q.items.lock().unwrap().iter().enumerate().filter(|(_, i)| values_due(i)).map(|(n, i)| (n, i.clone())).collect();
    let servers: HashSet<String> = due.iter().map(|(_, i)| i.server.clone()).collect();
    for server in servers {
        let mine: Vec<&(usize, Item)> = due.iter().filter(|(_, i)| i.server == server).collect();
        for batch in mine.chunks(200) {
            if q.cancel.load(Ordering::SeqCst) {
                return Pass::Finished;
            }
            q.set_stage("Putting ratings, tags, albums and names on the server's copies");
            let items: Vec<serde_json::Value> = batch
                .iter()
                .filter_map(|(_, i)| {
                    let mut values = i.values.clone()?;
                    values["hash"] = serde_json::json!(i.hash.clone()?);
                    Some(values)
                })
                .collect();
            let args = serde_json::json!({ "items": items });
            match remote::server_call(app.clone(), server.clone(), "apply_backup_values".into(), Some(args), Some(client.to_string())).await {
                Ok(answer) => {
                    let report: photo_meta::ApplyReport = serde_json::from_value(answer).unwrap_or_default();
                    {
                        let mut names = q.names.lock().unwrap();
                        names.0 += report.faces_named;
                        names.1 += report.faces_waiting;
                        names.2 += report.faces_unplaced.len();
                    }
                    for (i, item) in batch {
                        let missing = item.hash.as_ref().is_some_and(|h| report.missing.contains(h));
                        let not_yours = item.hash.as_ref().is_some_and(|h| report.not_yours.contains(h));
                        q.update(*i, |it| {
                            it.values_sent = true;
                            if missing {
                                it.error = Some("The server doesn't list this photo, so its values weren't put on".into());
                            } else if not_yours {
                                it.error = Some("Someone else uploaded this photo there: its tags and names need an editor to go on".into());
                            }
                        });
                    }
                }
                Err(_) if remote(app).token(&server).is_none() => return Pass::SignedOut(server),
                Err(e) if e.starts_with("Can't reach the server") => return Pass::Unreachable(e),
                // Refused (a role below editor, say): the files are there, without their values
                Err(e) => {
                    for (i, _) in batch {
                        q.update(*i, |it| {
                            it.values_sent = true;
                            it.error = Some(format!("Its ratings, tags and names weren't put on: {e}"));
                        });
                    }
                }
            }
        }
    }
    Pass::Finished
}

async fn download_pass(app: &AppHandle, q: &Arc<Queue>) -> Pass {
    let todo = waiting(q, |_| true);
    q.set_stage("Downloading");
    let outcome: Mutex<Option<Pass>> = Mutex::new(None);
    // Followed photos that landed in a folder of this PC, to take into the library once the pass ends
    let landed: Mutex<Vec<(PathBuf, Option<serde_json::Value>)>> = Mutex::new(Vec::new());
    futures_util::stream::iter(todo)
        .for_each_concurrent(2, |(i, item)| {
            let (q, outcome, landed) = (q.clone(), &outcome, &landed);
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
                        match &item.follow {
                            Some(FollowStep { values, upload_to: Some(target) }) => relay(app, target, &path, size, values.clone()),
                            Some(FollowStep { values, upload_to: None }) => landed.lock().unwrap().push((path.clone(), values.clone())),
                            None => {}
                        }
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
    let landed = landed.into_inner().unwrap();
    if !landed.is_empty() {
        let app2 = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || take_in(&app2, landed)).await;
    }
    outcome.into_inner().unwrap().unwrap_or(Pass::Finished)
}

// Followed photos in a folder of this PC become photos of your library: indexed, with their tags and people
// names (each name goes on the face found at the same place, once this PC's face scan has found it), and the
// window is told so it lists the folder again
fn take_in(app: &AppHandle, landed: Vec<(PathBuf, Option<serde_json::Value>)>) {
    let host: lumina_core::host::SharedHost = Arc::new(app.clone());
    let Ok(mut conn) = open_global_db(app) else { return };
    let libraries = lumina_core::libraries::list(&conn).unwrap_or_default();
    let (mut hashes, mut roots) = (Vec::new(), HashSet::new());
    for (path, values) in landed {
        let file = path.to_string_lossy().to_lowercase();
        let Some(root) = libraries
            .iter()
            .filter(|l| file.starts_with(&l.root.to_lowercase()))
            .max_by_key(|l| l.root.len())
            .map(|l| l.root.clone())
        else {
            continue;
        };
        match scan::index_new_file(host.clone(), &root, &path) {
            Ok(photo) => {
                if let Some(mut meta) = values.and_then(|v| serde_json::from_value::<photo_meta::PhotoMeta>(v).ok()) {
                    meta.hash = photo.hash.clone();
                    let _ = photo_meta::apply(&mut conn, &[meta]);
                }
                hashes.push(photo.hash);
                roots.insert(root);
            }
            Err(e) => eprintln!("[follow] {}: {e}", path.display()),
        }
    }
    if !hashes.is_empty() {
        let host = host.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = lumina_core::face_scan::scan_library_faces_batch(host, hashes).await {
                eprintln!("[follow] no face scan: {e}");
            }
        });
    }
    for root in roots {
        let _ = app.emit("library-files-changed", root);
    }
}

// A followed photo for a library on another server: it goes on as an upload, with what came with it, and
// leaves this PC once that server has it
fn relay(app: &AppHandle, server: &str, path: &Path, size: u64, values: Option<serde_json::Value>) {
    let q = transfers(app).uploads.clone();
    {
        let mut items = q.items.lock().unwrap();
        forget_finished(&q, &mut items);
        items.push(Item {
            server: server.to_string(),
            name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            path: Some(path.to_string_lossy().to_string()),
            dir: None,
            size,
            modified: fs::metadata(path).as_ref().map(modified_secs).unwrap_or(0),
            hash: None,
            full_hash: None,
            checked: false,
            state: ItemState::Waiting,
            error: None,
            values,
            values_sent: false,
            follow: None,
            delete_after: true,
        });
    }
    q.save();
    start(app, q);
}

// The new photos of a followed album, into `folder` (and on to `upload_to`)
pub fn download_followed(app: &AppHandle, server: &str, photos: Vec<FollowedPhoto>, folder: &str, upload_to: Option<String>) -> Result<(), String> {
    let q = transfers(app).downloads.clone();
    {
        let mut items = q.items.lock().unwrap();
        forget_finished(&q, &mut items);
        for p in photos {
            items.push(Item {
                server: server.to_string(),
                path: None,
                dir: Some(folder.to_string()),
                name: p.name,
                size: 0,
                modified: 0,
                hash: Some(p.hash),
                full_hash: None,
                checked: true,
                state: ItemState::Waiting,
                error: None,
                values: None,
                values_sent: false,
                follow: Some(FollowStep { values: p.values, upload_to: upload_to.clone() }),
                delete_after: false,
            });
        }
    }
    q.save();
    start(app, q);
    Ok(())
}

// A new batch while the queue rests starts a fresh list: what finished before (perhaps while the app was
// closed) doesn't count in its progress. A running queue keeps its list, whose places are in use.
fn forget_finished(q: &Queue, items: &mut Vec<Item>) {
    if !q.running.load(Ordering::SeqCst) {
        items.retain(unfinished);
        *q.names.lock().unwrap() = (0, 0, 0);
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
                values: None,
                values_sent: false,
                follow: None,
                delete_after: false,
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

// All photos → Back up now: these photos of this PC's libraries to the server, each with its values here
// when `with_values` (an editor there; an uploader's backup sends the files only)
#[tauri::command]
pub async fn back_up(app: AppHandle, server: String, hashes: Vec<String>, with_values: bool) -> Result<Queued, String> {
    remote(&app).server(&server)?;
    let app2 = app.clone();
    let queued = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app2)?;
        // The originals (a RAW's or HEIC's own file, not the preview the grid shows)
        let mut photos: Vec<(String, String)> = Vec::new();
        for hash in &hashes {
            if let Ok(path) = conn.query_row("SELECT current_path FROM photos WHERE hash = ?1", [hash], |r| r.get::<_, String>(0)) {
                photos.push((hash.clone(), path));
            }
        }
        let values: HashMap<String, serde_json::Value> = if with_values {
            photo_meta::collect(&conn, &hashes)?
                .into_iter()
                .filter_map(|m| Some((m.hash.clone(), serde_json::to_value(&m).ok()?)))
                .collect()
        } else {
            HashMap::new()
        };
        let q = transfers(&app2).uploads.clone();
        let mut items = q.items.lock().unwrap();
        forget_finished(&q, &mut items);
        let already: HashSet<(String, String)> =
            items.iter().filter(|i| unfinished(i)).filter_map(|i| Some((i.server.clone(), i.path.clone()?))).collect();
        let (mut queued, mut ignored) = (0, hashes.len() - photos.len());
        for (hash, file) in photos {
            let path = PathBuf::from(&file);
            if already.contains(&(server.clone(), file.clone())) {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                ignored += 1;
                continue;
            };
            items.push(Item {
                server: server.clone(),
                name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                path: Some(file),
                dir: None,
                size: meta.len(),
                modified: modified_secs(&meta),
                hash: None,
                full_hash: None,
                checked: false,
                state: ItemState::Waiting,
                error: None,
                values: values.get(&hash).cloned(),
                values_sent: false,
                follow: None,
                delete_after: false,
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

// The phone app: a photo's original to another app, downloaded into the app's cache first and then handed to
// Android's share sheet. Only one shared file is kept at a time.
#[tauri::command]
pub async fn share_photo(app: AppHandle, server: String, hash: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let c = conn(&app, &server).ok_or_else(|| format!("Signed out of {server}: sign in again in Settings"))?;
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("share");
        let _ = fs::remove_dir_all(&dir);
        let (path, _) = transfer::download_one(&c, &hash, &dir, &AtomicU64::new(0), &AtomicBool::new(false))
            .await
            .map_err(|f| match f {
                Failure::Refused(e) | Failure::Network(e) => e,
                Failure::SignedOut => format!("Signed out of {server}: sign in again in Settings"),
                Failure::Cancelled => "Cancelled".to_string(),
            })?;
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let mime = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "heic" | "heif" => "image/heic",
            "webp" => "image/webp",
            "mp4" | "m4v" => "video/mp4",
            "mov" => "video/quicktime",
            _ if video_meta::is_video_ext(&ext) => "video/*",
            _ => "image/*",
        };
        crate::android::share_file(&app, &path, mime)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, server, hash);
        Err("Sharing to another app is the phone app's".into())
    }
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
            values: None,
            values_sent: false,
            follow: None,
            delete_after: false,
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
    q.items.lock().unwrap().retain(unfinished);
    *q.names.lock().unwrap() = (0, 0, 0);
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
