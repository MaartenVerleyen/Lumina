// Where the engine runs: its data folder (database, thumbnails, models) and where its progress events go.
// The desktop app is one host (Tauri's AppHandle); the server is another, without a window. Engine code takes
// a `&dyn Host` (or `&impl Host`) instead of Tauri's AppHandle, so it can be built without Tauri.
use crate::*;

// A host that background threads can keep (the desktop wraps its AppHandle in one)
pub type SharedHost = Arc<dyn Host>;

pub trait Host: Send + Sync {
    fn data_dir(&self) -> PathBuf;
    fn emit_value(&self, event: &str, payload: JsonValue);
}

impl Host for AppHandle {
    fn data_dir(&self) -> PathBuf {
        self.path().app_local_data_dir().unwrap_or_else(|_| PathBuf::from("./phototriage_data"))
    }

    fn emit_value(&self, event: &str, payload: JsonValue) {
        let _ = Emitter::emit(self, event, payload);
    }
}

impl<T: Host + ?Sized> Host for &T {
    fn data_dir(&self) -> PathBuf {
        (**self).data_dir()
    }

    fn emit_value(&self, event: &str, payload: JsonValue) {
        (**self).emit_value(event, payload)
    }
}

impl<T: Host + ?Sized> Host for Arc<T> {
    fn data_dir(&self) -> PathBuf {
        (**self).data_dir()
    }

    fn emit_value(&self, event: &str, payload: JsonValue) {
        (**self).emit_value(event, payload)
    }
}

// Sends `payload` to whoever listens for `event` (the window, or the server's connected clients)
pub fn emit_to<H: Host + ?Sized, S: Serialize>(host: &H, event: &str, payload: S) {
    if let Ok(value) = serde_json::to_value(payload) {
        host.emit_value(event, value);
    }
}
