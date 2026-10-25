use crate::*;
use std::sync::mpsc::{channel, sync_channel, RecvTimeoutError};
use std::time::Duration;

// ----------------- BACKGROUND THUMBNAIL PIPELINE -----------------
// readers (few on a hard drive, in folder order) -> bounded queue of file bytes -> decoders on BG_POOL
// -> collector (DB writes + UI batches). No per-chunk barrier: a slow file never stalls the others,
// and the disk keeps streaming while the CPUs decode.

const UI_BATCH_SIZE: usize = 48;
const UI_BATCH_MAX_WAIT: Duration = Duration::from_millis(250);

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
    // The 360px thumbnail already exists (only dHash/sharpness are missing): decode it instead of the original
    reuse_thumb: bool,
}

#[derive(Default)]
struct PassStats {
    failed: usize,
    damaged: usize,
    reused: usize,
    heic: usize,
    db_ms: u64,
}

pub fn spawn_thumbnail_pass(app: AppHandle, items: Vec<PhotoItem>, root: PathBuf, generation: u64, force: bool) {
    std::thread::spawn(move || run_thumbnail_pass(&app, &items, &root, generation, force));
}

fn run_thumbnail_pass(app: &AppHandle, items: &[PhotoItem], root: &Path, generation: u64, force: bool) {
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
            .map(|p| (disk_path_of(p).to_string_lossy().to_string(), p.thumb_path.clone(), 360))
            .collect();
        powershell_heic = jobs.len();
        batch_decode_heic_thumbs_windows(&jobs);
    }

    // Collector: stream finished thumbnails to the DB and the UI in small batches
    let mut conn = open_global_db(app).ok();
    let mut batch: Vec<ThumbBatchItem> = Vec::with_capacity(UI_BATCH_SIZE);
    let mut last_flush = Instant::now();
    let mut completed = 0usize;
    let (reused, heic) = run_decode_pipeline(items, io_threads, force, is_superseded, |event| {
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
    });
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
            "{}/s · {} readers ({}) + {} decoders · {} reused cached thumbs · HEIC {} via WIC{} · db {} ms · {} failed · {} damaged",
            per_second(total, total_ms),
            io_threads,
            drive_kind,
            decode_threads,
            stats.reused,
            stats.heic,
            if powershell_heic > 0 { format!(" ({powershell_heic} via PowerShell)") } else { String::new() },
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
                let reuse_thumb = !force && thumb_file.metadata().map(|m| m.len() > 256).unwrap_or(false);
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
                if in_tx.send(ThumbInput { idx, bytes, reuse_thumb }).is_err() {
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
        let thumb = if iw <= 360 && ih <= 360 { img } else { img.thumbnail(360, 360) };
        item.dhash = compute_dhash(&thumb);
        item.sharpness = compute_sharpness(&thumb);
        if (force || !thumb_file.exists()) && thumb.to_rgb8().save(thumb_file).is_err() {
            item.thumb_path = photo.path.clone();
        }
    }
    item.thumb_ok = Path::new(&item.thumb_path).exists();
    item
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
