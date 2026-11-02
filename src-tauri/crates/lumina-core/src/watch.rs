use crate::*;
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::time::Duration;

// Watches the open library folder: photos added, changed or removed outside Lumina (Explorer, a sync app, a
// camera tool) make the app rescan quietly after 2 s without changes.

static WATCHERS: Mutex<Vec<Debouncer<RecommendedWatcher>>> = Mutex::new(Vec::new());

// Photos and videos only: Lumina's own .part files, sidecars and caches don't need a rescan
pub fn is_library_photo(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    (PHOTO_EXTENSIONS.contains(&ext.as_str()) || video_meta::is_video_ext(&ext))
        && !path.components().any(|c| c.as_os_str() == ".triage_cache")
}

// Starts watching `root` (stopping the previous watch); None just stops
pub fn watch_library(app: SharedHost, root: Option<String>) -> Result<(), String> {
    watch_libraries(app, root.into_iter().collect())
}

// Watches every folder in `roots` (a server's libraries), replacing what was watched before. Each change
// sends "library-files-changed" with the root it happened in.
pub fn watch_libraries(app: SharedHost, roots: Vec<String>) -> Result<(), String> {
    let mut slot = WATCHERS.lock().map_err(|e| e.to_string())?;
    slot.clear();
    for root in roots {
        let folder = root.clone();
        let host = app.clone();
        let mut debouncer = new_debouncer(Duration::from_secs(2), move |res: DebounceEventResult| {
            if let Ok(events) = res {
                if events.iter().any(|e| is_library_photo(&e.path)) {
                    let _ = emit_to(&host, "library-files-changed", folder.clone());
                }
            }
        })
        .map_err(|e| e.to_string())?;
        debouncer
            .watcher()
            .watch(Path::new(&root), RecursiveMode::Recursive)
            .map_err(|e| format!("Can't watch {root}: {e}"))?;
        slot.push(debouncer);
    }
    Ok(())
}
