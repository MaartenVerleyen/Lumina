// The phone's own photos in the phone app (docs/plans/android.md, milestone 2): the camera roll from Android's
// media store (android.rs), as photos All photos shows next to a server's. Each photo's content id (Lumina's,
// so it matches the server's copy) and its EXIF (where it was taken, the camera) are read once from its file
// and kept in client.db by media store id; a photo read for the first time shows under a stand-in id until
// its content id is known, and the window is told when the reading is done. Thumbnails and originals are
// served by the lumina-phone protocol.
//
// Paths of these photos are "phone:p:<id>" (a photo) and "phone:v:<id>" (a video).
use crate::*;

// The root All photos knows the phone's photos by (its source "This phone")
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub const PHONE_ROOT: &str = "phone";

#[cfg(target_os = "android")]
mod imp {
    use super::*;
    use crate::android::{self, PhoneMedia};
    use crate::client_db;
    use rusqlite::params;
    use tauri::Emitter;

    static READING: AtomicBool = AtomicBool::new(false);
    // Where the plugin keeps the thumbnails it made (learnt from its first answer)
    static THUMB_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

    pub fn ensure_table(conn: &rusqlite::Connection) -> Result<(), String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS phone_media (
                 id INTEGER NOT NULL,
                 video INTEGER NOT NULL,
                 modified INTEGER NOT NULL,
                 size INTEGER NOT NULL,
                 hash TEXT NOT NULL,
                 PRIMARY KEY (id, video)
             );",
        )
        .map_err(|e| e.to_string())?;
        // Its folder on the phone ("DCIM/Camera/"), for the backup's choice of folders and the Albums tab;
        // added after the first phone builds, so the table may lack it
        let _ = conn.execute("ALTER TABLE phone_media ADD COLUMN folder TEXT NOT NULL DEFAULT ''", []);
        // Its EXIF as PhoneMeta (JSON); NULL for photos read before it was kept
        let _ = conn.execute("ALTER TABLE phone_media ADD COLUMN meta TEXT", []);
        Ok(())
    }

    // What a photo's file says beyond the media store: where and with what it was taken
    #[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
    pub struct PhoneMeta {
        lat: Option<f64>,
        lon: Option<f64>,
        location: String,
        camera_model: String,
        lens_model: Option<String>,
        focal_length: Option<String>,
        aperture: Option<String>,
        shutter_speed: Option<String>,
        iso: Option<String>,
        // Read from the original: Android strips the location (and so changes the bytes, and the content id)
        // until Lumina may see where photos were taken; read again once it may
        original: bool,
    }

    // A kept row is still good: read since it was last changed, and from the original when Lumina gets those
    fn current(meta: &Option<String>, originals: bool) -> Option<PhoneMeta> {
        let meta: PhoneMeta = serde_json::from_str(meta.as_deref()?).ok()?;
        (meta.original || !originals).then_some(meta)
    }

    fn stand_in(m: &PhoneMedia) -> String {
        format!("phone-{}{}", if m.video { "v" } else { "p" }, m.id)
    }

    fn photo_of(m: &PhoneMedia, hash: String, meta: Option<&PhoneMeta>) -> PhotoItem {
        let path = format!("phone:{}:{}", if m.video { "v" } else { "p" }, m.id);
        let when = if m.taken > 0 {
            std::time::UNIX_EPOCH + std::time::Duration::from_millis(m.taken as u64)
        } else {
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(m.modified.max(0) as u64)
        };
        let folder = m.folder.trim_end_matches('/');
        PhotoItem {
            hash,
            name: m.name.clone(),
            subfolder: if folder.is_empty() { "Root".into() } else { folder.replace('/', " / ") },
            path: path.clone(),
            thumb_path: path,
            size_kb: m.size / 1024,
            width: m.width,
            height: m.height,
            thumb_ready: true,
            captured_at: lumina_core::exif_meta::system_time_local_iso(when),
            media_type: if m.video { "video" } else { "photo" }.into(),
            duration_ms: m.duration,
            latitude: meta.and_then(|x| x.lat),
            longitude: meta.and_then(|x| x.lon),
            location: meta.map(|x| x.location.clone()).unwrap_or_default(),
            camera_model: meta.map(|x| x.camera_model.clone()).unwrap_or_default(),
            lens_model: meta.and_then(|x| x.lens_model.clone()),
            focal_length: meta.and_then(|x| x.focal_length.clone()),
            aperture: meta.and_then(|x| x.aperture.clone()),
            shutter_speed: meta.and_then(|x| x.shutter_speed.clone()),
            iso: meta.and_then(|x| x.iso.clone()),
            ..Default::default()
        }
    }

    pub async fn photos(app: AppHandle) -> Result<Vec<PhotoItem>, String> {
        let app2 = app.clone();
        let (photos, unread) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let media = android::list_media(&app2)?;
            let conn = client_db::open(&app2)?;
            ensure_table(&conn)?;
            let mut known = conn
                .prepare("SELECT hash, folder, meta FROM phone_media WHERE id = ?1 AND video = ?2 AND modified = ?3 AND size = ?4")
                .map_err(|e| e.to_string())?;
            let originals = crate::android_jni::reads_originals();
            let mut photos = Vec::with_capacity(media.len());
            let mut unread = Vec::new();
            let mut moved = Vec::new();
            for m in &media {
                let row = known
                    .query_row(params![m.id, m.video, m.modified, m.size as i64], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
                    })
                    .ok();
                match row {
                    Some((hash, folder, meta)) => {
                        if folder != m.folder {
                            moved.push(m);
                        }
                        let meta = current(&meta, originals);
                        // Kept from before its EXIF was, or from a copy without its location: read again, and
                        // shown as it was meanwhile
                        if meta.is_none() {
                            unread.push(m.clone());
                        }
                        photos.push(photo_of(m, hash, meta.as_ref()));
                    }
                    None => {
                        unread.push(m.clone());
                        photos.push(photo_of(m, stand_in(m), None));
                    }
                }
            }
            drop(known);
            remember_folders(&conn, &media, &moved)?;
            Ok((photos, unread))
        })
        .await
        .map_err(|e| e.to_string())??;
        if !unread.is_empty() && !READING.swap(true, Ordering::SeqCst) {
            tauri::async_runtime::spawn_blocking(move || {
                read_ids(&app, unread);
                READING.store(false, Ordering::SeqCst);
            });
        }
        Ok(photos)
    }

    // The content ids of photos seen for the first time; the window lists the phone again every 500 and at
    // the end, so they join their server copies
    fn read_ids(app: &AppHandle, media: Vec<PhoneMedia>) {
        let Ok(conn) = client_db::open(app) else { return };
        let total = media.len();
        for (n, m) in media.into_iter().enumerate() {
            if let Err(e) = read_id(&conn, &m) {
                eprintln!("[phone] {}: {e}", m.name);
            }
            if (n + 1) % 500 == 0 || n + 1 == total {
                let _ = app.emit("library-files-changed", PHONE_ROOT);
            }
        }
    }

    // The folders of photos whose folder changed (or wasn't kept yet), and photos gone from the phone forgotten,
    // so the folders' counts and the backup's are the phone's as it is now
    fn remember_folders(conn: &rusqlite::Connection, media: &[PhoneMedia], moved: &[&PhoneMedia]) -> Result<(), String> {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for m in moved {
            tx.execute("UPDATE phone_media SET folder = ?3 WHERE id = ?1 AND video = ?2", params![m.id, m.video, m.folder]).map_err(|e| e.to_string())?;
        }
        let present: HashSet<(i64, bool)> = media.iter().map(|m| (m.id, m.video)).collect();
        let kept: Vec<(i64, bool)> = {
            let mut stmt = tx.prepare("SELECT id, video FROM phone_media").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?))).map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok).collect()
        };
        for (id, video) in kept.into_iter().filter(|k| !present.contains(k)) {
            tx.execute("DELETE FROM phone_media WHERE id = ?1 AND video = ?2", params![id, video]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    // A photo's content id and EXIF, read from its file and kept
    pub fn read_id(conn: &rusqlite::Connection, m: &PhoneMedia) -> Result<String, String> {
        use std::os::fd::AsRawFd;
        let original = crate::android_jni::reads_originals();
        let mut file = android::open_media(m.id, m.video)?;
        let hash = lumina_core::imaging::content_hash_of_file(&mut file, m.size)?;
        // The EXIF readers take a path: the open file's own
        let path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
        let pass = if m.video {
            lumina_core::video_meta::extract_video_pass(&path)
        } else {
            lumina_core::exif_meta::extract_all_exif_with_head(&path, None)
        };
        let meta = PhoneMeta {
            lat: pass.lat,
            lon: pass.lon,
            location: pass.location,
            camera_model: pass.camera_model,
            lens_model: pass.lens_model,
            focal_length: pass.focal_length,
            aperture: pass.aperture,
            shutter_speed: pass.shutter_speed,
            iso: pass.iso,
            original,
        };
        drop(file);
        conn.execute(
            "INSERT OR REPLACE INTO phone_media (id, video, modified, size, hash, folder, meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![m.id, m.video, m.modified, m.size as i64, hash, m.folder, serde_json::to_string(&meta).unwrap_or_default()],
        )
        .map_err(|e| e.to_string())?;
        Ok(hash)
    }

    // Its content id as kept, while the photo is unchanged (same date and size) and was read as it is now
    pub fn known_id(conn: &rusqlite::Connection, m: &PhoneMedia) -> Option<String> {
        let (hash, meta) = conn
            .query_row(
                "SELECT hash, meta FROM phone_media WHERE id = ?1 AND video = ?2 AND modified = ?3 AND size = ?4",
                params![m.id, m.video, m.modified, m.size as i64],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .ok()?;
        current(&meta, crate::android_jni::reads_originals()).map(|_| hash)
    }

    pub fn parse(path: &str) -> Option<(bool, i64)> {
        let (video, id) = path.split_at(1);
        Some((video == "v", id.parse().ok()?))
    }

    type MediaResponse = tauri::http::Response<Vec<u8>>;

    fn status(code: u16) -> MediaResponse {
        tauri::http::Response::builder().status(code).body(Vec::new()).unwrap()
    }

    // The web view may keep it: scrolling back shows it without asking again
    fn thumb_response(bytes: Vec<u8>) -> MediaResponse {
        tauri::http::Response::builder()
            .header("Content-Type", "image/jpeg")
            .header("Cache-Control", "max-age=86400")
            .body(bytes)
            .unwrap()
    }

    // lumina-phone://localhost/<thumb|original>/<p|v><id>
    pub fn serve(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> MediaResponse {
        let path = crate::remote::percent_decode(request.uri().path().trim_start_matches('/'));
        let Some((kind, rest)) = path.split_once('/') else { return status(400) };
        let Some((video, id)) = parse(rest) else { return status(400) };
        if kind == "thumb" {
            // A thumbnail made before is read from the cache straight away; only a new one needs the plugin
            let cached = THUMB_DIR.get().map(|dir| dir.join(format!("{}{id}.jpg", if video { "v" } else { "p" })));
            if let Some(bytes) = cached.and_then(|p| fs::read(p).ok()) {
                return thumb_response(bytes);
            }
            let made = android::thumbnail(app, id, video).inspect(|p| {
                if let Some(dir) = p.parent() {
                    let _ = THUMB_DIR.set(dir.to_path_buf());
                }
            });
            return match made.and_then(|p| fs::read(p).map_err(|e| e.to_string())) {
                Ok(bytes) => thumb_response(bytes),
                Err(_) => status(404),
            };
        }
        original(video, id, request.headers().get("range").and_then(|v| v.to_str().ok()))
    }

    // A photo or video's file, with the range the player asks for (at most 8 MB at a time). The window's video
    // player gets videos from the app's video server on 127.0.0.1 (media_server.rs), which answers with this.
    pub fn original(video: bool, id: i64, range: Option<&str>) -> MediaResponse {
        use std::io::{Read, Seek, SeekFrom};
        let Ok(mut file) = android::open_media(id, video) else { return status(404) };
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        let range = range.and_then(|r| {
            let spec = r.strip_prefix("bytes=")?;
            let (a, b) = spec.split_once('-')?;
            let start: u64 = a.trim().parse().ok()?;
            let end = b.trim().parse::<u64>().ok().unwrap_or(size.saturating_sub(1));
            Some((start, end.min(size.saturating_sub(1)).min(start + 8 * 1024 * 1024 - 1)))
        });
        let mime = if video { "video/mp4" } else { "image/jpeg" };
        match range {
            Some((start, end)) if start <= end && start < size => {
                let mut bytes = vec![0u8; (end - start + 1) as usize];
                if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut bytes).is_err() {
                    return status(500);
                }
                tauri::http::Response::builder()
                    .status(206)
                    .header("Content-Type", mime)
                    .header("Accept-Ranges", "bytes")
                    .header("Content-Range", format!("bytes {start}-{end}/{size}"))
                    .body(bytes)
                    .unwrap()
            }
            _ => {
                let mut bytes = Vec::with_capacity(size as usize);
                if file.read_to_end(&mut bytes).is_err() {
                    return status(500);
                }
                tauri::http::Response::builder().header("Content-Type", mime).header("Accept-Ranges", "bytes").body(bytes).unwrap()
            }
        }
    }
}

#[cfg(target_os = "android")]
pub use imp::{ensure_table, known_id, original, parse, read_id, serve};

// The phone's photos and videos (the phone app's "This phone" in All photos)
#[tauri::command]
pub async fn phone_photos(app: AppHandle) -> Result<Vec<PhotoItem>, String> {
    #[cfg(target_os = "android")]
    {
        imp::photos(app).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

// A photo's media store id and kind, from its path ("phone:p:<id>"); None for a photo not of this phone
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn media_of(path: &str) -> Option<(i64, bool)> {
    let rest = path.strip_prefix("phone:")?;
    let (kind, id) = rest.split_once(':')?;
    Some((id.parse().ok()?, kind == "v"))
}

// The thumbnails of the phone's photos the app made (in its cache): how many, and their size
#[derive(serde::Serialize, Default)]
pub struct ThumbsInfo {
    count: usize,
    bytes: u64,
}

fn phone_thumbs_dir(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_cache_dir().ok().map(|d| d.join("phone-thumbs"))
}

#[tauri::command]
pub fn phone_thumbs_info(app: AppHandle) -> ThumbsInfo {
    let mut info = ThumbsInfo::default();
    if let Some(entries) = phone_thumbs_dir(&app).and_then(|d| fs::read_dir(d).ok()) {
        for e in entries.flatten() {
            info.count += 1;
            info.bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    info
}

// They are made again as the grid shows them
#[tauri::command]
pub fn clear_phone_thumbs(app: AppHandle) -> Result<(), String> {
    match phone_thumbs_dir(&app) {
        Some(dir) if dir.exists() => fs::remove_dir_all(dir).map_err(|e| format!("Couldn't empty the cache: {e}")),
        _ => Ok(()),
    }
}

// A short vibration (the phone app: a long-press selecting a photo)
#[tauri::command]
pub fn phone_haptic(app: AppHandle) {
    #[cfg(target_os = "android")]
    crate::android::haptic(&app);
    #[cfg(not(target_os = "android"))]
    let _ = app;
}
