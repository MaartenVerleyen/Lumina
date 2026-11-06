// The phone app's own side (docs/plans/android.md): a small Kotlin plugin (LuminaPlugin.kt in gen/android)
// for what only Android does: the camera roll (phone.rs), its share sheet, the backup's settings (phone_backup.rs).
use serde::Serialize;
use std::path::Path;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

#[derive(Clone)]
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

// Photos to another app, through Android's share sheet: files of the app's (downloaded originals in its cache)
// and photos of the phone's media store (id, video)
pub fn share(app: &AppHandle, files: &[std::path::PathBuf], media: &[(i64, bool)], mime: &str) -> Result<(), String> {
    let files: Vec<String> = files.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let media: Vec<serde_json::Value> = media.iter().map(|(id, video)| serde_json::json!({ "id": id, "video": video })).collect();
    call(app, "share", serde_json::json!({ "files": files, "media": media, "mime": mime })).map(|_| ())
}

// Files into the phone's gallery (Pictures/Lumina, Movies/Lumina); answers how many were saved
pub fn save_to_gallery(app: &AppHandle, files: &[std::path::PathBuf]) -> Result<usize, String> {
    let files: Vec<String> = files.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let answer = call(app, "saveToGallery", serde_json::json!({ "files": files }))?;
    Ok(answer["saved"].as_u64().unwrap_or(0) as usize)
}

// A file of the app's, or a photo of the media store, in another app
pub fn open_with(app: &AppHandle, file: Option<&std::path::PathBuf>, media: Option<(i64, bool)>, mime: &str) -> Result<(), String> {
    let files: Vec<String> = file.map(|p| p.to_string_lossy().to_string()).into_iter().collect();
    let media: Vec<serde_json::Value> = media.map(|(id, video)| serde_json::json!({ "id": id, "video": video })).into_iter().collect();
    call(app, "openWith", serde_json::json!({ "files": files, "media": media, "mime": mime })).map(|_| ())
}

// A short vibration
pub fn haptic(app: &AppHandle) {
    let _ = call(app, "haptic", serde_json::json!({}));
}

// A photo or video of the phone's media store (LuminaPlugin.listMedia)
#[derive(serde::Deserialize, Clone)]
pub struct PhoneMedia {
    pub id: i64,
    pub video: bool,
    pub name: String,
    pub size: u64,
    // Seconds since 1970 (the media store's own clock for changes)
    pub modified: i64,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    // When it was taken, in milliseconds since 1970 (0: not known)
    #[serde(default)]
    pub taken: i64,
    #[serde(default)]
    pub duration: Option<u64>,
    // Where it is on the phone ("DCIM/Camera/")
    #[serde(default)]
    pub folder: String,
}

#[derive(Serialize)]
struct MediaArgs<'a> {
    id: i64,
    video: bool,
    size: u32,
    mime: &'a str,
}

#[derive(serde::Deserialize)]
pub struct MediaList {
    pub items: Vec<PhoneMedia>,
}

#[derive(serde::Deserialize)]
struct ThumbAnswer {
    path: String,
}

fn plugin(app: &AppHandle) -> PluginHandle<Wry> {
    app.state::<Phone>().0.clone()
}

// Every photo and video of the phone (Android asks for access the first time)
pub fn list_media(app: &AppHandle) -> Result<Vec<PhoneMedia>, String> {
    plugin(app)
        .run_mobile_plugin::<MediaList>("listMedia", serde_json::json!({}))
        .map(|l| l.items)
        .map_err(|e| e.to_string())
}

// A command of the plugin with its answer as it comes (the backup's settings)
pub fn call(app: &AppHandle, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    plugin(app).run_mobile_plugin::<serde_json::Value>(command, args).map_err(|e| e.to_string())
}

// A thumbnail of it, made once into the app's cache
pub fn thumbnail(app: &AppHandle, id: i64, video: bool) -> Result<std::path::PathBuf, String> {
    plugin(app)
        .run_mobile_plugin::<ThumbAnswer>("thumbnail", MediaArgs { id, video, size: 480, mime: "" })
        .map(|t| t.path.into())
        .map_err(|e| e.to_string())
}

// Its file, to read (straight from Kotlin, not through the plugin: that waits for the UI thread)
pub fn open_media(id: i64, video: bool) -> Result<std::fs::File, String> {
    crate::android_jni::open_media(id, video)
}

