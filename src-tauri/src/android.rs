// The phone app's own side (docs/plans/android.md): a small Kotlin plugin (LuminaPlugin.kt in gen/android)
// for what only Android does. Its share sheet now; the camera roll and background backup come later.
use serde::Serialize;
use std::path::Path;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

struct Phone(PluginHandle<Wry>);

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("lumina-phone")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.amazhr.lumina", "LuminaPlugin")?;
            app.manage(Phone(handle));
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
struct ShareArgs<'a> {
    path: &'a str,
    mime: &'a str,
}

// A file of the app's to another app, through Android's share sheet
pub fn share_file(app: &AppHandle, path: &Path, mime: &str) -> Result<(), String> {
    app.state::<Phone>()
        .0
        .run_mobile_plugin::<serde_json::Value>("share", ShareArgs { path: &path.to_string_lossy(), mime })
        .map(|_| ())
        .map_err(|e| e.to_string())
}
