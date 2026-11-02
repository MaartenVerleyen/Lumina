use crate::*;
use std::io::Write as _;

// Backing up the library and restoring it, also onto a new PC. A .luminabackup file is a zip with:
// - manifest.json: format, app version, date, computer, the library folders it covers and a few counts
// - library.db: a consistent copy of the database (VACUUM INTO, safe while Lumina runs)
// - settings.json: the app's settings as the frontend keeps them (opaque here)
// - faces/: the face crops shown in People (the only cached files that cannot be rebuilt by a rescan)
// Thumbnails, previews and models are left out: they rebuild by themselves.
//
// Restoring never swaps the database under a running app. The backup's database is prepared next to the
// live one (paths rewritten to the new library folders) as library.db.restore, and the next start moves
// it in after keeping a copy of the current database.

const FORMAT: u32 = 1;
const PENDING_RESTORE: &str = "library.db.restore";

#[derive(Serialize, Deserialize, Clone)]
pub struct BackupRoot {
    pub path: String,
    pub photos: usize,
    // Filled in when a backup is inspected: whether this folder exists on this PC
    #[serde(default)]
    pub exists: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct BackupManifest {
    pub format: u32,
    pub app_version: String,
    pub created_at: u64,
    pub computer: String,
    // The app data folder of the PC the backup was made on: face crop paths start with it
    pub app_dir: String,
    pub roots: Vec<BackupRoot>,
    pub photos: usize,
    pub rated: usize,
    pub people: usize,
    pub named_faces: usize,
    pub albums: usize,
    pub face_crops: usize,
}

#[derive(Serialize)]
pub struct BackupResult {
    pub path: String,
    pub bytes: u64,
    pub manifest: BackupManifest,
    // Older automatic backups removed to keep the newest `keep`
    pub removed: usize,
}

#[derive(Deserialize)]
pub struct RootRemap {
    pub from: String,
    pub to: String,
}

#[derive(Serialize)]
pub struct RestoreResult {
    // The settings saved in the backup, for the frontend to put back before restarting
    pub settings: Option<String>,
    pub photos: usize,
    pub remapped: usize,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------- paths ----------

fn is_sep(c: char) -> bool {
    c == '\\' || c == '/'
}

fn trim_seps(p: &str) -> &str {
    let t = p.trim_end_matches(is_sep);
    // Keep a drive root such as "D:\" whole
    if t.ends_with(':') && t.len() < p.len() {
        &p[..t.len() + 1]
    } else {
        t
    }
}

// Whether `path` is `root` or inside it (Windows paths: case-insensitive, either separator)
fn under_root(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches(is_sep);
    if root.is_empty() || path.len() < root.len() || !path.is_char_boundary(root.len()) {
        return false;
    }
    let (head, rest) = path.split_at(root.len());
    head.eq_ignore_ascii_case(root) && (rest.is_empty() || rest.starts_with(is_sep))
}

// `path` moved from the longest matching remap's `from` to its `to`; None when no remap covers it
pub fn remap_path(path: &str, remaps: &[(String, String)]) -> Option<String> {
    let (from, to) = remaps
        .iter()
        .filter(|(from, _)| under_root(path, from))
        .max_by_key(|(from, _)| from.trim_end_matches(is_sep).len())?;
    let rest = &path[from.trim_end_matches(is_sep).len()..];
    let to = to.trim_end_matches(is_sep);
    Some(format!("{to}{rest}"))
}

// The library folders the photos live in. Folders Lumina knows (opened libraries) are used as they are;
// photos outside them are grouped by their folder, cut to at most two levels below the drive
// (D:\Photos\2023\Summer → D:\Photos\2023), and folders inside another root are folded into it.
pub fn library_roots(paths: &[String], known: &[String]) -> Vec<BackupRoot> {
    let mut known: Vec<String> = known
        .iter()
        .map(|k| trim_seps(k.trim()).to_string())
        .filter(|k| !k.is_empty())
        .collect();
    known.sort_by_key(|k| std::cmp::Reverse(k.len()));

    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut add = |root: String| match counts.iter_mut().find(|(r, _)| r.eq_ignore_ascii_case(&root)) {
        Some((_, n)) => *n += 1,
        None => counts.push((root, 1)),
    };
    for path in paths {
        if let Some(k) = known.iter().find(|k| under_root(path, k)) {
            add(k.clone());
            continue;
        }
        let parent = match path.rfind(is_sep) {
            Some(i) => &path[..i],
            None => continue,
        };
        let parts: Vec<&str> = parent.split(is_sep).filter(|s| !s.is_empty()).collect();
        if parts.is_empty() {
            continue;
        }
        let keep = parts.len().min(3);
        let mut root = parts[..keep].join("\\");
        if keep == 1 {
            root.push('\\');
        }
        add(root);
    }

    // Fold roots that sit inside another root
    counts.sort_by_key(|(r, _)| r.len());
    let mut roots: Vec<BackupRoot> = Vec::new();
    for (root, n) in counts {
        match roots.iter_mut().find(|r| under_root(&root, &r.path)) {
            Some(outer) => outer.photos += n,
            None => roots.push(BackupRoot { path: root, photos: n, exists: false }),
        }
    }
    roots.sort_by(|a, b| b.photos.cmp(&a.photos).then_with(|| a.path.cmp(&b.path)));
    roots
}

// A file name made safe for Windows, used for the backup's name
fn safe_stem(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '-' } else { c })
        .collect();
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() { "Lumina backup".to_string() } else { s }
}

// ---------- backup ----------

fn count(conn: &Connection, sql: &str) -> usize {
    conn.query_row(sql, [], |r| r.get::<_, i64>(0)).map(|n| n.max(0) as usize).unwrap_or(0)
}

fn build_manifest(conn: &Connection, known_roots: &[String], app_dir: &Path, face_crops: usize) -> Result<BackupManifest, String> {
    let mut stmt = conn
        .prepare("SELECT current_path FROM photos WHERE current_path IS NOT NULL AND current_path != ''")
        .map_err(|e| e.to_string())?;
    let paths: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(BackupManifest {
        format: FORMAT,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: now_secs(),
        computer: std::env::var("COMPUTERNAME").unwrap_or_default(),
        app_dir: app_dir.to_string_lossy().into_owned(),
        roots: library_roots(&paths, known_roots),
        photos: paths.len(),
        rated: count(conn, "SELECT COUNT(*) FROM photos WHERE rating > 0 OR flag IS NOT NULL OR color_label IS NOT NULL"),
        people: count(conn, "SELECT COUNT(*) FROM people"),
        named_faces: count(conn, "SELECT COUNT(*) FROM photo_faces WHERE person_name IS NOT NULL AND person_name != ''"),
        albums: count(conn, "SELECT COUNT(*) FROM albums"),
        face_crops,
    })
}

fn write_backup(app: &dyn Host, dest_dir: &Path, stem: &str, known_roots: &[String], settings: &str) -> Result<(PathBuf, BackupManifest), String> {
    let app_dir = get_app_storage_dir(app);
    fs::create_dir_all(dest_dir).map_err(|e| format!("Could not create {}: {e}", dest_dir.display()))?;

    // A consistent, compacted copy of the database, taken while Lumina keeps running
    let snapshot = app_dir.join("backup-snapshot.db");
    let _ = fs::remove_file(&snapshot);
    {
        let conn = open_global_db(app)?;
        conn.execute("VACUUM INTO ?1", params![snapshot.to_string_lossy()])
            .map_err(|e| format!("Could not copy the library database: {e}"))?;
    }
    let result = (|| {
        let faces: Vec<PathBuf> = fs::read_dir(app_dir.join("faces"))
            .map(|rd| {
                rd.filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("jpg")))
                    .collect()
            })
            .unwrap_or_default();
        let manifest = {
            let conn = Connection::open(&snapshot).map_err(|e| e.to_string())?;
            build_manifest(&conn, known_roots, &app_dir, faces.len())?
        };

        let mut target = dest_dir.join(format!("{stem}.luminabackup"));
        let mut n = 2;
        while target.exists() {
            target = dest_dir.join(format!("{stem} ({n}).luminabackup"));
            n += 1;
        }
        let part = target.with_extension("luminabackup.part");
        let write = || -> Result<(), String> {
            let file = fs::File::create(&part).map_err(|e| e.to_string())?;
            let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
            let deflate = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .large_file(true);
            // Face crops are JPEGs already: compressing them again only costs time
            let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

            zip.start_file("manifest.json", deflate).map_err(|e| e.to_string())?;
            zip.write_all(serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?.as_bytes())
                .map_err(|e| e.to_string())?;
            zip.start_file("settings.json", deflate).map_err(|e| e.to_string())?;
            zip.write_all(settings.as_bytes()).map_err(|e| e.to_string())?;
            zip.start_file("library.db", deflate).map_err(|e| e.to_string())?;
            std::io::copy(&mut fs::File::open(&snapshot).map_err(|e| e.to_string())?, &mut zip).map_err(|e| e.to_string())?;
            for face in &faces {
                let Some(name) = face.file_name().and_then(|n| n.to_str()) else { continue };
                // A crop removed while backing up is simply left out
                let Ok(mut f) = fs::File::open(face) else { continue };
                zip.start_file(format!("faces/{name}"), stored).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
            }
            zip.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())?;
            Ok(())
        };
        if let Err(e) = write() {
            let _ = fs::remove_file(&part);
            return Err(format!("Could not write the backup: {e}"));
        }
        fs::rename(&part, &target).map_err(|e| e.to_string())?;
        Ok((target, manifest))
    })();
    let _ = fs::remove_file(&snapshot);
    result
}

// Removes the oldest backups named "<prefix>…" in `dir` beyond the newest `keep`
fn prune_backups(dir: &Path, prefix: &str, keep: usize) -> usize {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    name.starts_with(prefix) && name.ends_with(".luminabackup")
                })
                .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
                .collect()
        })
        .unwrap_or_default();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.iter().skip(keep).filter(|(_, p)| fs::remove_file(p).is_ok()).count()
}

// Backs up the library into `dest_dir`/`name`.luminabackup. `known_roots` are the library folders the
// frontend knows (they name the roots in the manifest); `settings` is stored as given. With `keep`, older
// backups whose name starts like this one's (up to its date) are removed beyond the newest `keep`.
#[tauri::command]
pub async fn backup_library(
    app: AppHandle,
    dest_dir: String,
    name: String,
    known_roots: Vec<String>,
    settings: String,
    keep: Option<usize>,
    keep_prefix: Option<String>,
) -> Result<BackupResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(dest_dir.trim());
        if dest_dir.trim().is_empty() {
            return Err("Choose a folder for the backup first.".to_string());
        }
        let (path, manifest) = write_backup(&app, &dir, &safe_stem(&name), &known_roots, &settings)?;
        let removed = match (keep, keep_prefix) {
            (Some(keep), Some(prefix)) if !prefix.is_empty() => prune_backups(&dir, &prefix, keep.max(1)),
            _ => 0,
        };
        let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Ok(BackupResult { path: path.to_string_lossy().into_owned(), bytes, manifest, removed })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- restore ----------

fn open_backup(path: &str) -> Result<zip::ZipArchive<std::io::BufReader<fs::File>>, String> {
    let file = fs::File::open(path).map_err(|e| format!("Could not open the backup: {e}"))?;
    zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|_| "This is not a Lumina backup (the file is not a valid zip).".to_string())
}

fn read_manifest(archive: &mut zip::ZipArchive<std::io::BufReader<fs::File>>) -> Result<BackupManifest, String> {
    let mut text = String::new();
    archive
        .by_name("manifest.json")
        .map_err(|_| "This is not a Lumina backup (no manifest).".to_string())?
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    let manifest: BackupManifest = serde_json::from_str(&text).map_err(|e| format!("The backup's manifest is damaged: {e}"))?;
    if manifest.format > FORMAT {
        return Err(format!(
            "This backup was made by a newer Lumina ({}). Update Lumina first, then restore it.",
            manifest.app_version
        ));
    }
    if archive.by_name("library.db").is_err() {
        return Err("The backup has no library database.".to_string());
    }
    Ok(manifest)
}

// What a backup holds, with each library folder marked as present on this PC or not
#[tauri::command]
pub async fn inspect_backup(path: String) -> Result<BackupManifest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut archive = open_backup(&path)?;
        let mut manifest = read_manifest(&mut archive)?;
        for root in &mut manifest.roots {
            root.exists = Path::new(&root.path).is_dir();
        }
        Ok(manifest)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Rewrites every stored path in `conn` through `remaps`, in one transaction. Returns how many photos moved.
pub fn rewrite_paths(conn: &mut Connection, remaps: &[(String, String)]) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut moved = 0;
    {
        let rows: Vec<(String, Option<String>, Option<String>)> = {
            let mut stmt = tx
                .prepare("SELECT hash, current_path, staged_target FROM photos")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();
            rows
        };
        let mut update = tx
            .prepare("UPDATE photos SET current_path = ?2, staged_target = ?3 WHERE hash = ?1")
            .map_err(|e| e.to_string())?;
        for (hash, path, staged) in rows {
            let new_path = path.as_deref().and_then(|p| remap_path(p, remaps));
            let new_staged = staged.as_deref().and_then(|p| remap_path(p, remaps));
            if new_path.is_none() && new_staged.is_none() {
                continue;
            }
            if new_path.is_some() {
                moved += 1;
            }
            update
                .execute(params![hash, new_path.or(path), new_staged.or(staged)])
                .map_err(|e| e.to_string())?;
        }

        for (table, column, key) in [("photo_faces", "face_thumb", "face_id"), ("people", "cover_face_thumb", "id")] {
            let rows: Vec<(rusqlite::types::Value, String)> = {
                let mut stmt = tx
                    .prepare(&format!("SELECT {key}, {column} FROM {table} WHERE {column} IS NOT NULL AND {column} != ''"))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(|e| e.to_string())?
                    .filter_map(Result::ok)
                    .collect();
                rows
            };
            let mut update = tx
                .prepare(&format!("UPDATE {table} SET {column} = ?2 WHERE {key} = ?1"))
                .map_err(|e| e.to_string())?;
            for (id, thumb) in rows {
                if let Some(new) = remap_path(&thumb, remaps) {
                    update.execute(params![id, new]).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(moved)
}

// Prepares a backup for the next start: the database is checked, its paths rewritten (library folders as
// chosen in `remaps`, face crops to this PC's app data folder) and left as library.db.restore; the face
// crops are put in place. The frontend restores the returned settings and restarts Lumina.
#[tauri::command]
pub async fn restore_library(app: AppHandle, path: String, remaps: Vec<RootRemap>) -> Result<RestoreResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app_dir = get_app_storage_dir(&app);
        let mut archive = open_backup(&path)?;
        let manifest = read_manifest(&mut archive)?;

        let staged = app_dir.join(format!("{PENDING_RESTORE}.part"));
        let _ = fs::remove_file(&staged);
        {
            let mut entry = archive.by_name("library.db").map_err(|e| e.to_string())?;
            let mut out = fs::File::create(&staged).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("Could not unpack the database: {e}"))?;
        }
        let prepared = (|| {
            let mut conn = Connection::open(&staged).map_err(|e| e.to_string())?;
            let check: String = conn
                .query_row("PRAGMA quick_check", [], |r| r.get(0))
                .map_err(|e| format!("The backup's database is damaged: {e}"))?;
            if check != "ok" {
                return Err(format!("The backup's database is damaged: {check}"));
            }
            let mut pairs: Vec<(String, String)> = remaps
                .iter()
                .filter(|r| !r.from.trim().is_empty() && !r.to.trim().is_empty() && !r.from.trim().eq_ignore_ascii_case(r.to.trim()))
                .map(|r| (r.from.trim().to_string(), r.to.trim().to_string()))
                .collect();
            let here = app_dir.to_string_lossy().into_owned();
            if !manifest.app_dir.is_empty() && !manifest.app_dir.eq_ignore_ascii_case(&here) {
                pairs.push((manifest.app_dir.clone(), here));
            }
            let photos = count(&conn, "SELECT COUNT(*) FROM photos");
            let remapped = if pairs.is_empty() { 0 } else { rewrite_paths(&mut conn, &pairs)? };
            Ok((photos, remapped))
        })();
        let (photos, remapped) = match prepared {
            Ok(v) => v,
            Err(e) => {
                let _ = fs::remove_file(&staged);
                return Err(e);
            }
        };

        // Face crops: written next to the existing ones (same names are the same crops)
        let faces_dir = app_dir.join("faces");
        let _ = fs::create_dir_all(&faces_dir);
        let mut settings = None;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let Ok(name) = entry.name().map(|n| n.to_string()) else { continue };
            if name == "settings.json" {
                let mut text = String::new();
                if entry.read_to_string(&mut text).is_ok() && !text.trim().is_empty() {
                    settings = Some(text);
                }
                continue;
            }
            let Some(file) = name.strip_prefix("faces/") else { continue };
            // Only plain file names: nothing in a backup may write outside the faces folder
            if file.is_empty() || file.contains(['/', '\\', ':']) || file.starts_with('.') {
                continue;
            }
            if let Ok(mut out) = fs::File::create(faces_dir.join(file)) {
                let _ = std::io::copy(&mut entry, &mut out);
            }
        }

        fs::rename(&staged, app_dir.join(PENDING_RESTORE)).map_err(|e| e.to_string())?;
        Ok(RestoreResult { settings, photos, remapped })
    })
    .await
    .map_err(|e| e.to_string())?
}

// At start, before anything opens the database: moves a prepared restore in. The current database is kept
// as library-before-restore-<time>.db.
pub fn apply_pending_restore(app_dir: &Path) {
    let pending = app_dir.join(PENDING_RESTORE);
    if !pending.exists() {
        return;
    }
    let live = app_dir.join("library.db");
    if live.exists() {
        let safety = app_dir.join(format!("library-before-restore-{}.db", now_secs()));
        let copied = Connection::open(&live)
            .and_then(|c| c.execute("VACUUM INTO ?1", params![safety.to_string_lossy()]))
            .is_ok();
        if !copied && fs::copy(&live, &safety).is_err() {
            // Without a safety copy the current library is not replaced
            eprintln!("Lumina: restore postponed, could not keep a copy of the current library");
            return;
        }
    }
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(app_dir.join(format!("library.db{suffix}")));
    }
    if let Err(e) = fs::rename(&pending, &live) {
        eprintln!("Lumina: could not restore the library: {e}");
    }
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

// ---------- CSV ----------

pub fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// EXIF's "2024:04:12 12:05:26" as "2024-04-12 12:05:26" (only the date part's colons)
pub fn csv_date(captured_at: &str) -> String {
    captured_at
        .char_indices()
        .map(|(i, c)| if c == ':' && (i == 4 || i == 7) { '-' } else { c })
        .collect()
}

// Ratings, flags, labels, tags, people, captions and places as a CSV file, for spreadsheets and other apps.
// `root_folder` limits it to one library; without it every photo Lumina knows is listed.
#[tauri::command]
pub async fn export_library_csv(app: AppHandle, dest_path: String, root_folder: Option<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let prefix = make_folder_prefix(root_folder.as_deref());
        let mut stmt = conn
            .prepare(
                "SELECT p.current_path, p.captured_at, p.rating, p.flag, p.color_label, p.ai_caption, p.location,
                        p.latitude, p.longitude, p.camera_model,
                        (SELECT group_concat(tag, '; ') FROM photo_tags t WHERE t.hash = p.hash),
                        (SELECT group_concat(person_name, '; ') FROM photo_people pp WHERE pp.hash = p.hash)
                 FROM photos p
                 WHERE p.current_path LIKE ?1 ESCAPE '!'
                 ORDER BY p.current_path",
            )
            .map_err(|e| e.to_string())?;
        let mut out = String::from("\u{feff}path,file,captured,rating,flag,label,tags,people,caption,place,latitude,longitude,camera\r\n");
        let mut rows = 0;
        let mut query = stmt.query(params![prefix]).map_err(|e| e.to_string())?;
        while let Some(r) = query.next().map_err(|e| e.to_string())? {
            let path: String = r.get::<_, Option<String>>(0).map_err(|e| e.to_string())?.unwrap_or_default();
            let text = |i: usize| r.get::<_, Option<String>>(i).ok().flatten().unwrap_or_default();
            let num = |i: usize| r.get::<_, Option<f64>>(i).ok().flatten().map(|v| v.to_string()).unwrap_or_default();
            let file = path.rsplit(is_sep).next().unwrap_or("").to_string();
            let captured = csv_date(&text(1));
            let rating = r.get::<_, Option<i64>>(2).ok().flatten().unwrap_or(0);
            let fields = [
                path.clone(),
                file,
                captured,
                if rating > 0 { rating.to_string() } else { String::new() },
                text(3),
                text(4),
                text(10),
                text(11),
                text(5),
                text(6),
                num(7),
                num(8),
                text(9),
            ];
            out.push_str(&fields.iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(","));
            out.push_str("\r\n");
            rows += 1;
        }
        fs::write(&dest_path, out).map_err(|e| format!("Could not write {dest_path}: {e}"))?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}
