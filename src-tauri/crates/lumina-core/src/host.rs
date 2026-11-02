// Where the engine runs: its data folder (database, thumbnails, models) and where its progress events go.
// The desktop app is one host (Tauri's AppHandle); the server is another, without a window. Engine code takes
// a `&dyn Host` (or `&impl Host`) instead of Tauri's AppHandle, so it can be built without Tauri.
use crate::*;

// A host that background threads can keep (the desktop wraps its AppHandle in one)
pub type SharedHost = Arc<dyn Host>;

pub trait Host: Send + Sync {
    fn data_dir(&self) -> PathBuf;
    fn emit_value(&self, event: &str, payload: JsonValue);
    // A library folder was opened: the desktop lets its webview load files from it; other hosts need nothing
    fn allow_media_dir(&self, _dir: &Path) {}
}

#[cfg(feature = "tauri")]
impl Host for tauri::AppHandle {
    // LUMINA_DATA_DIR runs the app on a separate database and caches (a test library, a second profile)
    fn data_dir(&self) -> PathBuf {
        if let Some(dir) = std::env::var_os("LUMINA_DATA_DIR").filter(|d| !d.is_empty()) {
            return PathBuf::from(dir);
        }
        use tauri::Manager;
        self.path().app_local_data_dir().unwrap_or_else(|_| PathBuf::from("./phototriage_data"))
    }

    fn emit_value(&self, event: &str, payload: JsonValue) {
        let _ = tauri::Emitter::emit(self, event, payload);
    }

    fn allow_media_dir(&self, dir: &Path) {
        use tauri::Manager;
        let _ = self.asset_protocol_scope().allow_directory(dir, true);
    }
}

impl<T: Host + ?Sized> Host for &T {
    fn data_dir(&self) -> PathBuf {
        (**self).data_dir()
    }

    fn emit_value(&self, event: &str, payload: JsonValue) {
        (**self).emit_value(event, payload)
    }

    fn allow_media_dir(&self, dir: &Path) {
        (**self).allow_media_dir(dir)
    }
}

impl<T: Host + ?Sized> Host for Arc<T> {
    fn data_dir(&self) -> PathBuf {
        (**self).data_dir()
    }

    fn emit_value(&self, event: &str, payload: JsonValue) {
        (**self).emit_value(event, payload)
    }

    fn allow_media_dir(&self, dir: &Path) {
        (**self).allow_media_dir(dir)
    }
}

// Sends `payload` to whoever listens for `event` (the window, or the server's connected clients)
pub fn emit_to<H: Host + ?Sized, S: Serialize>(host: &H, event: &str, payload: S) {
    if let Ok(value) = serde_json::to_value(payload) {
        host.emit_value(event, value);
    }
}
