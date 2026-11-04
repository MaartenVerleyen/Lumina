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
    data_dir: PathBuf,
    events: broadcast::Sender<(String, JsonValue)>,
    last_logged: Mutex<HashMap<String, Instant>>,
}

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
        ServerHost { jobs: Default::default(), data_dir, events: broadcast::channel(1024).0, last_logged: Mutex::new(HashMap::new()) }
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
