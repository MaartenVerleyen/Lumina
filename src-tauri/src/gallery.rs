use crate::files::FileOpFailure;
use crate::*;
use image::codecs::jpeg::JpegEncoder;

// A web gallery of chosen photos: a folder with index.html (one self-contained page: grid, lightbox, optional
// map), photos/ at 2048 px and thumbs/ for the grid. It works opened straight from disk and on any static
// host. The photos carry no metadata (no GPS, camera or original file names); captions, people's names and
// places are only included when asked for.

const TEMPLATE: &str = include_str!("gallery_template.html");
const FULL_EDGE: u32 = 2048;
const THUMB_EDGE: u32 = 640;

#[derive(Deserialize)]
pub struct GalleryOptions {
    pub hashes: Vec<String>,
    pub dest_dir: String,
    pub title: String,
    pub captions: bool,
    pub people: bool,
    // Place names, and a map of the photos that have GPS
    pub places: bool,
    // A zip of the photos for "Download all"
    pub zip: bool,
}

#[derive(Serialize)]
pub struct GalleryResult {
    pub folder: String,
    pub index: String,
    pub exported: usize,
    pub failures: Vec<FileOpFailure>,
    pub cancelled: bool,
}

struct GallerySource {
    disk_path: String,
    rotation: i32,
    date: String,
    caption: String,
    place: String,
    lat: Option<f64>,
    lon: Option<f64>,
    people: Vec<String>,
}

#[derive(Serialize)]
struct GalleryPhoto {
    full: String,
    thumb: String,
    w: u32,
    h: u32,
    date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    caption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    place: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    people: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lon: Option<f64>,
}

// "Paris · June 2024" -> "Paris-June-2024"
pub fn gallery_folder_name(title: &str) -> String {
    let name: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if name.is_empty() { "Gallery".into() } else { name.chars().take(60).collect() }
}

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn write_jpeg(img: &DynamicImage, path: &Path, quality: u8) -> Result<(), String> {
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, quality).encode_image(&img.to_rgb8()).map_err(|e| e.to_string())?;
    fs::write(path, buf).map_err(|e| e.to_string())
}

// One photo: upright, at most 2048 px, plus its grid thumbnail. Returns the large version's size.
fn render(src: &GallerySource, full: &Path, thumb: &Path) -> Result<(u32, u32), String> {
    let mut img = open_and_orient_image_sized(Path::new(&src.disk_path), FULL_EDGE)?;
    img = match src.rotation.rem_euclid(360) {
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => img,
    };
    if img.width().max(img.height()) > FULL_EDGE {
        img = img.resize(FULL_EDGE, FULL_EDGE, FilterType::Lanczos3);
    }
    write_jpeg(&img, full, 86)?;
    write_jpeg(&img.resize(THUMB_EDGE, THUMB_EDGE, FilterType::Triangle), thumb, 80)?;
    Ok(img.dimensions())
}

fn zip_photos(folder: &Path, files: &[String], zip_name: &str) -> Result<(), String> {
    let file = File::create(folder.join(zip_name)).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    // JPEGs don't compress further: store them
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for rel in files {
        let name = Path::new(rel).file_name().unwrap_or_default().to_string_lossy().into_owned();
        zip.start_file(name, opts).map_err(|e| e.to_string())?;
        let bytes = fs::read(folder.join(rel)).map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut zip, &bytes).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn export_gallery(app: AppHandle, options: GalleryOptions) -> Result<GalleryResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        // A new folder for the gallery inside the chosen one
        let base = gallery_folder_name(&options.title);
        let parent = PathBuf::from(&options.dest_dir);
        let folder = (1..)
            .map(|n| parent.join(if n == 1 { base.clone() } else { format!("{base}-{n}") }))
            .find(|p| !p.exists())
            .unwrap();
        fs::create_dir_all(folder.join("photos")).map_err(|e| format!("Can't create the gallery folder: {e}"))?;
        fs::create_dir_all(folder.join("thumbs")).map_err(|e| e.to_string())?;

        let conn = open_global_db(&app)?;
        let mut sources: Vec<GallerySource> = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT current_path, COALESCE(rotation, 0), COALESCE(captured_at, ''), COALESCE(ai_caption, ''),
                            COALESCE(location, ''), latitude, longitude
                     FROM photos WHERE hash = ?1",
                )
                .map_err(|e| e.to_string())?;
            let mut people_stmt = conn
                .prepare("SELECT person_name FROM photo_people WHERE hash = ?1 ORDER BY person_name")
                .map_err(|e| e.to_string())?;
            for hash in &options.hashes {
                let Ok(mut src) = stmt.query_row(params![hash], |r| {
                    Ok(GallerySource {
                        disk_path: r.get(0)?,
                        rotation: r.get(1)?,
                        date: r.get::<_, String>(2)?.chars().take(10).map(|c| if c == ':' { '-' } else { c }).collect(),
                        caption: r.get(3)?,
                        place: r.get::<_, String>(4)?.split(',').next().unwrap_or("").trim().to_string(),
                        lat: r.get(5)?,
                        lon: r.get(6)?,
                        people: Vec::new(),
                    })
                }) else {
                    continue;
                };
                if options.people {
                    src.people = people_stmt
                        .query_map(params![hash], |r| r.get::<_, String>(0))
                        .map(|rows| rows.flatten().collect())
                        .unwrap_or_default();
                }
                sources.push(src);
            }
        }
        // Oldest first, as the story happened
        sources.sort_by(|a, b| (a.date.is_empty(), &a.date).cmp(&(b.date.is_empty(), &b.date)));

        let total = sources.len();
        let cancel_generation = export::export_cancel_generation();
        let completed = AtomicUsize::new(0);
        let _ = app.emit("export-progress", export::ExportProgress { completed: 0, total, ..Default::default() });
        let rendered: Vec<Result<GalleryPhoto, FileOpFailure>> = BG_POOL.install(|| {
            sources
                .par_iter()
                .enumerate()
                .map(|(i, src)| {
                    if export::export_cancel_generation() != cancel_generation {
                        return Err(FileOpFailure { file: src.disk_path.clone(), error: "stopped".into() });
                    }
                    let (full, thumb) = (format!("photos/{:03}.jpg", i + 1), format!("thumbs/{:03}.jpg", i + 1));
                    let result = render(src, &folder.join(&full), &folder.join(&thumb));
                    let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                    if done % 4 == 0 || done == total {
                        let _ = app.emit("export-progress", export::ExportProgress { completed: done, total, ..Default::default() });
                    }
                    let (w, h) = result.map_err(|error| FileOpFailure { file: src.disk_path.clone(), error })?;
                    let place = (options.places && !src.place.is_empty()).then(|| src.place.clone());
                    Ok(GalleryPhoto {
                        full,
                        thumb,
                        w,
                        h,
                        date: src.date.clone(),
                        caption: (options.captions && !src.caption.trim().is_empty()).then(|| src.caption.trim().to_string()),
                        place,
                        people: (options.people && !src.people.is_empty()).then(|| src.people.clone()),
                        lat: if options.places { src.lat } else { None },
                        lon: if options.places { src.lon } else { None },
                    })
                })
                .collect()
        });
        let cancelled = export::export_cancel_generation() != cancel_generation;
        let mut photos = Vec::new();
        let mut failures = Vec::new();
        for r in rendered {
            match r {
                Ok(p) => photos.push(p),
                Err(f) if f.error != "stopped" => failures.push(f),
                Err(_) => {}
            }
        }

        let zip_name = format!("{base}.zip");
        let zip = if options.zip && !photos.is_empty() {
            let files: Vec<String> = photos.iter().map(|p| p.full.clone()).collect();
            zip_photos(&folder, &files, &zip_name).ok().map(|_| zip_name)
        } else {
            None
        };
        let data = json!({ "title": options.title, "photos": photos, "map": options.places, "zip": zip });
        // "</" can't appear inside the inline script
        let data = data.to_string().replace("</", "<\\/");
        let html = TEMPLATE.replace("__TITLE__", &html_escape(&options.title)).replace("/*__DATA__*/null", &data);
        let index = folder.join("index.html");
        fs::write(&index, html).map_err(|e| e.to_string())?;
        let _ = app.emit("export-progress", export::ExportProgress { completed: total, total, done: true, ..Default::default() });
        emit_perf(&app, "Web gallery", started, photos.len(), folder.to_string_lossy().into_owned());
        Ok(GalleryResult {
            folder: folder.to_string_lossy().into_owned(),
            index: index.to_string_lossy().into_owned(),
            exported: photos.len(),
            failures,
            cancelled,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
