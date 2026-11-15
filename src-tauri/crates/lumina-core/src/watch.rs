use crate::*;
use notify_debouncer_full::notify::event::{AccessKind, AccessMode, EventKind};
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::time::Duration;

// Watches the open library folder: photos added, changed or removed outside Lumina (Explorer, a sync app, a
// camera tool) make the app rescan quietly after 2 s without changes.

static WATCHERS: Mutex<Vec<Debouncer<RecommendedWatcher, RecommendedCache>>> = Mutex::new(Vec::new());

// Photos and videos only: Lumina's own .part files, sidecars and caches don't need a rescan
pub fn is_library_photo(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    (PHOTO_EXTENSIONS.contains(&ext.as_str()) || video_meta::is_video_ext(&ext))
        && !path.components().any(|c| c.as_os_str() == ".triage_cache")
}

// A folder renamed, moved, made or deleted: its photos moved with it, though the event names only the folder
// (a path without an extension; Lumina's own cache folder doesn't count)
pub fn is_folder_change(kind: &EventKind, path: &Path) -> bool {
    use notify_debouncer_full::notify::event::ModifyKind;
    matches!(kind, EventKind::Modify(ModifyKind::Name(_)) | EventKind::Create(_) | EventKind::Remove(_))
        && path.extension().is_none()
        && !path.components().any(|c| c.as_os_str() == ".triage_cache")
}

// Whether an event changes what is in the library. Linux (inotify) also reports a file being opened and
// closed after reading; Lumina reads photos all the time (thumbnails, previews, captions), and counting
// that as a change made every read start another rescan. Closing a file that was written does count:
// that is a copy that has finished.
pub fn is_change(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(AccessKind::Open(_) | AccessKind::Close(AccessMode::Read) | AccessKind::Read))
}

// Starts watching `root` (stopping the previous watch); None just stops
pub fn watch_library(app: SharedHost, root: Option<String>) -> Result<(), String> {
    watch_libraries(app, root.into_iter().collect())
}

// Watches every folder in `roots` (a server's libraries), replacing what was watched before. Each change
// sends "library-files-changed" with the root it happened in. A folder that can't be watched (not there) doesn't
// stop the others; the error names it.
pub fn watch_libraries(app: SharedHost, roots: Vec<String>) -> Result<(), String> {
    let mut slot = WATCHERS.lock().map_err(|e| e.to_string())?;
    slot.clear();
    let mut failed = Vec::new();
    for root in roots {
        let folder = root.clone();
        let host = app.clone();
        let mut debouncer = new_debouncer(Duration::from_secs(2), None, move |res: DebounceEventResult| {
            if let Ok(events) = res {
                if events
                    .iter()
                    .any(|e| is_change(&e.kind) && e.paths.iter().any(|p| is_library_photo(p) || is_folder_change(&e.kind, p)))
                {
                    let _ = emit_to(&host, "library-files-changed", folder.clone());
                }
            }
        })
        .map_err(|e| e.to_string())?;
        match debouncer.watch(Path::new(&root), RecursiveMode::Recursive) {
            Ok(()) => slot.push(debouncer),
            Err(e) => failed.push(format!("Can't watch {root}: {e}")),
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(failed.join("; "))
    }
}
