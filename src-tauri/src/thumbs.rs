use crate::*;
use std::sync::mpsc::{channel, sync_channel, RecvTimeoutError};
use std::time::Duration;

// ----------------- BACKGROUND THUMBNAIL PIPELINE -----------------
// readers (few on a hard drive, in folder order) -> bounded queue of file bytes -> decoders on BG_POOL
// -> collector (DB writes + UI batches). No per-chunk barrier: a slow file never stalls the others,
// and the disk keeps streaming while the CPUs decode.

const UI_BATCH_SIZE: usize = 48;

// Grid thumbnails: 480 px stays sharp on large cards and HiDPI screens
pub const THUMB_EDGE: u32 = 480;
// dHash and focus scores are measured at 360 px, the size they were tuned on, whatever the thumbnail size
const METRICS_EDGE: u32 = 360;
const UI_BATCH_MAX_WAIT: Duration = Duration::from_millis(250);
// Videos decode a few frames each (up to 4K HEVC): two at a time leaves the rest of the machine free
const VIDEO_THREADS: usize = 2;

// The photo's own file on disk. For RAW/HEIC `path` is the cached preview and the original is in
// `pair_raw_path`; for a JPEG `pair_raw_path` is its RAW partner, so the JPEG itself is `path`.
pub fn disk_path_of(p: &PhotoItem) -> PathBuf {
    let ext = Path::new(&p.name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match (&p.pair_raw_path, is_raw_or_heic_ext(&ext)) {
        (Some(original), true) => PathBuf::from(original),
        _ => PathBuf::from(&p.path),
    }
}

struct ThumbInput {
    idx: usize,
    bytes: Option<Vec<u8>>,
    // The thumbnail already exists (only dHash/sharpness are missing): decode it instead of the original
    reuse_thumb: bool,
    // An older, smaller thumbnail exists: make a new one from the original and replace it
    upgrade: bool,
}

#[derive(Default)]
struct PassStats {
    failed: usize,
    damaged: usize,
    reused: usize,
    heic: usize,
    db_ms: u64,
}

pub fn spawn_thumbnail_pass(
    app: AppHandle,
    items: Vec<PhotoItem>,
    root: PathBuf,
    generation: u64,
    force: bool,
    upgrade: HashSet<String>,
) {
    std::thread::spawn(move || run_thumbnail_pass(&app, &items, &root, generation, force, &upgrade));
}

fn run_thumbnail_pass(
    app: &AppHandle,
    items: &[PhotoItem],
    root: &Path,
    generation: u64,
    force: bool,
    upgrade: &HashSet<String>,
) {
    let started = Instant::now();
    let is_superseded = move || SCAN_GENERATION.load(Ordering::Acquire) != generation;
    let total = items.len();
    let folder = root.to_string_lossy().to_string();
    let (io_threads, drive_kind) = index_io_threads(root);
    let decode_threads = BG_POOL.current_num_threads();
    let mut stats = PassStats::default();

    // Without an in-process WIC factory, fall back to the old PowerShell batch conversion for HEIC
    let mut powershell_heic = 0usize;
    if !wic_available() {
        let jobs: Vec<(String, String, u32)> = items
            .iter()
            .filter(|p| {
                let src = disk_path_of(p);
                let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                (ext == "heic" || ext == "heif") && (force || !Path::new(&p.thumb_path).exists())
            })
            .map(|p| (disk_path_of(p).to_string_lossy().to_string(), p.thumb_path.clone(), THUMB_EDGE))
            .collect();
        powershell_heic = jobs.len();
        batch_decode_heic_thumbs_windows(&jobs);
    }

    // Photos first, through the decode pipeline; videos after them, a few frames each
    let (videos, photos): (Vec<PhotoItem>, Vec<PhotoItem>) = items.iter().cloned().partition(|p| p.media_type == "video");

    // Collector: stream finished thumbnails to the DB and the UI in small batches
    let mut conn = open_global_db(app).ok();
    let mut batch: Vec<ThumbBatchItem> = Vec::with_capacity(UI_BATCH_SIZE);
    let mut last_flush = Instant::now();
    let mut completed = 0usize;
    let mut collect = |event: PipelineEvent| {
        let finished = match event {
            PipelineEvent::Item(item) => {
                batch.push(item);
                false
            }
            PipelineEvent::Idle => false,
            PipelineEvent::Finished => true,
        };
        let due = batch.len() >= UI_BATCH_SIZE || (!batch.is_empty() && last_flush.elapsed() >= UI_BATCH_MAX_WAIT);
        if (due || finished) && !batch.is_empty() && !is_superseded() {
            completed += batch.len();
            flush_batch(app, conn.as_mut(), std::mem::take(&mut batch), &folder, completed, total, &mut stats);
            last_flush = Instant::now();
        }
    };
    let (reused, heic) = run_decode_pipeline(&photos, io_threads, force, upgrade, is_superseded, &mut collect);
    let video_started = Instant::now();
    if !videos.is_empty() && !is_superseded() {
        let frames_dir = video_frames::frames_dir(&get_app_storage_dir(app));
        let _ = fs::create_dir_all(&frames_dir);
        run_video_pass(&videos, &frames_dir, force, is_superseded, &mut collect);
    }
    let video_ms = elapsed_ms(video_started);
    stats.reused = reused;
    stats.heic = heic;

    if is_superseded() {
        eprintln!("[scan] thumbnail pass for {folder} stopped: a newer scan started");
        return;
    }

    // Duplicate groups need every dHash, so they go out once, after the last batch
    if let Ok(conn) = open_global_db(app) {
        let dup_groups = compute_db_duplicate_groups(&conn, Some(&folder));
        let _ = app.emit(
            "thumb-batch-ready",
            ThumbBatchProgress {
                items: Vec::new(),
                duplicate_groups: dup_groups,
                completed: total,
                total,
                folder: folder.clone(),
            },
        );
    }

    let total_ms = elapsed_ms(started);
    emit_perf(
        app,
        "Thumbnails + dHash",
        started,
        total,
        format!(
            "{}/s · {} readers ({}) + {} decoders · {} reused cached thumbs · HEIC {} via WIC{} · {} videos in {} ms · db {} ms · {} failed · {} damaged",
            per_second(total, total_ms),
            io_threads,
            drive_kind,
            decode_threads,
            stats.reused,
            stats.heic,
            if powershell_heic > 0 { format!(" ({powershell_heic} via PowerShell)") } else { String::new() },
            videos.len(),
            video_ms,
            stats.db_ms,
            stats.failed,
            stats.damaged
        ),
    );
}

pub enum PipelineEvent {
    Item(ThumbBatchItem),
    // Nothing arrived for 100 ms (lets the caller flush a partial batch on time)
    Idle,
    Finished,
}

// Readers -> bounded queue -> decoders on BG_POOL; `on_event` runs on the calling thread.
// Returns (thumbnails reused from cache, HEIC files decoded).
pub fn run_decode_pipeline(
    items: &[PhotoItem],
    io_threads: usize,
    force: bool,
    upgrade: &HashSet<String>,
    is_superseded: impl Fn() -> bool + Copy + Send + Sync,
    mut on_event: impl FnMut(PipelineEvent),
) -> (usize, usize) {
    let total = items.len();
    let decode_threads = BG_POOL.current_num_threads();
    // Bounded: readers stay at most a couple of files ahead of the decoders (caps memory use)
    let (in_tx, in_rx) = sync_channel::<ThumbInput>(decode_threads * 2);
    let (out_tx, out_rx) = channel::<ThumbBatchItem>();
    let next = AtomicUsize::new(0);
    let reused_count = AtomicUsize::new(0);
    let heic_count = AtomicUsize::new(0);

    std::thread::scope(|s| {
        for _ in 0..io_threads {
            let in_tx = in_tx.clone();
            let (next, reused_count, heic_count) = (&next, &reused_count, &heic_count);
            s.spawn(move || loop {
                let idx = next.fetch_add(1, Ordering::Relaxed);
                if idx >= total || is_superseded() {
                    break;
                }
                let photo = &items[idx];
                let thumb_file = Path::new(&photo.thumb_path);
                let upgrade = upgrade.contains(&photo.hash);
                let reuse_thumb =
                    !force && !upgrade && thumb_file.metadata().map(|m| m.len() > 256).unwrap_or(false);
                let source = disk_path_of(photo);
                let bytes = if reuse_thumb {
                    reused_count.fetch_add(1, Ordering::Relaxed);
                    fs::read(thumb_file).ok()
                } else {
                    let ext = source.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                    if ext == "heic" || ext == "heif" {
                        heic_count.fetch_add(1, Ordering::Relaxed);
                    }
                    read_for_thumb(&source)
                };
                if in_tx.send(ThumbInput { idx, bytes, reuse_thumb, upgrade }).is_err() {
                    break;
                }
            });
        }
        drop(in_tx);

        s.spawn(move || {
            BG_POOL.install(|| {
                in_rx.into_iter().par_bridge().for_each_with(out_tx, |tx, input| {
                    if is_superseded() {
                        return;
                    }
                    let _ = tx.send(process_one(&items[input.idx], input, force));
                });
            });
        });

        loop {
            match out_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(item) => on_event(PipelineEvent::Item(item)),
                Err(RecvTimeoutError::Timeout) => on_event(PipelineEvent::Idle),
                Err(RecvTimeoutError::Disconnected) => {
                    on_event(PipelineEvent::Finished);
                    break;
                }
            }
        }
    });

    (reused_count.load(Ordering::Relaxed), heic_count.load(Ordering::Relaxed))
}

fn process_one(photo: &PhotoItem, input: ThumbInput, force: bool) -> ThumbBatchItem {
    let source = disk_path_of(photo);
    let thumb_file = Path::new(&photo.thumb_path);

    let decoded = if input.reuse_thumb {
        // The cached thumbnail keeps the original's damaged flag (it decodes fine itself)
        input
            .bytes
            .as_deref()
            .and_then(|b| image::load_from_memory(b).ok())
            .map(|img| Ok((img, photo.damaged)))
            .unwrap_or_else(|| decode_for_thumb(&source, None))
    } else {
        decode_for_thumb(&source, input.bytes.as_deref())
    };

    let mut item = ThumbBatchItem {
        hash: photo.hash.clone(),
        thumb_path: photo.thumb_path.clone(),
        dhash: photo.dhash.clone(),
        sharpness: photo.sharpness,
        width: photo.width,
        height: photo.height,
        auto_tags: Vec::new(),
        thumb_ok: false,
        // Unreadable unless decoding succeeds below
        damaged: true,
        thumb_edge: 0,
        duration_ms: None,
    };

    if let Ok((img, damaged)) = decoded {
        item.damaged = damaged;
        let (iw, ih) = img.dimensions();
        // Decoded size is reduced (scaled JPEG / cached thumb): only use it when the header gave nothing
        if (item.width == 0 || item.height == 0) && !input.reuse_thumb {
            item.width = iw;
            item.height = ih;
        }
        let source_dims = (item.width > 0 && item.height > 0).then_some((item.width, item.height));
        if is_likely_screenshot(&source, &photo.camera_model, Some(&img), source_dims) {
            item.auto_tags.push("screenshot".to_string());
        }
        let thumb = if iw <= THUMB_EDGE && ih <= THUMB_EDGE { img } else { img.thumbnail(THUMB_EDGE, THUMB_EDGE) };
        let (tw, th) = thumb.dimensions();
        let metrics_img;
        let metrics = if tw <= METRICS_EDGE && th <= METRICS_EDGE {
            &thumb
        } else {
            metrics_img = thumb.thumbnail(METRICS_EDGE, METRICS_EDGE);
            &metrics_img
        };
        item.dhash = compute_dhash(metrics);
        item.sharpness = compute_sharpness(metrics);
        if force || input.upgrade || !thumb_file.exists() {
            if write_thumbnail(&thumb, thumb_file) {
                item.thumb_edge = THUMB_EDGE;
            } else if !thumb_file.exists() {
                item.thumb_path = photo.path.clone();
            }
        }
    }
    item.thumb_ok = Path::new(&item.thumb_path).exists();
    item
}

// Videos: frames and a thumbnail from each, on VIDEO_THREADS threads of their own; `on_event` runs on the
// calling thread like the photo pipeline's
pub fn run_video_pass(
    videos: &[PhotoItem],
    frames_dir: &Path,
    force: bool,
    is_superseded: impl Fn() -> bool + Copy + Send + Sync,
    mut on_event: impl FnMut(PipelineEvent),
) {
    let (tx, rx) = channel::<ThumbBatchItem>();
    let next = AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..VIDEO_THREADS.min(videos.len()) {
            let (tx, next) = (tx.clone(), &next);
            s.spawn(move || {
                lower_current_thread_priority();
                loop {
                    let idx = next.fetch_add(1, Ordering::Relaxed);
                    if idx >= videos.len() || is_superseded() {
                        break;
                    }
                    if tx.send(process_video(&videos[idx], frames_dir, force)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(item) => on_event(PipelineEvent::Item(item)),
                Err(RecvTimeoutError::Timeout) => on_event(PipelineEvent::Idle),
                Err(RecvTimeoutError::Disconnected) => {
                    on_event(PipelineEvent::Finished);
                    break;
                }
            }
        }
    });
}

fn process_video(video: &PhotoItem, frames_dir: &Path, force: bool) -> ThumbBatchItem {
    let thumb_file = Path::new(&video.thumb_path);
    let mut item = ThumbBatchItem {
        hash: video.hash.clone(),
        thumb_path: video.thumb_path.clone(),
        dhash: String::new(),
        sharpness: 0.0,
        width: video.width,
        height: video.height,
        auto_tags: Vec::new(),
        thumb_ok: false,
        damaged: false,
        thumb_edge: 0,
        duration_ms: video.duration_ms,
    };
    let have_frames = video_frames::frame_path(frames_dir, &video.hash, 0).exists();
    if force || !have_frames || !thumb_file.exists() {
        let source = PathBuf::from(&video.path);
        let rotation = video_meta::read_video_meta(&source).rotation;
        // Without a codec for it (or a broken file) the grid shows a placeholder; the frames come later
        // from ffmpeg when it is installed
        if let Some(grabbed) = video_frames::grab_frames(&source, rotation) {
            video_frames::delete_frames(frames_dir, &video.hash);
            for (n, frame) in grabbed.frames.iter().enumerate() {
                write_thumbnail(frame, &video_frames::frame_path(frames_dir, &video.hash, n));
            }
            if let Some(frame) = video_frames::thumbnail_frame(&grabbed.frames) {
                if write_thumbnail(&frame.thumbnail(THUMB_EDGE, THUMB_EDGE), thumb_file) {
                    item.thumb_edge = THUMB_EDGE;
                }
            }
            if item.width == 0 || item.height == 0 {
                item.width = grabbed.width;
                item.height = grabbed.height;
            }
            if item.duration_ms.is_none() && grabbed.duration_ms > 0 {
                item.duration_ms = Some(grabbed.duration_ms);
            }
        }
    }
    item.thumb_ok = thumb_file.exists();
    item
}

// Written next to the target and renamed, so the grid never loads a half-written file while an older
// thumbnail is being replaced
fn write_thumbnail(img: &DynamicImage, target: &Path) -> bool {
    let tmp = target.with_extension("tmp.jpg");
    if img.to_rgb8().save(&tmp).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    fs::rename(&tmp, target).is_ok()
}

fn flush_batch(
    app: &AppHandle,
    conn: Option<&mut Connection>,
    items: Vec<ThumbBatchItem>,
    folder: &str,
    completed: usize,
    total: usize,
    stats: &mut PassStats,
) {
    stats.failed += items.iter().filter(|i| !i.thumb_ok).count();
    stats.damaged += items.iter().filter(|i| i.damaged).count();

    let db_started = Instant::now();
    if let Some(conn) = conn {
        if let Ok(tx) = conn.transaction() {
            for item in &items {
                let _ = tx.execute(
                    "UPDATE photos SET dhash = ?1, sharpness = ?2, width = CASE WHEN ?3 > 0 THEN ?3 ELSE width END, height = CASE WHEN ?4 > 0 THEN ?4 ELSE height END, damaged = ?6 WHERE hash = ?5",
                    params![item.dhash, item.sharpness, item.width, item.height, item.hash, item.damaged],
                );
                if let Some(ms) = item.duration_ms {
                    let _ = tx.execute("UPDATE photos SET duration_ms = ?1 WHERE hash = ?2", params![ms, item.hash]);
                }
                if item.thumb_edge > 0 {
                    let _ = tx.execute(
                        "UPDATE photos SET thumb_edge = ?1 WHERE hash = ?2",
                        params![item.thumb_edge, item.hash],
                    );
                }
                if !item.auto_tags.is_empty() {
                    let _ = tx.execute(
                        "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, 'screenshot')",
                        params![item.hash],
                    );
                }
            }
            let _ = tx.commit();
        }
    }
    stats.db_ms += elapsed_ms(db_started);

    let _ = app.emit(
        "thumb-batch-ready",
        ThumbBatchProgress {
            items,
            duplicate_groups: HashMap::new(),
            completed,
            total,
            folder: folder.to_string(),
        },
    );
}
