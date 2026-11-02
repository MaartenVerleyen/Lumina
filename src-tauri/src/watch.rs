use crate::*;
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::time::Duration;

// Watches the open library folder: photos added, changed or removed outside Lumina (Explorer, a sync app, a
// camera tool) make the app rescan quietly after 2 s without changes.

static WATCHER: Mutex<Option<Debouncer<RecommendedWatcher>>> = Mutex::new(None);

// Photos and videos only: Lumina's own .part files, sidecars and caches don't need a rescan
pub fn is_library_photo(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    (PHOTO_EXTENSIONS.contains(&ext.as_str()) || crate::video_meta::is_video_ext(&ext))
        && !path.components().any(|c| c.as_os_str() == ".triage_cache")
}

// Starts watching `root` (stopping the previous watch); None just stops
#[tauri::command]
pub fn watch_library(app: AppHandle, root: Option<String>) -> Result<(), String> {
    let mut slot = WATCHER.lock().map_err(|e| e.to_string())?;
    *slot = None;
    let Some(root) = root else { return Ok(()) };
    let folder = root.clone();
    let mut debouncer = new_debouncer(Duration::from_secs(2), move |res: DebounceEventResult| {
        if let Ok(events) = res {
            if events.iter().any(|e| is_library_photo(&e.path)) {
                let _ = emit_to(&app, "library-files-changed", folder.clone());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| format!("Can't watch {root}: {e}"))?;
    *slot = Some(debouncer);
    Ok(())
}
