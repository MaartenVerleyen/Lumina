use crate::files::FileOpFailure;
use crate::*;
use std::time::{Duration, UNIX_EPOCH};

// Importing photos from a memory card, USB drive or any folder into the library: dated folders, duplicates
// skipped, RAW+JPEG pairs and sidecars kept together, every copy verified before it counts.

use crate::video_meta::VIDEO_EXTENSIONS;
const SIDECAR_EXTENSIONS: &[&str] = &["xmp", "aae", "thm"];
pub const IMPORT_CANCELLED: &str = "Import cancelled";

static IMPORT_CANCEL: AtomicBool = AtomicBool::new(false);
static IMPORT_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct ImportSource {
    pub path: String,
    pub label: String,
    pub has_dcim: bool,
}

#[derive(Deserialize, Clone)]
pub struct ImportOptions {
    pub source: String,
    pub dest_root: String,
    // "year-month" (2024/2024-06), "year-month-day" (2024/2024-06-15) or "flat"
    pub pattern: String,
    pub skip_duplicates: bool,
    pub delete_after: bool,
    pub eject_after: bool,
}

#[derive(Serialize)]
pub struct ImportPreview {
    pub photos: usize,
    pub videos: usize,
    pub new_count: usize,
    pub duplicates: usize,
    pub new_bytes: u64,
    pub first_date: Option<String>,
    pub last_date: Option<String>,
    // Folders the new photos go to (relative to the destination), a few for the preview
    pub folders: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ImportProgress {
    pub stage: String,
    pub completed: usize,
    pub total: usize,
    pub copied: usize,
    pub skipped: usize,
    pub failed: usize,
    pub current: String,
    pub done: bool,
}

#[derive(Serialize)]
pub struct ImportResult {
    pub copied: usize,
    pub skipped: usize,
    pub deleted: usize,
    pub failures: Vec<FileOpFailure>,
    // Full paths of the photos that were copied (the app selects them after the rescan)
    pub new_paths: Vec<String>,
    pub cancelled: bool,
    pub ejected: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum FileKind {
    Photo,
    Video,
    Sidecar,
}

pub fn file_kind(path: &Path) -> Option<FileKind> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    if PHOTO_EXTENSIONS.contains(&ext.as_str()) {
        Some(FileKind::Photo)
    } else if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        Some(FileKind::Video)
    } else if SIDECAR_EXTENSIONS.contains(&ext.as_str()) {
        Some(FileKind::Sidecar)
    } else {
        None
    }
}

// "2024:06:15 18:30:00" / "2024-06-15 ..." -> "2024-06-15"; None for anything that isn't a plausible date
pub fn day_of(captured_at: &str) -> Option<String> {
    let d: String = captured_at.chars().take(10).map(|c| if c == ':' { '-' } else { c }).collect();
    let b = d.as_bytes();
    let digits = |r: std::ops::Range<usize>| r.into_iter().all(|i| b.get(i).is_some_and(|c| c.is_ascii_digit()));
    if d.len() != 10 || !digits(0..4) || !digits(5..7) || !digits(8..10) || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let year: u32 = d[0..4].parse().ok()?;
    let month: u32 = d[5..7].parse().ok()?;
    let day: u32 = d[8..10].parse().ok()?;
    ((1971..=2100).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day)).then_some(d)
}

// Calendar date (UTC) of a Unix time; cameras set a file's modified time when the photo is taken
pub fn day_from_unix(secs: u64) -> String {
    // Howard Hinnant's civil-from-days
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

// The folder (relative to the destination) for a photo taken on `day`
pub fn date_folder(pattern: &str, day: Option<&str>) -> PathBuf {
    match (pattern, day) {
        ("flat", _) => PathBuf::new(),
        (_, None) => PathBuf::from("Unknown date"),
        ("year-month-day", Some(d)) => PathBuf::from(&d[0..4]).join(d),
        (_, Some(d)) => PathBuf::from(&d[0..4]).join(&d[0..7]),
    }
}

// The first suffix ("", "_2", "_3" ...) under which none of `names` exists in `dir`, so a RAW, its JPEG and
// its sidecar keep matching names when they have to be renamed
pub fn free_suffix(dir: &Path, names: &[String], exists: impl Fn(&Path) -> bool) -> String {
    for n in 1.. {
        let suffix = if n == 1 { String::new() } else { format!("_{n}") };
        if names.iter().all(|name| !exists(&dir.join(with_suffix(name, &suffix)))) {
            return suffix;
        }
    }
    unreachable!()
}

pub fn with_suffix(name: &str, suffix: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{}{}{}", &name[..dot], suffix, &name[dot..]),
        _ => format!("{name}{suffix}"),
    }
}

pub(crate) struct PlannedFile {
    src: PathBuf,
    name: String,
    size: u64,
    hash: Option<String>,
    kind: FileKind,
    duplicate: bool,
}

pub(crate) struct PlannedGroup {
    day: Option<String>,
    files: Vec<PlannedFile>,
}

impl PlannedGroup {
    fn is_duplicate(&self) -> bool {
        // A group is a duplicate when every photo/video in it is already in the library
        let media: Vec<&PlannedFile> = self.files.iter().filter(|f| f.kind != FileKind::Sidecar).collect();
        !media.is_empty() && media.iter().all(|f| f.duplicate)
    }
}

fn modified_day(path: &Path) -> Option<String> {
    let secs = fs::metadata(path).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    day_of(&day_from_unix(secs))
}

fn hash_in_library(conn: &Connection, hash: &str) -> bool {
    let Ok(mut stmt) = conn.prepare_cached("SELECT current_path FROM photos WHERE hash = ?1") else {
        return false;
    };
    let paths: Vec<String> = stmt
        .query_map(params![hash], |r| r.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default();
    paths.iter().any(|p| Path::new(p).exists())
}

// Reads the source: every photo, video and sidecar, grouped by folder and name (IMG_1234.CR3 + IMG_1234.JPG
// + IMG_1234.xmp), with capture dates and duplicates already in the library marked
pub(crate) fn plan(conn: &Connection, source: &Path, progress: &dyn Fn(usize)) -> Result<Vec<PlannedGroup>, String> {
    let mut files: Vec<PathBuf> = WalkDir::new(source)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            e.depth() == 0 || !(name.starts_with('.') || name.starts_with('$') || name == "System Volume Information")
        })
        .flatten()
        .filter(|e| e.file_type().is_file() && file_kind(e.path()).is_some())
        .map(|e| e.into_path())
        .collect();
    files.sort();

    let mut groups: Vec<PlannedGroup> = Vec::new();
    let mut group_of: HashMap<(PathBuf, String), usize> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (i, path) in files.into_iter().enumerate() {
        if IMPORT_CANCEL.load(Ordering::Relaxed) {
            return Err(IMPORT_CANCELLED.into());
        }
        progress(i);
        let kind = file_kind(&path).unwrap();
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
        let key = (path.parent().map(Path::to_path_buf).unwrap_or_default(), stem);
        let idx = *group_of.entry(key).or_insert_with(|| {
            groups.push(PlannedGroup { day: None, files: Vec::new() });
            groups.len() - 1
        });

        let (hash, day) = if kind == FileKind::Sidecar {
            (None, None)
        } else {
            match hash_and_read_head(&path, size) {
                Ok((hash, head)) => {
                    // A video's recording date comes from its container (the same pass reads it)
                    let day = day_of(&extract_all_exif_with_head(&path, Some(&head)).captured_at);
                    (Some(hash), day.or_else(|| modified_day(&path)))
                }
                Err(_) => (None, modified_day(&path)),
            }
        };
        let duplicate = hash
            .as_deref()
            .is_some_and(|h| !seen.insert(h.to_string()) || hash_in_library(conn, h));
        let group = &mut groups[idx];
        // The photo's own date wins over a video's or a file date
        if (kind == FileKind::Photo && day.is_some()) || group.day.is_none() {
            group.day = day.or(group.day.take());
        }
        group.files.push(PlannedFile { src: path, name, size, hash, kind, duplicate });
    }
    // Sidecars without a photo or video next to them are left on the card
    groups.retain(|g| g.files.iter().any(|f| f.kind != FileKind::Sidecar));
    for g in &mut groups {
        if g.day.is_none() {
            g.day = g.files.iter().find_map(|f| modified_day(&f.src));
        }
    }
    Ok(groups)
}

#[tauri::command]
pub async fn preview_import(app: AppHandle, source: String, pattern: String) -> Result<ImportPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        IMPORT_CANCEL.store(false, Ordering::Relaxed);
        let conn = open_global_db(&app)?;
        let groups = plan(&conn, Path::new(&source), &|_| {})?;
        let media = || groups.iter().flat_map(|g| g.files.iter()).filter(|f| f.kind != FileKind::Sidecar);
        let new_groups: Vec<&PlannedGroup> = groups.iter().filter(|g| !g.is_duplicate()).collect();
        let mut days: Vec<&str> = new_groups.iter().filter_map(|g| g.day.as_deref()).collect();
        days.sort();
        let mut folders: Vec<String> = new_groups
            .iter()
            .map(|g| date_folder(&pattern, g.day.as_deref()).to_string_lossy().replace('\\', "/"))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        folders.sort();
        Ok(ImportPreview {
            photos: media().filter(|f| f.kind == FileKind::Photo).count(),
            videos: media().filter(|f| f.kind == FileKind::Video).count(),
            new_count: new_groups.iter().flat_map(|g| g.files.iter()).filter(|f| f.kind != FileKind::Sidecar).count(),
            duplicates: media().filter(|f| f.duplicate).count(),
            new_bytes: new_groups.iter().flat_map(|g| g.files.iter()).map(|f| f.size).sum(),
            first_date: days.first().map(|d| d.to_string()),
            last_date: days.last().map(|d| d.to_string()),
            folders,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Copies to "<name>.part", checks size and content hash against the original, then gives it its real name
fn copy_verified(src: &Path, dst: &Path, size: u64, hash: Option<&str>) -> Result<(), String> {
    let part = dst.with_file_name(format!("{}.part", dst.file_name().unwrap_or_default().to_string_lossy()));
    fs::copy(src, &part).map_err(|e| format!("Could not copy: {e}"))?;
    let matches = fs::metadata(&part).map(|m| m.len() == size).unwrap_or(false)
        && hash.map_or(true, |h| hash_and_read_head(&part, size).map(|(x, _)| x == h).unwrap_or(false));
    if !matches {
        let _ = fs::remove_file(&part);
        return Err("The copy did not match the original (card or disk error?)".into());
    }
    fs::rename(&part, dst).map_err(|e| {
        let _ = fs::remove_file(&part);
        format!("Could not finish the copy: {e}")
    })
}

#[cfg(windows)]
fn eject_drive(root: &str) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let letter = root.trim_end_matches(['\\', '/']);
    std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("(New-Object -ComObject Shell.Application).Namespace(17).ParseName('{letter}').InvokeVerb('Eject')"),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn eject_drive(_root: &str) -> bool {
    false
}

fn run_import(app: &dyn Host, options: &ImportOptions) -> Result<ImportResult, String> {
    let emit = |p: ImportProgress| {
        let _ = emit_to(&app, "import-progress", p);
    };
    let conn = open_global_db(app)?;
    let source = Path::new(&options.source);
    let dest_root = Path::new(&options.dest_root);
    if !source.is_dir() {
        return Err(format!("{} is not available", options.source));
    }
    let reading = |i: usize| {
        if i % 25 == 0 {
            emit(ImportProgress {
                stage: "Reading".into(),
                completed: i,
                total: 0,
                copied: 0,
                skipped: 0,
                failed: 0,
                current: String::new(),
                done: false,
            });
        }
    };
    let groups = plan(&conn, source, &reading)?;
    let total: usize = groups.iter().map(|g| g.files.len()).sum();
    let mut result = ImportResult {
        copied: 0,
        skipped: 0,
        deleted: 0,
        failures: Vec::new(),
        new_paths: Vec::new(),
        cancelled: false,
        ejected: false,
    };
    let mut copied_sources: Vec<PathBuf> = Vec::new();
    let mut completed = 0;

    for group in &groups {
        if IMPORT_CANCEL.load(Ordering::Relaxed) {
            result.cancelled = true;
            break;
        }
        if options.skip_duplicates && group.is_duplicate() {
            completed += group.files.len();
            result.skipped += group.files.iter().filter(|f| f.kind != FileKind::Sidecar).count();
            continue;
        }
        let dir = dest_root.join(date_folder(&options.pattern, group.day.as_deref()));
        if let Err(e) = fs::create_dir_all(&dir) {
            for f in &group.files {
                result.failures.push(FileOpFailure { file: f.src.to_string_lossy().into(), error: e.to_string() });
            }
            completed += group.files.len();
            continue;
        }
        // Already there under the same name (an earlier import the library hasn't scanned yet): skip
        let files: Vec<&PlannedFile> = group
            .files
            .iter()
            .filter(|f| {
                let existing = dir.join(&f.name);
                let same = f.hash.as_deref().is_some_and(|h| {
                    existing.exists() && hash_and_read_head(&existing, f.size).map(|(x, _)| x == h).unwrap_or(false)
                });
                if same && options.skip_duplicates {
                    completed += 1;
                    result.skipped += 1;
                }
                !(same && options.skip_duplicates)
            })
            .collect();
        let names: Vec<String> = files.iter().map(|f| f.name.clone()).collect();
        let suffix = free_suffix(&dir, &names, |p| p.exists());
        for f in files {
            let dst = dir.join(with_suffix(&f.name, &suffix));
            emit(ImportProgress {
                stage: "Copying".into(),
                completed,
                total,
                copied: result.copied,
                skipped: result.skipped,
                failed: result.failures.len(),
                current: f.name.clone(),
                done: false,
            });
            match copy_verified(&f.src, &dst, f.size, f.hash.as_deref()) {
                Ok(()) => {
                    if f.kind != FileKind::Sidecar {
                        result.copied += 1;
                    }
                    if f.kind != FileKind::Sidecar {
                        result.new_paths.push(dst.to_string_lossy().into_owned());
                    }
                    copied_sources.push(f.src.clone());
                }
                Err(error) => result.failures.push(FileOpFailure { file: f.src.to_string_lossy().into(), error }),
            }
            completed += 1;
        }
    }

    // Only files whose copy was verified are removed from the source
    if options.delete_after {
        for src in &copied_sources {
            if fs::remove_file(src).is_ok() {
                result.deleted += 1;
            }
        }
    }
    if options.eject_after && !result.cancelled {
        result.ejected = eject_drive(&options.source);
    }
    emit(ImportProgress {
        stage: "Done".into(),
        completed: total,
        total,
        copied: result.copied,
        skipped: result.skipped,
        failed: result.failures.len(),
        current: String::new(),
        done: true,
    });
    Ok(result)
}

#[tauri::command]
pub async fn start_import(app: AppHandle, options: ImportOptions) -> Result<ImportResult, String> {
    if IMPORT_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("An import is already running".into());
    }
    IMPORT_CANCEL.store(false, Ordering::Relaxed);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let r = run_import(&app, &options);
        if let Ok(res) = &r {
            emit_perf(&app, "Import", started, res.copied, format!("{} skipped, {} failed", res.skipped, res.failures.len()));
        }
        r
    })
    .await
    .map_err(|e| e.to_string());
    IMPORT_RUNNING.store(false, Ordering::SeqCst);
    result?
}

#[tauri::command]
pub fn cancel_import() {
    IMPORT_CANCEL.store(true, Ordering::Relaxed);
}

// ---------- removable drives ----------

#[cfg(windows)]
pub fn removable_drives() -> Vec<ImportSource> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
    const DRIVE_REMOVABLE: u32 = 2;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let root = format!("{}:\\", (b'A' + i as u8) as char);
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        if unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } != DRIVE_REMOVABLE {
            continue;
        }
        let mut name = [0u16; 261];
        // Fails for an empty card reader: nothing to import there
        if unsafe { GetVolumeInformationW(PCWSTR(wide.as_ptr()), Some(&mut name), None, None, None, None) }.is_err() {
            continue;
        }
        let len = name.iter().position(|&c| c == 0).unwrap_or(0);
        let label = String::from_utf16_lossy(&name[..len]);
        out.push(ImportSource {
            label: if label.is_empty() { "Removable drive".into() } else { label },
            has_dcim: Path::new(&root).join("DCIM").is_dir(),
            path: root,
        });
    }
    out
}

#[cfg(not(windows))]
pub fn removable_drives() -> Vec<ImportSource> {
    Vec::new()
}

#[tauri::command]
pub fn list_import_sources() -> Vec<ImportSource> {
    removable_drives()
}

// Memory cards and USB drives with a DCIM folder (cameras, phones as drives): the app offers to import
pub fn start_drive_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut known: HashSet<String> = removable_drives().into_iter().map(|d| d.path).collect();
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let now = removable_drives();
            for d in &now {
                if !known.contains(&d.path) && d.has_dcim {
                    let _ = emit_to(&app, "removable-drive-arrived", d.clone());
                }
            }
            known = now.into_iter().map(|d| d.path).collect();
        }
    });
}

// For tests: each group's day, and its files as (name, duplicate)
#[cfg(test)]
pub(crate) fn plan_summary(conn: &Connection, source: &Path) -> Vec<(Option<String>, Vec<(String, bool)>)> {
    plan(conn, source, &|_| {})
        .unwrap()
        .into_iter()
        .map(|g| (g.day, g.files.into_iter().map(|f| (f.name, f.duplicate)).collect()))
        .collect()
}
