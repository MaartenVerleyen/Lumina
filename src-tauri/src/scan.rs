use crate::*;

// One photo as the near-duplicate grouping sees it
pub struct DupCandidate<'a> {
    pub dhash: Option<u64>,
    // Screenshots and photos without a camera (saved images): their small fingerprint may differ a little more,
    // when CLIP confirms the match
    pub loose: bool,
    // CLIP image vector (smart search index), when the photo has one
    pub clip: Option<&'a [f32]>,
}

// Two photos whose 64-bit fingerprints are this close (bits differing) are candidates
const DUP_MAX_BITS: u32 = 8;
const DUP_MAX_BITS_LOOSE: u32 = 11;
// The fingerprint only sees a 9x8 grey thumbnail, so unrelated photos with a similar layout of light and dark
// (a laptop screen, a bathroom, a train board) can match. When both photos have a CLIP vector, it must agree
// too. Tuned on 1,513 grouped pairs of a real library (2026-10-29): bursts and filtered copies scored >= 0.82,
// different scenes (two web pages on a screen, two different children in the same room) <= 0.81.
const DUP_MIN_CLIP_SIMILARITY: f32 = 0.82;

fn near_duplicates(a: &DupCandidate, b: &DupCandidate) -> bool {
    let (Some(h1), Some(h2)) = (a.dhash, b.dhash) else {
        return false;
    };
    let bits = (h1 ^ h2).count_ones();
    match (a.clip, b.clip) {
        (Some(va), Some(vb)) => {
            let max_bits = if a.loose && b.loose { DUP_MAX_BITS_LOOSE } else { DUP_MAX_BITS };
            bits <= max_bits && face_match::dot(va, vb) >= DUP_MIN_CLIP_SIMILARITY
        }
        // Without CLIP to confirm, only the strict fingerprint distance: nearly all mismatches were 9-11 bits apart
        _ => bits <= DUP_MAX_BITS,
    }
}

// Groups near-duplicates among `items` (in capture order): each photo is compared with the next 300. Returns a
// group number (from 1) per item, None for photos without a near-duplicate.
pub fn group_near_duplicates(items: &[DupCandidate]) -> Vec<Option<usize>> {
    let n = items.len();
    let mut groups = vec![None; n];
    let mut next_group = 1usize;
    for i in 0..n {
        if groups[i].is_some() || items[i].dhash.is_none() {
            continue;
        }
        let members: Vec<usize> = (i + 1..(i + 300).min(n))
            .filter(|&j| groups[j].is_none() && near_duplicates(&items[i], &items[j]))
            .collect();
        if !members.is_empty() {
            groups[i] = Some(next_group);
            for j in members {
                groups[j] = Some(next_group);
            }
            next_group += 1;
        }
    }
    groups
}

pub fn assign_duplicate_groups(photos: &mut [PhotoItem], clip: &HashMap<String, Vec<f32>>) {
    for p in photos.iter_mut() {
        p.duplicate_group = None;
    }

    // Chronologically by captured_at then name, so bursts with different prefixes still sit adjacent
    let mut order: Vec<usize> = (0..photos.len()).filter(|&i| photos[i].subfolder != "_Trash").collect();
    order.sort_by(|&a, &b| {
        photos[a]
            .captured_at
            .cmp(&photos[b].captured_at)
            .then_with(|| photos[a].name.cmp(&photos[b].name))
    });

    let items: Vec<DupCandidate> = order
        .iter()
        .map(|&i| {
            let p = &photos[i];
            DupCandidate {
                dhash: (p.dhash.len() == 16).then(|| u64::from_str_radix(&p.dhash, 16).ok()).flatten(),
                loose: p.tags.iter().any(|t| t == "screenshot")
                    || p.name.ends_with(".png")
                    || p.name.ends_with(".PNG")
                    || p.camera_model.is_empty(),
                clip: clip.get(&p.hash).map(|v| v.as_slice()),
            }
        })
        .collect();
    let groups = group_near_duplicates(&items);
    for (pos, &i) in order.iter().enumerate() {
        photos[i].duplicate_group = groups[pos];
    }
}

pub fn compute_db_duplicate_groups(conn: &Connection, root_folder: Option<&str>) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    let prefix = make_folder_prefix(root_folder);
    let Ok(mut stmt) = conn.prepare(
        "SELECT hash, dhash, COALESCE(camera_model, ''), COALESCE(subfolder, ''), COALESCE(current_path, '')
         FROM photos
         WHERE length(dhash) = 16 AND COALESCE(subfolder, '') != '_Trash' AND current_path LIKE ?1 ESCAPE '!'
         ORDER BY COALESCE(captured_at, '') ASC, current_path ASC",
    ) else {
        return map;
    };

    let Ok(rows) = stmt.query_map(params![prefix], |r| {
        let hash: String = r.get(0)?;
        let dhash_str: String = r.get(1)?;
        let cam: String = r.get(2)?;
        let path: String = r.get(4)?;
        let is_scr = cam.is_empty() || path.ends_with(".png") || path.ends_with(".PNG");
        Ok((hash, u64::from_str_radix(&dhash_str, 16).ok(), is_scr))
    }) else {
        return map;
    };

    let rows: Vec<(String, Option<u64>, bool)> = rows.flatten().collect();
    let hashes: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let clip = clip::clip_vectors(conn, &hashes);
    let items: Vec<DupCandidate> = rows
        .iter()
        .map(|(hash, dhash, loose)| DupCandidate { dhash: *dhash, loose: *loose, clip: clip.get(hash).map(|v| v.as_slice()) })
        .collect();
    for ((hash, _, _), group) in rows.iter().zip(group_near_duplicates(&items)) {
        if let Some(g) = group {
            map.insert(hash.clone(), g);
        }
    }
    map
}

pub static SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);

// Error text the UI recognises as "the user cancelled the folder scan" (not a failure to report)
pub const SCAN_CANCELLED: &str = "Folder scan cancelled";

// Cancel button of the folder scan dialog: the running index pass (and its thumbnail pass) stop early
#[tauri::command]
pub fn cancel_folder_scan() {
    SCAN_GENERATION.fetch_add(1, Ordering::AcqRel);
}

// Jobs panel: stops the background thumbnail pass only. Same mechanism: the pass sees a newer generation;
// photos it didn't reach are picked up by the next scan.
#[tauri::command]
pub fn cancel_thumbnail_pass() {
    SCAN_GENERATION.fetch_add(1, Ordering::AcqRel);
}

// Every file type Lumina shows (lower-case extensions); also what Import copies as photos
pub const PHOTO_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "bmp", "gif", "tiff", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "heic",
    "heif", "pef", "raf",
];

pub fn salt_hash_with_path(hash: &str, disk_path: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(hash.as_bytes());
    hasher.update(disk_path.to_lowercase().as_bytes());
    hasher.finalize().to_hex()[..16].to_string()
}

// Identical copies of a file share a content hash, but `hash` is the photos PRIMARY KEY.
// The copy that already owns the DB row keeps the hash; every other copy gets a path-salted hash
// so each copy is its own photo (dHash still groups them as duplicates).
// A row whose file no longer exists is inherited, so moving a file outside Lumina keeps its metadata.
// `entries` are (hash, disk path, is new or changed); returns index -> salted hash.
pub fn resolve_hash_collisions(conn: &Connection, entries: &[(String, String, bool)]) -> HashMap<usize, String> {
    let mut by_hash: HashMap<&str, Vec<usize>> = HashMap::new();
    for (idx, (hash, _, _)) in entries.iter().enumerate() {
        by_hash.entry(hash.as_str()).or_default().push(idx);
    }

    let mut salted = HashMap::new();
    let Ok(mut stmt) = conn.prepare_cached("SELECT current_path FROM photos WHERE hash = ?1") else {
        return salted;
    };

    for (hash, idxs) in by_hash {
        // A unique, unchanged cache hit already owns its row
        if idxs.len() == 1 && !entries[idxs[0]].2 {
            continue;
        }
        let db_path: Option<String> = stmt.query_row(params![hash], |r| r.get(0)).ok();
        let owner = match &db_path {
            Some(dp) if idxs.iter().any(|&i| entries[i].1.eq_ignore_ascii_case(dp)) => {
                idxs.iter().copied().find(|&i| entries[i].1.eq_ignore_ascii_case(dp))
            }
            Some(dp) if Path::new(dp).exists() => None,
            _ => idxs.iter().copied().min_by(|&a, &b| entries[a].1.cmp(&entries[b].1)),
        };
        for &idx in &idxs {
            if Some(idx) != owner {
                salted.insert(idx, salt_hash_with_path(hash, &entries[idx].1));
            }
        }
    }
    salted
}

// A file edited in place (new size, so a new content hash) gets a new row while its old row still claims the
// same path. Moves the old row's tags, people, faces and album entries to the new row and deletes the old one,
// so nothing is lost and the photo isn't counted twice (timeline, people counts).
pub fn retire_replaced_row(conn: &Connection, old: &str, new: &str) -> rusqlite::Result<()> {
    for table in ["photo_tags", "photo_people", "album_photos"] {
        conn.execute(&format!("UPDATE OR IGNORE {table} SET hash = ?2 WHERE hash = ?1"), params![old, new])?;
        conn.execute(&format!("DELETE FROM {table} WHERE hash = ?1"), params![old])?;
    }
    conn.execute("UPDATE photo_faces SET hash = ?2 WHERE hash = ?1", params![old, new])?;
    // The image changed: its smart-search vector is recomputed for the new row
    conn.execute("DELETE FROM photo_clip WHERE hash = ?1", params![old])?;
    conn.execute("DELETE FROM photos WHERE hash = ?1", params![old])?;
    Ok(())
}

// Paths in the folder that more than one row claims
pub fn paths_claimed_twice(conn: &Connection, folder_prefix: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT current_path FROM photos WHERE current_path LIKE ?1 ESCAPE '!'
         GROUP BY current_path HAVING COUNT(*) > 1",
    ) else {
        return Vec::new();
    };
    stmt.query_map(params![folder_prefix], |r| r.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

#[derive(Clone)]
pub struct CachedRow {
    pub size: u64,
    pub mtime: u64,
    pub width: u32,
    pub height: u32,
    pub rating: i32,
    pub flag: Option<String>,
    pub color_label: Option<String>,
    pub rotation: i32,
    pub in_basket: bool,
    pub ai_caption: String,
    pub ocr_text: String,
    pub hash: String,
    pub captured_at: String,
    pub camera_model: String,
    pub location: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub dhash: String,
    pub sharpness: f64,
    pub staged_target: Option<String>,
    pub exif_checked: i32,
    pub focal_length: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub iso: Option<String>,
    pub lens_model: Option<String>,
    pub damaged: bool,
    pub thumb_edge: u32,
}

// One indexed file: the photo, its path on disk, size in bytes, mtime, and whether its row must be written
type IndexedFile = (PhotoItem, String, u64, u64, bool);

// Files indexed between two saves to the library
const INDEX_CHUNK: usize = 1000;

// Gives copies their own hash, then writes new and changed rows in one transaction.
// Returns how many rows were written.
fn save_indexed(
    conn: &mut Connection,
    indexed: &mut [IndexedFile],
    thumbs_dir: &Path,
    previews_dir: &Path,
    force: bool,
) -> usize {
    let collision_entries: Vec<(String, String, bool)> = indexed
        .iter()
        .map(|(p, disk_path, _, _, upsert)| (p.hash.clone(), disk_path.clone(), *upsert))
        .collect();
    for (idx, salted_hash) in resolve_hash_collisions(conn, &collision_entries) {
        let (p, _, _, _, needs_upsert) = &mut indexed[idx];
        let thumb_file = thumbs_dir.join(format!("{}.jpg", salted_hash));
        let preview_file = previews_dir.join(format!("{}_preview.jpg", salted_hash));
        p.thumb_ready = !force && thumb_file.metadata().map(|m| m.len() > 256).unwrap_or(false);
        if p.pair_raw_path.is_some() {
            p.path = if preview_file.exists() { &preview_file } else { &thumb_file }
                .to_string_lossy()
                .to_string();
        }
        p.thumb_path = thumb_file.to_string_lossy().to_string();
        p.tags.retain(|t| t == "screenshot");
        p.people.clear();
        p.faces.clear();
        p.hash = salted_hash;
        *needs_upsert = true;
    }

    let upsert_count = indexed.iter().filter(|(_, _, _, _, upsert)| *upsert).count();
    if upsert_count == 0 {
        return 0;
    }
    if let Ok(tx) = conn.transaction() {
        for (p, orig_disk_path, size_bytes, mtime, needs_upsert) in indexed.iter() {
            if !*needs_upsert {
                continue;
            }
            let _ = tx.execute(
                "INSERT INTO photos (hash, current_path, subfolder, file_size, modified_time, width, height, rating, flag, color_label, rotation, ai_caption, ocr_text, captured_at, camera_model, location, latitude, longitude, dhash, sharpness, staged_target, exif_checked, focal_length, aperture, shutter_speed, iso, lens_model)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, 1, ?22, ?23, ?24, ?25, ?26)
                 ON CONFLICT(hash) DO UPDATE SET
                    current_path = excluded.current_path,
                    subfolder = excluded.subfolder,
                    file_size = excluded.file_size,
                    modified_time = excluded.modified_time,
                    width = CASE WHEN excluded.width > 0 THEN excluded.width ELSE photos.width END,
                    height = CASE WHEN excluded.height > 0 THEN excluded.height ELSE photos.height END,
                    captured_at = excluded.captured_at,
                    camera_model = excluded.camera_model,
                    location = excluded.location,
                    latitude = excluded.latitude,
                    longitude = excluded.longitude,
                    staged_target = excluded.staged_target,
                    focal_length = COALESCE(excluded.focal_length, photos.focal_length),
                    aperture = COALESCE(excluded.aperture, photos.aperture),
                    shutter_speed = COALESCE(excluded.shutter_speed, photos.shutter_speed),
                    iso = COALESCE(excluded.iso, photos.iso),
                    lens_model = COALESCE(excluded.lens_model, photos.lens_model),
                    exif_checked = 1",
                params![
                    p.hash, orig_disk_path, p.subfolder, size_bytes, mtime, p.width, p.height, p.rating,
                    p.flag, p.color_label, p.rotation,
                    p.ai_caption, p.ocr_text, p.captured_at, p.camera_model,
                    p.location, p.latitude, p.longitude, p.dhash, p.sharpness,
                    p.staged_target, p.focal_length, p.aperture, p.shutter_speed, p.iso, p.lens_model
                ],
            );

            if p.tags.iter().any(|t| t == "screenshot") {
                let _ = tx.execute(
                    "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, 'screenshot')",
                    params![p.hash],
                );
            }
        }
        let _ = tx.commit();
    }
    upsert_count
}

#[tauri::command]
pub async fn scan_folder(
    app: AppHandle,
    folder_path: String,
    force_reprocess: Option<bool>,
) -> Result<Vec<PhotoItem>, String> {
    let force = force_reprocess.unwrap_or(false);
    // Every scan supersedes any background thumbnail pass still running from an earlier scan
    let generation = SCAN_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let scan_started = Instant::now();
        let input_path = PathBuf::from(&folder_path);
        let root_path = if input_path.is_file() {
            input_path
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or(input_path)
        } else {
            input_path
        };

        if !root_path.exists() {
            return Err(format!("Folder does not exist: {}", root_path.display()));
        }
        // The webview may only load files from the app's own data folder and from libraries the user opened
        let _ = app.asset_protocol_scope().allow_directory(&root_path, true);
        let is_cancelled = || SCAN_GENERATION.load(Ordering::Acquire) != generation;

        let app_dir = get_app_storage_dir(&app);
        let thumbs_dir = app_dir.join("thumbnails");
        let previews_dir = app_dir.join("previews");
        let _ = fs::create_dir_all(&thumbs_dir);
        let _ = fs::create_dir_all(&previews_dir);

        let _ = app.emit(
            "scan-progress",
            ScanProgressEvent {
                stage: "Loading SQLite index cache...".to_string(),
                current_file: root_path.to_string_lossy().to_string(),
                completed: 0,
                total: 0,
                percent: 0,
                done: false,
            },
        );

        let mut conn = open_global_db(&app)?;
        let folder_prefix = make_folder_prefix(Some(&root_path.to_string_lossy()));

        let mut cache_map: HashMap<String, CachedRow> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT current_path, file_size, modified_time, rating,
                            COALESCE(ai_caption, ''), COALESCE(ocr_text, ''), hash,
                            COALESCE(captured_at, ''), COALESCE(camera_model, ''),
                            COALESCE(location, ''), latitude, longitude,
                            COALESCE(dhash, ''), COALESCE(sharpness, 0.0), staged_target,
                            COALESCE(exif_checked, 0), flag, color_label, COALESCE(rotation, 0), COALESCE(in_basket, 0),
                            COALESCE(width, 0), COALESCE(height, 0),
                            focal_length, aperture, shutter_speed, iso, lens_model,
                            COALESCE(damaged, 0), COALESCE(thumb_edge, 0)
                     FROM photos WHERE current_path LIKE ?1 ESCAPE '!'",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![folder_prefix], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        CachedRow {
                            size: row.get(1)?,
                            mtime: row.get(2)?,
                            rating: row.get(3)?,
                            ai_caption: row.get(4)?,
                            ocr_text: row.get(5)?,
                            hash: row.get(6)?,
                            captured_at: row.get(7)?,
                            camera_model: row.get(8)?,
                            location: row.get(9)?,
                            lat: row.get(10)?,
                            lon: row.get(11)?,
                            dhash: row.get(12)?,
                            sharpness: row.get(13)?,
                            staged_target: row.get(14)?,
                            exif_checked: row.get(15)?,
                            flag: row.get(16)?,
                            color_label: row.get(17)?,
                            rotation: row.get(18)?,
                            in_basket: row.get::<_, i32>(19).unwrap_or(0) != 0,
                            width: row.get::<_, u32>(20).unwrap_or(0),
                            height: row.get::<_, u32>(21).unwrap_or(0),
                            focal_length: row.get(22).ok().flatten(),
                            aperture: row.get(23).ok().flatten(),
                            shutter_speed: row.get(24).ok().flatten(),
                            iso: row.get(25).ok().flatten(),
                            lens_model: row.get(26).ok().flatten(),
                            damaged: row.get::<_, i32>(27).unwrap_or(0) != 0,
                            thumb_edge: row.get::<_, u32>(28).unwrap_or(0),
                        },
                    ))
                })
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                cache_map.insert(r.0, r.1);
            }
        }

        let mut tags_map: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT pt.hash, pt.tag FROM photo_tags pt
                     JOIN photos p ON pt.hash = p.hash
                     WHERE p.current_path LIKE ?1 ESCAPE '!'
                     ORDER BY pt.tag ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![folder_prefix], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                tags_map.entry(r.0).or_default().push(r.1);
            }
        }

        let mut people_map: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT pp.hash, pp.person_name FROM photo_people pp
                     JOIN photos p ON pp.hash = p.hash
                     WHERE p.current_path LIKE ?1 ESCAPE '!'
                     ORDER BY pp.person_name ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![folder_prefix], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                people_map.entry(r.0).or_default().push(r.1);
            }
        }

        let mut faces_map: HashMap<String, Vec<FaceInstance>> = HashMap::new();
        {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT pf.face_id, pf.hash, pf.bbox_x, pf.bbox_y, pf.bbox_w, pf.bbox_h, pf.person_name, pf.face_thumb, pf.confidence,
                        pf.eyes_open, pf.face_sharpness
                 FROM photo_faces pf
                 JOIN photos p ON pf.hash = p.hash
                 WHERE p.current_path LIKE ?1 ESCAPE '!'
                 ORDER BY pf.bbox_x ASC",
            ) {
                if let Ok(rows) = stmt.query_map(params![folder_prefix], |row| {
                    Ok(FaceInstance {
                        face_id: row.get(0)?,
                        hash: row.get(1)?,
                        bbox_x: row.get(2)?,
                        bbox_y: row.get(3)?,
                        bbox_w: row.get(4)?,
                        bbox_h: row.get(5)?,
                        person_name: row.get(6)?,
                        face_thumb: row.get(7)?,
                        confidence: row.get(8)?,
                        eyes_open: row.get(9)?,
                        face_sharpness: row.get(10)?,
                    })
                }) {
                    for f in rows.flatten() {
                        faces_map.entry(f.hash.clone()).or_default().push(f);
                    }
                }
            }
        }

        let cache_ms = elapsed_ms(scan_started);
        let walk_started = Instant::now();
        let candidate_paths: Vec<PathBuf> = WalkDir::new(&root_path)
            .into_iter()
            .filter_entry(|e| {
                if !e.file_type().is_dir() {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                name != ".git"
                    && name != "node_modules"
                    && name != ".triage_cache"
                    && !name.starts_with('$')
            })
            .take_while(|_| !is_cancelled())
            .flatten()
            .filter_map(|entry| {
                if !entry.file_type().is_file() {
                    return None;
                }
                let p = entry.into_path();
                let ext = p.extension()?.to_str()?.to_lowercase();
                if PHOTO_EXTENSIONS.contains(&ext.as_str()) {
                    Some(p)
                } else {
                    None
                }
            })
            .collect();

        let total_candidates = candidate_paths.len();
        let walk_ms = elapsed_ms(walk_started);
        let index_started = Instant::now();
        let scanned_counter = AtomicUsize::new(0);
        let app_scan_progress = app.clone();

        // Reader count matched to the drive: few readers on a hard drive, many on an SSD
        let (io_threads, drive_kind) = index_io_threads(&root_path);
        let index_pool = rayon::ThreadPoolBuilder::new()
            .num_threads(io_threads)
            .build()
            .map_err(|e| e.to_string())?;
        let index_one = |file_path: PathBuf| -> Option<IndexedFile> {
            if is_cancelled() {
                return None;
            }
            let metadata = fs::metadata(&file_path).ok()?;
            let size_bytes = metadata.len();
            if size_bytes == 0 {
                return None;
            }
            let size_kb = size_bytes / 1024;
            let modified_time = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let orig_path_str = file_path.to_string_lossy().to_string();
            let file_name_str = file_path.file_name()?.to_string_lossy().to_string();
            let ext_lower = file_path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            let mut needs_db_upsert = true;

            let (
                hash,
                width,
                height,
                rating,
                flag,
                color_label,
                rotation,
                in_basket,
                ai_caption,
                ocr_text,
                captured_at,
                camera_model,
                location,
                lat,
                lon,
                dhash,
                sharpness,
                staged_target,
                focal_length,
                aperture,
                shutter_speed,
                iso,
                lens_model,
            ) = if let Some(c) = cache_map.get(&orig_path_str) {
                if !force
                    && c.exif_checked == 1
                    && !c.captured_at.is_empty()
                    && c.size == size_bytes
                    && c.mtime == modified_time
                    && !is_old_creation_time_date(&file_path, &c.captured_at, &metadata)
                {
                    needs_db_upsert = false;
                    (
                        c.hash.clone(),
                        c.width,
                        c.height,
                        c.rating,
                        c.flag.clone(),
                        c.color_label.clone(),
                        c.rotation,
                        c.in_basket,
                        c.ai_caption.clone(),
                        c.ocr_text.clone(),
                        c.captured_at.clone(),
                        c.camera_model.clone(),
                        c.location.clone(),
                        c.lat,
                        c.lon,
                        c.dhash.clone(),
                        c.sharpness,
                        c.staged_target.clone(),
                        c.focal_length.clone(),
                        c.aperture.clone(),
                        c.shutter_speed.clone(),
                        c.iso.clone(),
                        c.lens_model.clone(),
                    )
                } else {
                    let (h, head) = if c.size == size_bytes {
                        (c.hash.clone(), None)
                    } else {
                        let (h, head) = hash_and_read_head(&file_path, size_bytes).ok()?;
                        (h, Some(head))
                    };
                    let ex = extract_all_exif_with_head(&file_path, head.as_deref());
                    let (w, ht) = if c.width > 0 && c.height > 0 && !force {
                        (c.width, c.height)
                    } else {
                        (ex.width, ex.height)
                    };
                    (
                        h,
                        w,
                        ht,
                        c.rating,
                        c.flag.clone(),
                        c.color_label.clone(),
                        c.rotation,
                        c.in_basket,
                        c.ai_caption.clone(),
                        c.ocr_text.clone(),
                        if !ex.captured_at.is_empty() { ex.captured_at } else { c.captured_at.clone() },
                        if !ex.camera_model.is_empty() { ex.camera_model } else { c.camera_model.clone() },
                        if !ex.location.is_empty() { ex.location } else { c.location.clone() },
                        ex.lat.or(c.lat),
                        ex.lon.or(c.lon),
                        if force { String::new() } else { c.dhash.clone() },
                        if force { 0.0 } else { c.sharpness },
                        c.staged_target.clone(),
                        ex.focal_length.or_else(|| c.focal_length.clone()),
                        ex.aperture.or_else(|| c.aperture.clone()),
                        ex.shutter_speed.or_else(|| c.shutter_speed.clone()),
                        ex.iso.or_else(|| c.iso.clone()),
                        ex.lens_model.or_else(|| c.lens_model.clone()),
                    )
                }
            } else {
                // One head read serves the hash, the dimensions and the EXIF parse
                let (h, head) = hash_and_read_head(&file_path, size_bytes).ok()?;
                let ex = extract_all_exif_with_head(&file_path, Some(&head));
                (
                    h,
                    ex.width,
                    ex.height,
                    0,
                    None,
                    None,
                    0,
                    false,
                    String::new(),
                    String::new(),
                    ex.captured_at,
                    ex.camera_model,
                    ex.location,
                    ex.lat,
                    ex.lon,
                    String::new(),
                    0.0,
                    None,
                    ex.focal_length,
                    ex.aperture,
                    ex.shutter_speed,
                    ex.iso,
                    ex.lens_model,
                )
            };

            let thumb_file = thumbs_dir.join(format!("{}.jpg", hash));
            let preview_file = previews_dir.join(format!("{}_preview.jpg", hash));
            let is_raw_heic = is_raw_or_heic_ext(&ext_lower);

            // Thumbnail is ready as soon as the 360px thumb file exists (no need to wait for 1920px previews!)
            let thumb_ready = !force && thumb_file.metadata().map(|m| m.len() > 256).unwrap_or(false);

            // For RAW & HEIC files, point display path to the 1920px preview if already cached, otherwise the 360px thumb JPEG so WebView2 renders immediately!
            let display_path_str = if is_raw_heic {
                if preview_file.exists() {
                    preview_file.to_string_lossy().to_string()
                } else {
                    thumb_file.to_string_lossy().to_string()
                }
            } else {
                orig_path_str.clone()
            };

            let subfolder = get_relative_subfolder(&root_path, &file_path);
            let mut tags = tags_map.get(&hash).cloned().unwrap_or_default();

            if is_likely_screenshot(&file_path, &camera_model, None, None)
                && !tags.iter().any(|t| t == "screenshot")
            {
                tags.push("screenshot".to_string());
                tags.sort();
                needs_db_upsert = true;
            }

            let people = people_map.get(&hash).cloned().unwrap_or_default();
            let faces = faces_map.get(&hash).cloned().unwrap_or_default();

            let cur_done = scanned_counter.fetch_add(1, Ordering::Relaxed) + 1;
            if cur_done % 25 == 0 || cur_done == total_candidates {
                let pct = ((cur_done * 100) / total_candidates.max(1)).min(99);
                let _ = app_scan_progress.emit(
                    "scan-progress",
                    ScanProgressEvent {
                        stage: if force {
                            "Deep Reprocessing EXIF & thumbnails...".to_string()
                        } else {
                            "Indexing library files...".to_string()
                        },
                        current_file: file_name_str.clone(),
                        completed: cur_done,
                        total: total_candidates,
                        percent: pct,
                        done: false,
                    },
                );
            }

            Some((
                PhotoItem {
                    hash,
                    name: file_name_str,
                    subfolder,
                    path: display_path_str,
                    thumb_path: thumb_file.to_string_lossy().to_string(),
                    size_kb,
                    width,
                    height,
                    thumb_ready,
                    rating,
                    flag,
                    color_label,
                    rotation,
                    in_basket,
                    tags,
                    people,
                    faces,
                    ai_caption,
                    ocr_text,
                    captured_at,
                    camera_model,
                    location,
                    latitude: lat,
                    longitude: lon,
                    dhash,
                    sharpness,
                    duplicate_group: None,
                    staged_target,
                    focal_length,
                    aperture,
                    shutter_speed,
                    iso,
                    lens_model,
                    pair_raw_path: if is_raw_heic {
                        Some(orig_path_str.clone())
                    } else {
                        None
                    },
                    // Only trust the stored flag while the file is unchanged (a re-download may have fixed it)
                    damaged: cache_map
                        .get(&orig_path_str)
                        .map(|c| c.damaged && c.size == size_bytes && c.mtime == modified_time)
                        .unwrap_or(false),
                },
                orig_path_str,
                size_bytes,
                modified_time,
                needs_db_upsert,
            ))
        };

        // Indexed in chunks, each saved as soon as it's done: a cancelled or interrupted first index keeps
        // its progress, and the next scan picks up where it stopped (saved files are cache hits).
        // A cancelled scan (or one superseded by a newer scan) returns an error; the UI keeps what it showed.
        let mut indexed_results: Vec<IndexedFile> = Vec::with_capacity(total_candidates);
        let mut upsert_count = 0;
        let mut save_ms = 0;
        for chunk in candidate_paths.chunks(INDEX_CHUNK) {
            let mut done: Vec<IndexedFile> =
                index_pool.install(|| chunk.par_iter().cloned().filter_map(&index_one).collect());
            let save_started = Instant::now();
            upsert_count += save_indexed(&mut conn, &mut done, &thumbs_dir, &previews_dir, force);
            save_ms += elapsed_ms(save_started);
            indexed_results.append(&mut done);
            if is_cancelled() {
                return Err(SCAN_CANCELLED.to_string());
            }
        }

        let index_ms = elapsed_ms(index_started).saturating_sub(save_ms);
        let db_started = Instant::now();

        // Rows left behind by files edited in place: fold them into the row this scan uses for that path
        let claimed_twice = paths_claimed_twice(&conn, &folder_prefix);
        if !claimed_twice.is_empty() {
            let mut moved: Vec<(usize, String)> = Vec::new();
            {
                let by_path: HashMap<&str, usize> = indexed_results
                    .iter()
                    .enumerate()
                    .map(|(i, (_, disk_path, _, _, _))| (disk_path.as_str(), i))
                    .collect();
                let in_use: HashSet<&str> = indexed_results.iter().map(|(p, _, _, _, _)| p.hash.as_str()).collect();
                if let Ok(tx) = conn.transaction() {
                    let mut ok = true;
                    for path in &claimed_twice {
                        let Some(&i) = by_path.get(path.as_str()) else { continue };
                        let new_hash = indexed_results[i].0.hash.as_str();
                        let old_hashes: Vec<String> = tx
                            .prepare("SELECT hash FROM photos WHERE current_path = ?1 AND hash != ?2")
                            .and_then(|mut s| {
                                s.query_map(params![path, new_hash], |r| r.get::<_, String>(0))
                                    .map(|rows| rows.flatten().collect())
                            })
                            .unwrap_or_default();
                        for old in old_hashes {
                            if in_use.contains(old.as_str()) {
                                continue;
                            }
                            if retire_replaced_row(&tx, &old, new_hash).is_err() {
                                ok = false;
                                break;
                            }
                            moved.push((i, old));
                        }
                    }
                    if ok {
                        let _ = tx.commit();
                    } else {
                        moved.clear();
                    }
                }
            }
            // The photos sent to the UI get what was just moved onto them
            for (i, old) in moved {
                let p = &mut indexed_results[i].0;
                for t in tags_map.get(&old).into_iter().flatten() {
                    if !p.tags.contains(t) {
                        p.tags.push(t.clone());
                    }
                }
                p.tags.sort();
                for n in people_map.get(&old).into_iter().flatten() {
                    if !p.people.contains(n) {
                        p.people.push(n.clone());
                    }
                }
                p.people.sort();
                for f in faces_map.get(&old).into_iter().flatten() {
                    let mut f = f.clone();
                    f.hash = p.hash.clone();
                    p.faces.push(f);
                }
            }
        }

        let db_ms = save_ms + elapsed_ms(db_started);

        let mut photos: Vec<PhotoItem> = indexed_results
            .into_iter()
            .map(|(p, _, _, _, _)| p)
            .collect();

        let mut raw_stem_map: HashMap<(String, String), String> = HashMap::new();
        for p in &photos {
            let disk_p = p.pair_raw_path.as_deref().unwrap_or(&p.path);
            let path_obj = Path::new(disk_p);
            let stem = path_obj
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let ext = path_obj
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !stem.is_empty() && is_raw_or_heic_ext(&ext) {
                raw_stem_map.insert((p.subfolder.clone(), stem), disk_p.to_string());
            }
        }
        for p in &mut photos {
            let path_obj = Path::new(&p.name);
            let stem = path_obj
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let ext = path_obj
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if matches!(ext.as_str(), "jpg" | "jpeg") {
                if let Some(raw_p) = raw_stem_map.get(&(p.subfolder.clone(), stem)) {
                    p.pair_raw_path = Some(raw_p.clone());
                }
            }
        }

        let _ = app.emit(
            "scan-progress",
            ScanProgressEvent {
                stage: "Ready".to_string(),
                current_file: String::new(),
                completed: photos.len(),
                total: photos.len(),
                percent: 100,
                done: true,
            },
        );

        emit_perf(
            &app,
            if force { "Folder index (deep reprocess)" } else { "Folder index" },
            scan_started,
            photos.len(),
            format!(
                "{} new/changed · db cache {} ms · walk {} ms · index {} ms ({}/s, {} readers, {}) · db write {} ms",
                upsert_count,
                cache_ms,
                walk_ms,
                index_ms,
                per_second(total_candidates, index_ms),
                io_threads,
                drive_kind,
                db_ms
            ),
        );

        photos.sort_by(|a, b| a.subfolder.cmp(&b.subfolder).then(a.name.cmp(&b.name)));
        let hashes: Vec<String> = photos.iter().map(|p| p.hash.clone()).collect();
        assign_duplicate_groups(&mut photos, &clip::clip_vectors(&conn, &hashes));

        // Thumbnails from before the 480 px size keep showing until their replacement is written
        let upgrade: HashSet<String> = if force {
            HashSet::new()
        } else {
            let outdated: HashSet<&str> = cache_map
                .values()
                .filter(|c| c.thumb_edge < THUMB_EDGE)
                .map(|c| c.hash.as_str())
                .collect();
            photos
                .iter()
                .filter(|p| p.thumb_ready && outdated.contains(p.hash.as_str()))
                .map(|p| p.hash.clone())
                .collect()
        };
        let needs_processing: Vec<PhotoItem> = photos
            .iter()
            .filter(|p| force || !p.thumb_ready || p.dhash.is_empty() || upgrade.contains(&p.hash))
            .cloned()
            .collect();

        if !needs_processing.is_empty() {
            spawn_thumbnail_pass(app.clone(), needs_processing, root_path.clone(), generation, force, upgrade);
        }

        Ok(photos)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- FORCE EXIF RESCAN (INDIVIDUAL & BATCH) -----------------

#[tauri::command]
pub async fn rescan_exif_batch(app: AppHandle, hashes: Vec<String>) -> Result<Vec<ExifRefreshResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_global_db(&app)?;
        let mut results = Vec::new();

        if let Ok(tx) = conn.transaction() {
            for h in &hashes {
                let row_opt: Option<(String, String, String, String, Option<f64>, Option<f64>)> = tx
                    .query_row(
                        "SELECT current_path, COALESCE(captured_at, ''), COALESCE(camera_model, ''), COALESCE(location, ''), latitude, longitude
                         FROM photos WHERE hash = ?1",
                        params![h],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                    )
                    .ok();

                if let Some((path_str, old_date, old_cam, old_loc, old_lat, old_lon)) = row_opt {
                    let path_obj = Path::new(&path_str);
                    let ex = extract_all_exif_single_pass(path_obj);

                    let final_date = if !ex.captured_at.is_empty() { ex.captured_at } else { old_date };
                    let final_cam = if !ex.camera_model.is_empty() { ex.camera_model } else { old_cam };
                    let final_loc = if !ex.location.is_empty() { ex.location } else { old_loc };
                    let final_lat = ex.lat.or(old_lat);
                    let final_lon = ex.lon.or(old_lon);

                    let _ = tx.execute(
                        "UPDATE photos SET
                            captured_at = ?1,
                            camera_model = ?2,
                            location = ?3,
                            latitude = ?4,
                            longitude = ?5,
                            focal_length = COALESCE(?6, focal_length),
                            aperture = COALESCE(?7, aperture),
                            shutter_speed = COALESCE(?8, shutter_speed),
                            iso = COALESCE(?9, iso),
                            lens_model = COALESCE(?10, lens_model),
                            exif_checked = 1
                         WHERE hash = ?11",
                        params![
                            final_date, final_cam, final_loc, final_lat, final_lon,
                            ex.focal_length, ex.aperture, ex.shutter_speed, ex.iso, ex.lens_model, h
                        ],
                    );

                    results.push(ExifRefreshResult {
                        hash: h.clone(),
                        captured_at: final_date,
                        camera_model: final_cam,
                        location: final_loc,
                        latitude: final_lat,
                        longitude: final_lon,
                        focal_length: ex.focal_length,
                        aperture: ex.aperture,
                        shutter_speed: ex.shutter_speed,
                        iso: ex.iso,
                        lens_model: ex.lens_model,
                    });
                }
            }
            let _ = tx.commit();
        }

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}
