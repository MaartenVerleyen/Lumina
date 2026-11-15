use crate::*;
use files::FileOpFailure;
use image::codecs::jpeg::JpegEncoder;
use little_exif::exif_tag::ExifTag;
use little_exif::filetype::FileExtension;
use little_exif::metadata::Metadata;
use little_exif::rational::uR64;

// ----------------- EXPORT -----------------
// Selected photos as JPEGs in a folder: any size (full, or a long edge for sharing), RAW/HEIC included,
// the user's rotation applied. The EXIF is written fresh (capture date, camera, lens and, unless stripped,
// GPS) instead of copying the original block, so nothing private is carried over by accident.

#[derive(Deserialize, Clone)]
pub struct ExportOptions {
    pub hashes: Vec<String>,
    pub dest_dir: String,
    // 0 = full size
    pub long_edge: u32,
    pub quality: u8,
    pub strip_gps: bool,
    // Photos this computer's database doesn't have (a server's), their originals fetched by the app
    #[serde(default)]
    pub fetched: Vec<FetchedPhoto>,
}

// A server's photo whose original the app downloaded to `path`, with the values the window has for it
#[derive(Deserialize, Clone, Default)]
#[serde(default)]
pub struct FetchedPhoto {
    pub path: String,
    pub name: String,
    pub rotation: i32,
    pub captured_at: String,
    pub camera_model: String,
    pub lens_model: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub caption: String,
    pub location: String,
    pub people: Vec<String>,
}

#[derive(Serialize, Clone, Default)]
pub struct ExportProgress {
    pub completed: usize,
    pub total: usize,
    pub done: bool,
    pub cancelled: bool,
}

#[derive(Serialize, Default)]
pub struct ExportResult {
    pub exported: usize,
    pub failures: Vec<FileOpFailure>,
    pub cancelled: bool,
}

static EXPORT_CANCEL: AtomicU64 = AtomicU64::new(0);

pub fn cancel_export() {
    EXPORT_CANCEL.fetch_add(1, Ordering::AcqRel);
}

// Changes when Stop is pressed: a running export (or web gallery) compares it with the value it started with
pub fn export_cancel_generation() -> u64 {
    EXPORT_CANCEL.load(Ordering::Acquire)
}

struct ExportSource {
    disk_path: String,
    name: String,
    rotation: i32,
    captured_at: String,
    camera_model: String,
    lens_model: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

// Degrees -> EXIF degrees/minutes/seconds rationals
fn dms(value: f64) -> Vec<uR64> {
    let v = value.abs();
    let deg = v.floor();
    let min = ((v - deg) * 60.0).floor();
    let sec = ((v - deg) * 60.0 - min) * 60.0;
    vec![
        uR64 { nominator: deg as u32, denominator: 1 },
        uR64 { nominator: min as u32, denominator: 1 },
        uR64 { nominator: (sec * 1000.0).round() as u32, denominator: 1000 },
    ]
}

fn exif_for(src: &ExportSource, strip_gps: bool) -> Metadata {
    let mut md = Metadata::new();
    md.set_tag(ExifTag::Software("Lumina".to_string()));
    // Pixels are already upright
    md.set_tag(ExifTag::Orientation(vec![1]));
    if src.captured_at.len() >= 19 {
        md.set_tag(ExifTag::DateTimeOriginal(src.captured_at[..19].replace('-', ":")));
    }
    if !src.camera_model.is_empty() {
        md.set_tag(ExifTag::Model(src.camera_model.clone()));
    }
    if let Some(lens) = src.lens_model.as_ref().filter(|l| !l.is_empty()) {
        md.set_tag(ExifTag::LensModel(lens.clone()));
    }
    if !strip_gps {
        if let (Some(lat), Some(lon)) = (src.latitude, src.longitude) {
            md.set_tag(ExifTag::GPSLatitudeRef(if lat >= 0.0 { "N" } else { "S" }.to_string()));
            md.set_tag(ExifTag::GPSLatitude(dms(lat)));
            md.set_tag(ExifTag::GPSLongitudeRef(if lon >= 0.0 { "E" } else { "W" }.to_string()));
            md.set_tag(ExifTag::GPSLongitude(dms(lon)));
        }
    }
    md
}

// "IMG_0001.CR3" -> "IMG_0001.jpg", then "IMG_0001_2.jpg", ... if that name is taken (on disk or in this run).
// A video keeps its own extension.
fn unique_target(dir: &Path, name: &str, taken: &Mutex<HashSet<String>>) -> PathBuf {
    let stem = Path::new(name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "photo".into());
    let ext = if video_meta::is_video_path(Path::new(name)) {
        Path::new(name).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()
    } else {
        "jpg".to_string()
    };
    let mut taken = taken.lock().unwrap_or_else(|e| e.into_inner());
    for n in 1.. {
        let candidate = if n == 1 { format!("{stem}.{ext}") } else { format!("{stem}_{n}.{ext}") };
        let path = dir.join(&candidate);
        if !path.exists() && taken.insert(candidate.to_lowercase()) {
            return path;
        }
    }
    unreachable!()
}

fn export_one(src: &ExportSource, target: &Path, opts: &ExportOptions) -> Result<(), String> {
    // Videos are copied as they are (no resizing, and their location stays in the file)
    if video_meta::is_video_path(Path::new(&src.disk_path)) {
        let part = target.with_extension("part");
        fs::copy(&src.disk_path, &part).map_err(|e| e.to_string())?;
        return fs::rename(&part, target).map_err(|e| {
            let _ = fs::remove_file(&part);
            e.to_string()
        });
    }
    // Full size asks the decoders for everything they have; otherwise just enough for the long edge
    let wanted = if opts.long_edge == 0 { 100_000 } else { opts.long_edge };
    let mut img = open_and_orient_image_sized(Path::new(&src.disk_path), wanted)?;
    img = match src.rotation.rem_euclid(360) {
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => img,
    };
    if opts.long_edge > 0 {
        let (w, h) = img.dimensions();
        if w.max(h) > opts.long_edge {
            img = img.resize(opts.long_edge, opts.long_edge, FilterType::Lanczos3);
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, opts.quality.clamp(40, 100))
        .encode_image(&img.to_rgb8())
        .map_err(|e| e.to_string())?;
    // A photo without metadata is still a valid export
    let _ = exif_for(src, opts.strip_gps).write_to_vec(&mut buf, FileExtension::JPEG);

    let part = target.with_extension("jpg.part");
    fs::write(&part, &buf).map_err(|e| e.to_string())?;
    fs::rename(&part, target).map_err(|e| {
        let _ = fs::remove_file(&part);
        e.to_string()
    })
}

pub async fn export_photos(app: SharedHost, options: ExportOptions) -> Result<ExportResult, String> {
    tokio::task::spawn_blocking(move || run_export(&*app, &options, true))
        .await
        .map_err(|e| e.to_string())?
}

// The photos to export: this database's, then the ones the app fetched from a server
fn export_sources(conn: &Connection, options: &ExportOptions) -> Result<Vec<ExportSource>, String> {
    let mut sources: Vec<ExportSource> = Vec::with_capacity(options.hashes.len());
    {
        let mut stmt = conn
            .prepare(
                "SELECT current_path, COALESCE(rotation, 0), COALESCE(captured_at, ''), COALESCE(camera_model, ''),
                        lens_model, latitude, longitude
                 FROM photos WHERE hash = ?1",
            )
            .map_err(|e| e.to_string())?;
        for hash in &options.hashes {
            if let Ok(src) = stmt.query_row(params![hash], |r| {
                let disk_path: String = r.get(0)?;
                Ok(ExportSource {
                    name: Path::new(&disk_path).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
                    disk_path,
                    rotation: r.get(1)?,
                    captured_at: r.get(2)?,
                    camera_model: r.get(3)?,
                    lens_model: r.get(4)?,
                    latitude: r.get(5)?,
                    longitude: r.get(6)?,
                })
            }) {
                sources.push(src);
            }
        }
    }
    for f in &options.fetched {
        sources.push(ExportSource {
            disk_path: f.path.clone(),
            name: f.name.clone(),
            rotation: f.rotation,
            captured_at: f.captured_at.clone(),
            camera_model: f.camera_model.clone(),
            lens_model: f.lens_model.clone(),
            latitude: f.latitude,
            longitude: f.longitude,
        });
    }
    Ok(sources)
}

// Exports into options.dest_dir. `report`: progress events and the performance line (the desktop's export
// dialog); a server's zip for one user's browser sends none, as other users' windows would hear them.
fn run_export(app: &dyn Host, options: &ExportOptions, report: bool) -> Result<ExportResult, String> {
    let started = Instant::now();
    let dest = PathBuf::from(&options.dest_dir);
    fs::create_dir_all(&dest).map_err(|e| format!("Can't use the export folder: {e}"))?;
    let conn = open_global_db(app)?;
    let sources = export_sources(&conn, options)?;
    drop(conn);

    let total = sources.len();
    let cancel_generation = EXPORT_CANCEL.load(Ordering::Acquire);
    let completed = AtomicUsize::new(0);
    let taken = Mutex::new(HashSet::new());
    let failures = Mutex::new(Vec::new());
    if report {
        let _ = emit_to(app, "export-progress", ExportProgress { completed: 0, total, ..Default::default() });
    }

    BG_POOL.install(|| {
        sources.par_iter().for_each(|src| {
            if EXPORT_CANCEL.load(Ordering::Acquire) != cancel_generation {
                return;
            }
            let target = unique_target(&dest, &src.name, &taken);
            if let Err(e) = export_one(src, &target, options) {
                if let Ok(mut f) = failures.lock() {
                    f.push(FileOpFailure { file: src.disk_path.clone(), error: e });
                }
            }
            let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
            if report && (done % 4 == 0 || done == total) {
                let _ = emit_to(app, "export-progress", ExportProgress { completed: done, total, ..Default::default() });
            }
        });
    });

    let cancelled = EXPORT_CANCEL.load(Ordering::Acquire) != cancel_generation;
    let failures = failures.into_inner().unwrap_or_default();
    let done = completed.load(Ordering::Relaxed);
    let exported = done.saturating_sub(failures.len());
    if !report {
        return Ok(ExportResult { exported, failures, cancelled });
    }
    emit_perf(
        app,
        "Export",
        started,
        exported,
        format!(
            "{} · quality {} · GPS {}",
            if options.long_edge == 0 { "full size".to_string() } else { format!("{} px", options.long_edge) },
            options.quality,
            if options.strip_gps { "removed" } else { "kept" }
        ),
    );
    let _ = emit_to(app, "export-progress", ExportProgress { completed: done, total, done: true, cancelled });
    Ok(ExportResult { exported, failures, cancelled })
}

// The photos in one zip at `zip_path` (for a browser to download from a server): exported as JPEGs as
// options say, or with `originals` the files as they are. JPEGs and videos don't shrink, so nothing is
// compressed. A failed photo is left out and reported; the zip holds the others.
pub fn export_zip(app: &dyn Host, options: &ExportOptions, originals: bool, zip_path: &Path) -> Result<ExportResult, String> {
    let mut failures = Vec::new();
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    let work = zip_path.with_extension("parts");
    if originals {
        let conn = open_global_db(app)?;
        let taken = Mutex::new(HashSet::new());
        for src in export_sources(&conn, options)? {
            let name = unique_name(&src.name, &taken);
            entries.push((name, PathBuf::from(&src.disk_path)));
        }
    } else {
        let _ = fs::remove_dir_all(&work);
        let into = ExportOptions { dest_dir: work.to_string_lossy().into_owned(), fetched: Vec::new(), ..options.clone() };
        let result = run_export(app, &into, false)?;
        failures = result.failures;
        for entry in fs::read_dir(&work).map_err(|e| e.to_string())?.flatten() {
            entries.push((entry.file_name().to_string_lossy().into_owned(), entry.path()));
        }
        entries.sort();
    }
    let written = write_zip(zip_path, &entries, &mut failures);
    let _ = fs::remove_dir_all(&work);
    let exported = written?;
    Ok(ExportResult { exported, failures, cancelled: false })
}

// "IMG_1.CR3" stays itself, a second one becomes "IMG_1_2.CR3" (names compared in any case)
fn unique_name(name: &str, taken: &Mutex<HashSet<String>>) -> String {
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "photo".into());
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut taken = taken.lock().unwrap_or_else(|e| e.into_inner());
    (1..)
        .map(|n| if n == 1 { format!("{stem}{ext}") } else { format!("{stem}_{n}{ext}") })
        .find(|c| taken.insert(c.to_lowercase()))
        .unwrap()
}

fn write_zip(zip_path: &Path, entries: &[(String, PathBuf)], failures: &mut Vec<FileOpFailure>) -> Result<usize, String> {
    let part = zip_path.with_extension("zip.part");
    let file = fs::File::create(&part).map_err(|e| format!("Can't write the zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let stored = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let mut written = 0;
    for (name, path) in entries {
        match fs::File::open(path) {
            Ok(mut f) => {
                zip.start_file(name.as_str(), stored).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut zip).map_err(|e| format!("Can't write the zip: {e}"))?;
                written += 1;
            }
            Err(e) => failures.push(FileOpFailure { file: name.clone(), error: e.to_string() }),
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    fs::rename(&part, zip_path).map_err(|e| e.to_string())?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use exif::{Reader, Tag};

    fn encoded_with_exif(strip_gps: bool) -> Vec<u8> {
        let img = DynamicImage::ImageRgb8(image::RgbImage::new(64, 48));
        let mut buf = Vec::new();
        JpegEncoder::new_with_quality(&mut buf, 90).encode_image(&img.to_rgb8()).unwrap();
        let src = ExportSource {
            disk_path: String::new(),
            name: "x.jpg".into(),
            rotation: 0,
            captured_at: "2024:06:15 18:30:00".into(),
            camera_model: "EOS R6".into(),
            lens_model: Some("RF 24-105mm".into()),
            latitude: Some(51.3456),
            longitude: Some(-3.25),
        };
        exif_for(&src, strip_gps).write_to_vec(&mut buf, FileExtension::JPEG).unwrap();
        buf
    }

    #[test]
    fn export_exif_has_date_camera_and_gps_unless_stripped() {
        let with_gps = Reader::new().read_from_container(&mut Cursor::new(encoded_with_exif(false))).unwrap();
        let date = with_gps.get_field(Tag::DateTimeOriginal, exif::In::PRIMARY).unwrap();
        assert!(date.display_value().to_string().contains("2024-06-15 18:30:00"));
        assert!(with_gps.get_field(Tag::Model, exif::In::PRIMARY).is_some());
        let lat = with_gps.get_field(Tag::GPSLatitude, exif::In::PRIMARY).unwrap();
        assert!(lat.display_value().to_string().starts_with("51 deg 20 min"));
        let lon_ref = with_gps.get_field(Tag::GPSLongitudeRef, exif::In::PRIMARY).unwrap();
        assert!(lon_ref.display_value().to_string().contains('W'));

        let stripped = Reader::new().read_from_container(&mut Cursor::new(encoded_with_exif(true))).unwrap();
        assert!(stripped.get_field(Tag::GPSLatitude, exif::In::PRIMARY).is_none());
        assert!(stripped.get_field(Tag::GPSLongitude, exif::In::PRIMARY).is_none());
        assert!(stripped.get_field(Tag::DateTimeOriginal, exif::In::PRIMARY).is_some());
        // Still a decodable JPEG
        assert!(image::load_from_memory(&encoded_with_exif(true)).is_ok());
    }
}

// Manual: exports one JPEG, HEIC and RAW from a folder at 2048 px without GPS and checks the results
// PowerShell: $env:LUMINA_DIAG_DIR="D:\Performance Test"; $env:LUMINA_DIAG_OUT="<folder>";
//             cargo test --release --lib export_real_files -- --ignored --nocapture
#[cfg(test)]
#[test]
#[ignore]
fn export_real_files() {
    let (Ok(dir), Ok(out)) = (std::env::var("LUMINA_DIAG_DIR"), std::env::var("LUMINA_DIAG_OUT")) else {
        eprintln!("Set LUMINA_DIAG_DIR and LUMINA_DIAG_OUT");
        return;
    };
    fs::create_dir_all(&out).unwrap();
    let opts = ExportOptions { hashes: vec![], dest_dir: out.clone(), long_edge: 2048, quality: 88, strip_gps: true, fetched: vec![] };
    for ext in ["jpg", "heic", "cr3"] {
        let Some(path) = WalkDir::new(&dir)
            .into_iter()
            .flatten()
            .map(|e| e.into_path())
            .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext)))
        else {
            eprintln!("no .{ext} found");
            continue;
        };
        let src = ExportSource {
            disk_path: path.to_string_lossy().to_string(),
            name: path.file_name().unwrap().to_string_lossy().to_string(),
            rotation: 0,
            captured_at: "2024:06:15 18:30:00".into(),
            camera_model: "Test".into(),
            lens_model: None,
            latitude: Some(51.0),
            longitude: Some(4.0),
        };
        let target = unique_target(Path::new(&out), &src.name, &Mutex::new(HashSet::new()));
        let t = Instant::now();
        export_one(&src, &target, &opts).unwrap();
        let bytes = fs::read(&target).unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        let exif = exif::Reader::new().read_from_container(&mut Cursor::new(&bytes)).unwrap();
        eprintln!(
            "{ext}: {} -> {}x{} in {} ms · {} KB · GPS {}",
            src.name,
            img.width(),
            img.height(),
            t.elapsed().as_millis(),
            bytes.len() / 1024,
            if exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY).is_some() { "PRESENT" } else { "removed" }
        );
        assert!(img.width().max(img.height()) <= 2048);
    }
}
