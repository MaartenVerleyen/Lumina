// The server as the engine's host: its data folder, and its events. Events go to whoever waits for one (the
// pipeline waits for "done") and, a few per second at most, to the log.
use lumina_core::host::Host;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

pub struct ServerHost {
    // Jobs asked for from the admin page, and what the pipeline is doing
    pub jobs: crate::pipeline::Jobs,
    // Each library's photo list, kept ready until something changes (listing.rs)
    pub listings: crate::listing::Listings,
    // Each user's scope, kept between requests (scope.rs)
    pub scopes: crate::scope::Scopes,
    data_dir: PathBuf,
    events: broadcast::Sender<(String, JsonValue)>,
    last_logged: Mutex<HashMap<String, Instant>>,
    // The latest progress of each kind of work running now, for the admin page and the tray
    progress: Mutex<HashMap<String, Progress>>,
    // Files changed in a library, as the watcher saw it: the serve loop takes the receiving end. Kept apart from
    // the events, where the pipeline says the same after its own indexing, so a pass never mistakes its own
    // word for a change, and never loses a real one that came while it ran
    watched: tokio::sync::mpsc::UnboundedSender<String>,
    watched_receiver: Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<String>>>,
}

#[derive(Clone, serde::Serialize)]
pub struct Progress {
    pub label: String,
    pub stage: String,
    pub completed: u64,
    pub total: u64,
    // Seconds since the work started, so a reader can work out the time left
    pub seconds: f64,
    #[serde(skip)]
    started: Option<Instant>,
}

// The work worth a line on the admin page and in the tray, by its progress event
const PROGRESS: &[(&str, &str)] = &[
    ("scan-progress", "Indexing"),
    ("thumb-batch-ready", "Thumbnails"),
    ("face-scan-progress", "Face scan"),
    ("face-quality-progress", "Eyes and focus"),
    ("semantic-progress", "Smart search index"),
    ("ai-batch-progress", "Captions"),
    // Counted in MB
    ("face-model-download", "Downloading face models (once)"),
];

// Progress events worth a line in the log; the rest (per-photo grid updates) are only for waiters
const LOGGED: &[&str] = &[
    "scan-progress",
    "face-scan-progress",
    "face-quality-progress",
    "semantic-progress",
    "ai-batch-progress",
    "face-model-download",
    "library-files-changed",
];

impl ServerHost {
    pub fn new(data_dir: PathBuf) -> ServerHost {
        let _ = std::fs::create_dir_all(&data_dir);
        let (watched, watched_receiver) = tokio::sync::mpsc::unbounded_channel();
        ServerHost {
            watched,
            watched_receiver: Mutex::new(Some(watched_receiver)),
            jobs: Default::default(),
            listings: Default::default(),
            scopes: Default::default(),
            data_dir,
            events: broadcast::channel(1024).0,
            last_logged: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
        }
    }

    // The serve loop takes the watcher's changes once
    pub fn take_watched(&self) -> Option<tokio::sync::mpsc::UnboundedReceiver<String>> {
        self.watched_receiver.lock().unwrap().take()
    }

    // The pipeline indexed a library: open windows list it again. Not a change for the serve loop to act on.
    pub fn library_indexed(&self, root: &str) {
        let payload = serde_json::json!(root);
        self.listings.changed_files();
        self.log("library-files-changed", &payload);
        let _ = self.events.send(("library-files-changed".to_string(), payload));
    }

    pub fn subscribe(&self) -> broadcast::Receiver<(String, JsonValue)> {
        self.events.subscribe()
    }

    // Answers and events name thumbnails, previews and face crops by their place in the data folder
    // ("faces/<id>.jpg"), not by where that folder is on the server: clients fetch them by hash or face id
    pub fn hide_data_dir(&self, value: &mut JsonValue) {
        let dir = self.data_dir.to_string_lossy();
        let dir = dir.trim_end_matches(['/', '\\']);
        if !dir.is_empty() {
            strip_prefix_in(value, dir);
        }
    }

    // What is running now, longest-running first
    pub fn progress(&self) -> Vec<Progress> {
        let mut list: Vec<Progress> = self
            .progress
            .lock()
            .unwrap()
            .values()
            .map(|p| Progress { seconds: p.started.map(|s| s.elapsed().as_secs_f64()).unwrap_or(0.0), ..p.clone() })
            .collect();
        list.sort_by(|a, b| b.seconds.total_cmp(&a.seconds));
        list
    }

    // Whether work of this kind (by its progress event) has reported progress and not yet that it is done
    pub fn working_on(&self, event: &str) -> bool {
        self.progress.lock().unwrap().contains_key(event)
    }

    fn note_progress(&self, event: &str, p: &JsonValue) {
        let Some((_, label)) = PROGRESS.iter().find(|(e, _)| *e == event) else { return };
        let number = |key: &str| p[key].as_u64().or_else(|| p[key].as_f64().map(|f| f as u64));
        let completed = number("completed").or(number("current")).or(number("downloaded_mb")).unwrap_or(0);
        let total = number("total").or(number("total_mb")).unwrap_or(0);
        let mut all = self.progress.lock().unwrap();
        // A thumbnail pass says it is done by reaching its total
        let done = p["done"].as_bool() == Some(true) || (event == "thumb-batch-ready" && total > 0 && completed >= total);
        if done {
            all.remove(event);
            return;
        }
        let entry = all.entry(event.to_string()).or_insert_with(|| Progress {
            label: label.to_string(),
            stage: String::new(),
            completed: 0,
            total: 0,
            seconds: 0.0,
            started: Some(Instant::now()),
        });
        // A new run (its count went back) starts its clock again
        if completed < entry.completed || total != entry.total {
            entry.started = Some(Instant::now());
        }
        entry.stage = p["stage"].as_str().unwrap_or("").to_string();
        entry.completed = completed;
        entry.total = total;
    }

    fn log(&self, event: &str, payload: &JsonValue) {
        if !LOGGED.contains(&event) {
            return;
        }
        let done = payload["done"].as_bool() == Some(true);
        if !done {
            let mut last = self.last_logged.lock().unwrap();
            let now = Instant::now();
            if last.get(event).is_some_and(|t| now.duration_since(*t) < Duration::from_secs(5)) {
                return;
            }
            last.insert(event.to_string(), now);
        }
        println!("{}", describe(event, payload));
    }
}

// The engine's own files in the data folder; a library may live in there too, and keeps its full paths
const CACHE_FOLDERS: &[&str] = &["thumbnails", "previews", "faces", "frames", "transcodes"];

fn strip_prefix_in(value: &mut JsonValue, dir: &str) {
    match value {
        JsonValue::String(s) => {
            if let Some(rest) = s.strip_prefix(dir).and_then(|r| r.strip_prefix(['/', '\\'])) {
                let folder = rest.split(['/', '\\']).next().unwrap_or("");
                if CACHE_FOLDERS.contains(&folder) && rest.len() > folder.len() {
                    *s = rest.to_string();
                }
            }
        }
        JsonValue::Array(items) => items.iter_mut().for_each(|v| strip_prefix_in(v, dir)),
        JsonValue::Object(map) => map.values_mut().for_each(|v| strip_prefix_in(v, dir)),
        _ => {}
    }
}

// One readable line per event: "[face-scan] 120/400", "[semantic] index · 94/94 · done". (Timings are
// already printed by the engine as "[perf] ...".)
fn describe(event: &str, p: &JsonValue) -> String {
    let name = event.trim_end_matches("-progress");
    if let JsonValue::String(s) = p {
        return format!("[{name}] {s}");
    }
    let mut parts = Vec::new();
    if let Some(stage) = p["stage"].as_str().filter(|s| !s.is_empty()) {
        parts.push(stage.to_string());
    }
    if let (Some(done), Some(total)) = (p["completed"].as_u64().or(p["current"].as_u64()), p["total"].as_u64()) {
        parts.push(format!("{done}/{total}"));
    }
    if let Some(m) = p["message"].as_str().filter(|s| !s.is_empty()) {
        parts.push(m.to_string());
    }
    if p["done"].as_bool() == Some(true) {
        parts.push("done".to_string());
    }
    format!("[{name}] {}", parts.join(" · "))
}

impl Host for ServerHost {
    fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }

    fn emit_value(&self, event: &str, payload: JsonValue) {
        self.log(event, &payload);
        self.listings.note_event(event, &payload);
        self.scopes.note_event(event);
        self.note_progress(event, &payload);
        // Only the watcher sends this through the engine's host
        if event == "library-files-changed" {
            if let Some(root) = payload.as_str() {
                let _ = self.watched.send(root.to_string());
            }
        }
        let finished = finished_photos(event, &payload);
        let _ = self.events.send((event.to_string(), payload));
        if !finished.is_empty() {
            let _ = self.events.send(("photos-changed".to_string(), analysed(event, finished)));
        }
    }
}

// The photos a progress event says are done with (thumbnail, faces, caption). Open windows learn about the
// server's own work from photos-changed like from anyone's edit: only a window that runs a batch itself
// listens to ai-batch-progress, and guests get no progress events at all.
pub(crate) fn finished_photos(event: &str, payload: &JsonValue) -> Vec<String> {
    let hashes_of = |list: &JsonValue| -> Vec<String> {
        list.as_array().into_iter().flatten().filter_map(|i| i["hash"].as_str().map(str::to_string)).collect()
    };
    match event {
        "thumb-batch-ready" => hashes_of(&payload["items"]),
        "ai-batch-progress" => hashes_of(&payload["results"]),
        "face-scan-progress" => payload["batch_faces"].as_object().map(|faces| faces.keys().cloned().collect()).unwrap_or_default(),
        _ => Vec::new(),
    }
}

// photos-changed for them, by the server; `after` names the progress event, which users who see the whole
// server already get in full (the socket leaves those out for them, except for captions)
fn analysed(event: &str, hashes: Vec<String>) -> JsonValue {
    serde_json::json!({ "hashes": hashes, "by": "server", "origin": "server", "after": event })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The serve loop acts on what the watcher saw, also when it comes while a pass runs, and never on the
    // pipeline's own "this library was indexed", which goes to the windows only
    #[test]
    fn the_watchers_changes_are_kept_apart_from_the_pipelines_own() {
        let dir = std::env::temp_dir().join(format!("lumina_host_test_{}", std::process::id()));
        let host = ServerHost::new(dir.clone());
        let mut watched = host.take_watched().unwrap();
        assert!(host.take_watched().is_none());
        let mut events = host.subscribe();

        host.library_indexed("/photos");
        assert!(watched.try_recv().is_err(), "the pipeline's own word is not a change");
        assert_eq!(events.try_recv().unwrap().0, "library-files-changed");

        // Nobody is reading while a pass runs: the changes wait
        host.emit_value("library-files-changed", serde_json::json!("/photos"));
        host.emit_value("library-files-changed", serde_json::json!("/more"));
        host.emit_value("photos-changed", serde_json::json!({ "hashes": [] }));
        assert_eq!(watched.try_recv().unwrap(), "/photos");
        assert_eq!(watched.try_recv().unwrap(), "/more");
        assert!(watched.try_recv().is_err());
        assert_eq!(events.try_recv().unwrap().0, "library-files-changed");

        assert!(!host.working_on("face-scan-progress"));
        host.emit_value("face-scan-progress", serde_json::json!({ "completed": 1, "total": 5, "done": false }));
        assert!(host.working_on("face-scan-progress"));
        host.emit_value("face-scan-progress", serde_json::json!({ "completed": 5, "total": 5, "done": true }));
        assert!(!host.working_on("face-scan-progress"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
