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
        ServerHost { data_dir, events: broadcast::channel(1024).0, last_logged: Mutex::new(HashMap::new()) }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<(String, JsonValue)> {
        self.events.subscribe()
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
        let _ = self.events.send((event.to_string(), payload));
    }
}
