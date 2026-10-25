use crate::*;

// ----------------- INTERACTIVE FACE SELECTION & PRECISION AUTO-MATCHER -----------------

#[tauri::command]
pub async fn detect_faces_in_photo(
    app: AppHandle,
    hash: String,
    image_path: String,
    force_onnx: Option<bool>,
) -> Result<Vec<FaceInstance>, String> {
    let run_neural = force_onnx.unwrap_or(false);
    if run_neural {
        ensure_neural_face_models(app.clone()).await?;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let existing = get_faces_for_hash(&conn, &hash);
        if !run_neural && !existing.is_empty() {
            return Ok(existing);
        }

        if let Ok(img) = open_and_orient_image(Path::new(&image_path)) {
            let onnx_boxes = detect_faces_with_onnx(&app, &img);
            let old_rejected = rejected_unnamed_faces(&conn, &hash);
            // Clear any old un-named boxes on this photo before inserting fresh ONNX boxes
            let _ = conn.execute(
                "DELETE FROM photo_faces WHERE hash = ?1 AND (person_name IS NULL OR person_name = '')",
                params![hash],
            );
            for (bx, by, bw, bh, _score) in onnx_boxes {
                let _ = save_cropped_face_and_record(&app, &conn, &hash, &img, (bx, by, bw, bh), None, "onnx");
            }
            if !old_rejected.is_empty() {
                let new_faces: Vec<(String, (f64, f64, f64, f64))> = get_faces_for_hash(&conn, &hash)
                    .into_iter()
                    .map(|f| (f.face_id, (f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h)))
                    .collect();
                carry_over_rejections(&conn, &old_rejected, &new_faces);
            }
        }

        Ok(get_faces_for_hash(&conn, &hash))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub struct PendingFaceWrite {
    pub face: FaceInstance,
    pub emb_json: String,
}

#[tauri::command]
pub async fn scan_library_faces_batch(
    app: AppHandle,
    hashes: Vec<String>,
) -> Result<usize, String> {
    // 1. Ensure the UltraFace ONNX model is downloaded & cached locally
    let _ = ensure_neural_face_models(app.clone()).await?;

    let total_hashes = hashes.len();
    let app_clone = app.clone();
    FACE_SCAN_CANCEL.store(false, Ordering::Release);
    std::thread::spawn(move || {
        let outcome = run_face_scan(&app_clone, hashes);
        // However the scan ended (finished, cancelled, DB error, empty list), the UI must get a final `done`
        if !outcome.done_sent {
            let _ = app_clone.emit(
                "face-scan-progress",
                FaceScanProgress {
                    completed: outcome.completed,
                    total: total_hashes,
                    faces_found: outcome.faces_found,
                    auto_matched: outcome.auto_matched,
                    batch_faces: HashMap::new(),
                    batch_people: HashMap::new(),
                    done: true,
                    cancelled: outcome.cancelled,
                },
            );
        }
    });

    Ok(total_hashes)
}

pub static FACE_SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn cancel_face_scan() {
    FACE_SCAN_CANCEL.store(true, Ordering::Release);
}

#[derive(Default)]
struct FaceScanOutcome {
    completed: usize,
    faces_found: usize,
    auto_matched: usize,
    done_sent: bool,
    cancelled: bool,
}

// Re-detection replaces unnamed faces with new face_ids; move each old (face, person) rejection onto the
// new face covering the same spot, so a "this is not Anna" decision survives a rescan.
pub fn carry_over_rejections(
    conn: &Connection,
    old_rejected: &[(String, (f64, f64, f64, f64))],
    new_faces: &[(String, (f64, f64, f64, f64))],
) {
    for (old_id, old_box) in old_rejected {
        let best = new_faces
            .iter()
            .map(|(id, b)| (id, bbox_iou(*old_box, *b)))
            .filter(|(_, iou)| *iou >= 0.3)
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        match best {
            Some((new_id, _)) if new_id != old_id => {
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO face_rejections (face_id, person_name)
                     SELECT ?1, person_name FROM face_rejections WHERE face_id = ?2",
                    params![new_id, old_id],
                );
                let _ = conn.execute("DELETE FROM face_rejections WHERE face_id = ?1", params![old_id]);
            }
            Some(_) => {}
            None => {
                let _ = conn.execute("DELETE FROM face_rejections WHERE face_id = ?1", params![old_id]);
            }
        }
    }
}

// Unnamed faces of `hash` that carry at least one rejection (the ones whose decisions must survive re-detection)
pub fn rejected_unnamed_faces(conn: &Connection, hash: &str) -> Vec<(String, (f64, f64, f64, f64))> {
    let Ok(mut stmt) = conn.prepare_cached(
        "SELECT DISTINCT pf.face_id, pf.bbox_x, pf.bbox_y, pf.bbox_w, pf.bbox_h
         FROM photo_faces pf JOIN face_rejections fr ON fr.face_id = pf.face_id
         WHERE pf.hash = ?1 AND (pf.person_name IS NULL OR pf.person_name = '')",
    ) else {
        return Vec::new();
    };
    stmt.query_map(params![hash], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn run_face_scan(app_clone: &AppHandle, hashes: Vec<String>) -> FaceScanOutcome {
    {
        let face_scan_started = Instant::now();
        let Ok(mut conn) = open_global_db(app_clone) else {
            return FaceScanOutcome::default();
        };

        // Pre-warm the ONNX model plans once before entering the parallel Rayon pool
        let model_load_started = Instant::now();
        let _ = get_or_load_ultraface(&app_clone);
        let _ = get_or_load_mobilefacenet(&app_clone);
        let model_load_ms = elapsed_ms(model_load_started);

        // Remember rejected unnamed faces before they are deleted, so their rejections can be re-attached
        let old_rejected: HashMap<String, Vec<(String, (f64, f64, f64, f64))>> = hashes
            .iter()
            .map(|h| (h.clone(), rejected_unnamed_faces(&conn, h)))
            .filter(|(_, v)| !v.is_empty())
            .collect();

        // Unnamed faces are replaced photo by photo as each chunk is processed (not all up front),
        // so cancelling a scan leaves the photos it never reached exactly as they were.
        if let Ok(mut g) = FACE_EMBEDDING_CACHE.lock() {
            g.clear();
        }
        if let Ok(mut g) = PENDING_CANDIDATES_CACHE.lock() {
            g.clear();
        }
        EMBEDDING_CACHE_WARMED.store(false, Ordering::Release);

        // Pre-fetch current_path for all requested hashes in one pass
        let mut path_map: HashMap<String, String> = HashMap::with_capacity(hashes.len());
        if let Ok(mut stmt) = conn.prepare("SELECT hash, current_path FROM photos") {
            if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                for (h, p) in rows.flatten() {
                    path_map.insert(h, p);
                }
            }
        }

        let app_dir = get_app_storage_dir(&app_clone);
        let previews_dir = app_dir.join("previews");
        let faces_dir = app_dir.join("faces");
        let _ = fs::create_dir_all(&faces_dir);

        let total = hashes.len();
        let mut completed_count = 0usize;
        let mut faces_found = 0usize;
        let mut auto_matched = 0usize;

        // Shared low-priority pool: a face scan running next to a thumbnail pass no longer doubles the threads
        let num_threads = BG_POOL.current_num_threads();

        let mut done_sent = false;
        let mut cancelled = false;
        BG_POOL.install(|| {
            for chunk in hashes.chunks(24) {
                if FACE_SCAN_CANCEL.load(Ordering::Acquire) {
                    cancelled = true;
                    break;
                }
                let chunk_results: Vec<(String, Vec<PendingFaceWrite>)> = chunk
                    .par_iter()
                    .filter_map(|h| {
                        let orig_path = path_map.get(h)?;
                        let preview_path = previews_dir.join(format!("{}_preview.jpg", h));
                        let load_path = if preview_path.exists() {
                            preview_path.to_string_lossy().to_string()
                        } else {
                            orig_path.clone()
                        };

                        let img = open_and_orient_image(Path::new(&load_path)).ok()?;
                        let (img_w, img_h) = img.dimensions();
                        if img_w < 32 || img_h < 32 {
                            return Some((h.clone(), Vec::new()));
                        }

                        let boxes = detect_faces_with_onnx(&app_clone, &img);
                        if boxes.is_empty() {
                            return Some((h.clone(), Vec::new()));
                        }

                        let mut writes = Vec::with_capacity(boxes.len());
                        for (bx, by, bw, bh, _conf) in boxes {
                            let x = ((bx.clamp(0.0, 0.95)) * img_w as f64) as u32;
                            let y = ((by.clamp(0.0, 0.95)) * img_h as f64) as u32;
                            let w = ((bw.clamp(0.03, 1.0)) * img_w as f64)
                                .min((img_w - x) as f64)
                                .max(16.0) as u32;
                            let ht = ((bh.clamp(0.03, 1.0)) * img_h as f64)
                                .min((img_h - y) as f64)
                                .max(16.0) as u32;

                            let aspect = (w as f64) / (ht as f64).max(1.0);
                            if !(0.55..=1.45).contains(&aspect) {
                                continue;
                            }

                            let cropped = img.crop_imm(x, y, w, ht);
                            if !has_bilateral_face_structure(&cropped) {
                                continue;
                            }

                            let embedding = compute_face_embedding(&cropped);
                            if embedding.len() != 512 {
                                continue;
                            }
                            let emb_json =
                                serde_json::to_string(&embedding).unwrap_or_else(|_| "[]".to_string());

                            let face_id = format!(
                                "{}_{}_{}",
                                h,
                                (bx * 100.0).round() as i32,
                                (by * 100.0).round() as i32
                            );
                            let face_thumb_path = faces_dir.join(format!("{}.jpg", face_id));
                            let thumb_96 = cropped.resize_to_fill(96, 96, FilterType::Triangle).to_rgb8();
                            let _ = thumb_96.save(&face_thumb_path);
                            let face_thumb_str = face_thumb_path.to_string_lossy().to_string();

                            let matched_person: Option<String> = None;
                            let matched_conf = 1.0f64;

                            writes.push(PendingFaceWrite {
                                face: FaceInstance {
                                    face_id,
                                    hash: h.clone(),
                                    bbox_x: bx,
                                    bbox_y: by,
                                    bbox_w: bw,
                                    bbox_h: bh,
                                    person_name: matched_person,
                                    face_thumb: face_thumb_str,
                                    confidence: matched_conf,
                                },
                                emb_json,
                            });
                        }

                        Some((h.clone(), writes))
                    })
                    .collect();

                completed_count += chunk.len();
                let mut batch_faces: HashMap<String, Vec<FaceInstance>> = HashMap::new();
                let mut batch_people: HashMap<String, Vec<String>> = HashMap::new();

                if !chunk_results.is_empty() {
                    if let Ok(tx) = conn.transaction() {
                        for (h, writes) in &chunk_results {
                            let _ = tx.execute(
                                "DELETE FROM photo_faces WHERE hash = ?1 AND (person_name IS NULL OR person_name = '')",
                                params![h],
                            );
                            let mut claimed_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
                            let mut inserted: Vec<(String, (f64, f64, f64, f64))> = Vec::new();
                            for item in writes {
                                faces_found += 1;
                                let f = &item.face;

                                // Check if this ONNX box overlaps an existing (e.g. already-named) face on this photo
                                let (target_face_id, target_person) = if let Some((existing_id, existing_name)) =
                                    find_overlapping_face_id(&tx, h, (f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h), Some(&claimed_ids))
                                {
                                    claimed_ids.insert(existing_id.clone());
                                    (existing_id, existing_name.or_else(|| f.person_name.clone()))
                                } else {
                                    claimed_ids.insert(f.face_id.clone());
                                    (f.face_id.clone(), f.person_name.clone())
                                };

                                if let Ok(vec) = serde_json::from_str::<Vec<f32>>(&item.emb_json) {
                                    if let Ok(mut guard) = FACE_EMBEDDING_CACHE.lock() {
                                        guard.insert(target_face_id.clone(), vec);
                                    }
                                }
                                let target_thumb_str = if target_face_id != f.face_id {
                                    let existing_thumb = faces_dir.join(format!("{}.jpg", target_face_id));
                                    let _ = fs::copy(&f.face_thumb, &existing_thumb);
                                    existing_thumb.to_string_lossy().to_string()
                                } else {
                                    f.face_thumb.clone()
                                };

                                let _ = tx.execute(
                                    "INSERT INTO photo_faces (face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, person_name, face_thumb, embedding, confidence, source)
                                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'onnx')
                                    ON CONFLICT(face_id) DO UPDATE SET
                                        bbox_x = excluded.bbox_x,
                                        bbox_y = excluded.bbox_y,
                                        bbox_w = excluded.bbox_w,
                                        bbox_h = excluded.bbox_h,
                                        person_name = COALESCE(photo_faces.person_name, excluded.person_name),
                                        face_thumb = excluded.face_thumb,
                                        embedding = excluded.embedding,
                                        confidence = excluded.confidence,
                                        source = 'onnx'",
                                    params![
                                        target_face_id,
                                        f.hash,
                                        f.bbox_x,
                                        f.bbox_y,
                                        f.bbox_w,
                                        f.bbox_h,
                                        target_person,
                                        target_thumb_str,
                                        item.emb_json,
                                        f.confidence
                                    ],
                                );
                                if let Some(ref matched_name) = target_person {
                                    auto_matched += 1;
                                    let _ = tx.execute(
                                        "INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)",
                                        params![h, matched_name],
                                    );
                                }
                                inserted.push((target_face_id, (f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h)));
                            }
                            if let Some(old) = old_rejected.get(h) {
                                carry_over_rejections(&tx, old, &inserted);
                            }
                        }
                        let _ = tx.commit();
                    }

                    for (h, _) in &chunk_results {
                        let all_faces = get_faces_for_hash(&conn, h);
                        let mut p_list: Vec<String> = all_faces
                            .iter()
                            .filter_map(|f| f.person_name.clone())
                            .collect();
                        p_list.sort();
                        p_list.dedup();
                        if !p_list.is_empty() {
                            batch_people.insert(h.clone(), p_list);
                        }
                        batch_faces.insert(h.clone(), all_faces);
                    }
                }

                let _ = app_clone.emit(
                    "face-scan-progress",
                    FaceScanProgress {
                        completed: completed_count,
                        total,
                        faces_found,
                        auto_matched,
                        batch_faces,
                        batch_people,
                        done: completed_count >= total,
                        cancelled: false,
                    },
                );
                done_sent = completed_count >= total;
            }
        });

        let total_ms = elapsed_ms(face_scan_started);
        emit_perf(
            app_clone,
            if cancelled { "Face scan (cancelled)" } else { "Face scan (UltraFace + MobileFaceNet)" },
            face_scan_started,
            completed_count,
            format!(
                "{} photos/s on {} threads · {} faces found · model load {} ms",
                per_second(completed_count, total_ms),
                num_threads,
                faces_found,
                model_load_ms
            ),
        );

        FaceScanOutcome {
            completed: completed_count,
            faces_found,
            auto_matched,
            done_sent,
            cancelled,
        }
    }
}

#[tauri::command]
pub async fn assign_face_region_and_automatch(
    app: AppHandle,
    hash: String,
    image_path: String,
    bbox_x: f64,
    bbox_y: f64,
    bbox_w: f64,
    bbox_h: f64,
    person_name: String,
) -> Result<Vec<FaceInstance>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean_name = person_name.trim().to_string();
        if clean_name.is_empty() {
            return Err("Person name cannot be empty".into());
        }

        let img = open_and_orient_image(Path::new(&image_path))
            .map_err(|e| format!("Failed to open image: {e}"))?;
        let conn = open_global_db(&app)?;

        let _saved_face = save_cropped_face_and_record(
            &app,
            &conn,
            &hash,
            &img,
            (bbox_x, bbox_y, bbox_w, bbox_h),
            Some(clean_name.clone()),
            "onnx",
        )
        .ok_or("Failed to crop face region")?;

        // Emit completion event without silently mutating other photos behind the user's back;
        // pending matches will surface via +N? badges for explicit confirmation in the Review Studio!
        let _ = app.emit(
            "face-automatch-complete",
            FaceMatchEvent {
                person_name: clean_name.clone(),
                total_matched: 0,
                matched_hashes: Vec::new(),
            },
        );

        Ok(get_faces_for_hash(&conn, &hash))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn remove_face_box(app: AppHandle, face_id: String, hash: String) -> Result<Vec<FaceInstance>, String> {
    let conn = open_global_db(&app)?;
    let prev_person: Option<String> = conn
        .query_row(
            "SELECT person_name FROM photo_faces WHERE face_id = ?1",
            params![face_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let _ = conn.execute("DELETE FROM photo_faces WHERE face_id = ?1", params![face_id]);
    sync_photo_people_from_faces(&conn, &hash, prev_person.as_deref());
    Ok(get_faces_for_hash(&conn, &hash))
}

#[tauri::command]
pub async fn get_people(app: AppHandle, root_folder: Option<String>) -> Result<Vec<PersonItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let prefix = make_folder_prefix(root_folder.as_deref());
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.name, COUNT(DISTINCT pp.hash) as cnt,
                        COALESCE(NULLIF(p.cover_face_thumb, ''), '') as face_crop,
                        MIN(pp.hash) as fallback_hash
                 FROM people p
                 JOIN photo_people pp ON p.name = pp.person_name
                 JOIN photos ph_main ON pp.hash = ph_main.hash
                 WHERE ph_main.current_path LIKE ?1 ESCAPE '!'
                 GROUP BY p.name
                 HAVING cnt > 0
                 ORDER BY cnt DESC",
            )
            .map_err(|e| e.to_string())?;

        let app_dir = get_app_storage_dir(&app);
        let thumbs_dir = app_dir.join("thumbnails");

        let rows = stmt
            .query_map(params![prefix], |row| {
                let face_crop: String = row.get(3)?;
                let fallback_h: Option<String> = row.get(4)?;
                let cover_thumb = if !face_crop.is_empty() && Path::new(&face_crop).exists() {
                    face_crop
                } else {
                    fallback_h
                        .map(|h| thumbs_dir.join(format!("{}.jpg", h)).to_string_lossy().to_string())
                        .unwrap_or_default()
                };

                Ok(PersonItem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    photo_count: row.get(2)?,
                    cover_thumb,
                })
            })
            .map_err(|e| e.to_string())?;

        Ok(rows.flatten().collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Tags a person on many photos in one transaction (the UI used to call a per-photo command in a loop)
#[tauri::command]
pub fn add_person_to_photos(app: AppHandle, hashes: Vec<String>, name: String) -> Result<usize, String> {
    let clean = name.trim().to_string();
    if clean.is_empty() {
        return Err("Name cannot be empty".into());
    }
    let mut conn = open_global_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO people (name) VALUES (?1)", params![clean])
        .map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for h in &hashes {
            stmt.execute(params![h, clean]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(hashes.len())
}

#[tauri::command]
pub fn remove_person_from_photo(app: AppHandle, hash: String, name: String) -> Result<Vec<String>, String> {
    let conn = open_global_db(&app)?;
    conn.execute(
        "DELETE FROM photo_people WHERE hash = ?1 AND person_name = ?2",
        params![hash, name],
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "UPDATE photo_faces SET person_name = NULL WHERE hash = ?1 AND person_name = ?2",
        params![hash, name],
    );

    let mut stmt = conn
        .prepare("SELECT person_name FROM photo_people WHERE hash = ?1 ORDER BY person_name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![hash], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[derive(Serialize, Clone)]
pub struct SimilarFaceCandidate {
    pub face_id: String,
    pub hash: String,
    pub face_thumb: String,
    pub photo_name: String,
    pub photo_path: String,
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub current_person: Option<String>,
    pub similarity: f32,
}

pub fn format_display_photo_path(
    photo_path: String,
    hash: &str,
    previews_dir: &Path,
    thumbs_dir: &Path,
) -> (String, String) {
    let path_obj = Path::new(&photo_path);
    let photo_name = path_obj
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| hash.to_string());
    let ext = path_obj
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let display_photo_path = if is_raw_or_heic_ext(&ext) {
        let prev = previews_dir.join(format!("{}_preview.jpg", hash));
        let th = thumbs_dir.join(format!("{}.jpg", hash));
        if prev.exists() {
            prev.to_string_lossy().to_string()
        } else if th.exists() {
            th.to_string_lossy().to_string()
        } else {
            photo_path
        }
    } else {
        photo_path
    };
    (photo_name, display_photo_path)
}

#[tauri::command]
pub async fn find_similar_faces(
    app: AppHandle,
    person_name: String,
    root_folder: Option<String>,
    min_similarity: Option<f32>,
    force_refresh: Option<bool>,
) -> Result<Vec<SimilarFaceCandidate>, String> {
    let clean_name = person_name.trim().to_string();
    let cache_key = pending_cache_key(&clean_name, root_folder.as_deref());
    // Only results at the standard threshold are cached, so a custom threshold never pollutes the badge counts
    let uses_standard_threshold = min_similarity.is_none();

    // Fast path (<0.1ms): if get_pending_face_match_counts already precomputed the candidates for this person, return them immediately!
    if !force_refresh.unwrap_or(false) && uses_standard_threshold {
        if let Ok(guard) = PENDING_CANDIDATES_CACHE.lock() {
            if let Some(cached) = guard.get(&cache_key) {
                return Ok(cached.clone());
            }
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        ensure_embedding_cache_loaded(&conn);
        let prefix = make_folder_prefix(root_folder.as_deref());

        // 1. Query only face_id for confirmed faces of this person (ZERO embedding blob reads!)
        let mut ref_ids: Vec<String> = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT face_id FROM photo_faces WHERE lower(person_name) = lower(?1)")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![clean_name], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for fid in rows.flatten() {
                ref_ids.push(fid);
            }
        }

        if ref_ids.is_empty() {
            return Ok(Vec::new());
        }

        let thumbs_dir = get_app_storage_dir(&app).join("thumbnails");
        let previews_dir = get_app_storage_dir(&app).join("previews");

        // 2. Query only UNASSIGNED faces within the active library folder that haven't been rejected
        let mut stmt = conn
            .prepare(
                "SELECT pf.face_id, pf.hash, pf.face_thumb, pf.person_name,
                        COALESCE(p.current_path, ''), pf.bbox_x, pf.bbox_y, pf.bbox_w, pf.bbox_h
                 FROM photo_faces pf
                 JOIN photos p ON pf.hash = p.hash
                 WHERE (pf.person_name IS NULL OR pf.person_name = '')
                   AND p.current_path LIKE ?2 ESCAPE '!'
                   AND NOT EXISTS (
                       SELECT 1 FROM face_rejections fr
                       WHERE fr.face_id = pf.face_id AND lower(fr.person_name) = lower(?1)
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM photo_people pp
                       WHERE pp.hash = pf.hash AND lower(pp.person_name) = lower(?1)
                   )",
            )
            .map_err(|e| e.to_string())?;

        let raw_rows: Vec<(String, String, String, Option<String>, String, f64, f64, f64, f64)> = stmt
            .query_map(params![clean_name, prefix], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();

        // 3. Score in memory using a single lock on FACE_EMBEDDING_CACHE
        let cache_guard = FACE_EMBEDDING_CACHE.lock().map_err(|e| e.to_string())?;
        let ref_embeddings: Vec<Vec<f32>> = ref_ids
            .iter()
            .filter_map(|id| cache_guard.get(id).cloned())
            .collect();

        if ref_embeddings.is_empty() {
            return Ok(Vec::new());
        }

        let centroid_512 = compute_normalized_centroid(&ref_embeddings, 512);
        let centroid_384 = compute_normalized_centroid(&ref_embeddings, 384);

        let mut candidates = Vec::new();
        for (face_id, hash, face_thumb, cur_person, photo_path, bx, by, bw, bh) in raw_rows {
            let Some(cand_emb) = cache_guard.get(&face_id) else {
                continue;
            };
            let thresh = min_similarity.unwrap_or(FACE_MATCH_MIN_SIMILARITY);

            let best_sim = score_against_person_profile(
                cand_emb,
                &ref_embeddings,
                centroid_512.as_ref(),
                centroid_384.as_ref(),
            );

            if best_sim >= thresh {
                let (photo_name, display_photo_path) =
                    format_display_photo_path(photo_path, &hash, &previews_dir, &thumbs_dir);

                candidates.push(SimilarFaceCandidate {
                    face_id,
                    hash,
                    face_thumb,
                    photo_name,
                    photo_path: display_photo_path,
                    bbox_x: bx,
                    bbox_y: by,
                    bbox_w: bw,
                    bbox_h: bh,
                    current_person: cur_person,
                    similarity: (best_sim * 1000.0).round() / 10.0,
                });
            }
        }
        drop(cache_guard);

        candidates.sort_by(|a, b| {
            b.similarity
                .partial_cmp(&a.similarity)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(120);

        if uses_standard_threshold {
            if let Ok(mut pending_guard) = PENDING_CANDIDATES_CACHE.lock() {
                pending_guard.insert(cache_key, candidates.clone());
            }
        }

        Ok(candidates)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_confirmed_faces_for_person(
    app: AppHandle,
    person_name: String,
) -> Result<Vec<SimilarFaceCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let clean = person_name.trim().to_string();
        if clean.is_empty() {
            return Ok(Vec::new());
        }
        let thumbs_dir = get_app_storage_dir(&app).join("thumbnails");
        let previews_dir = get_app_storage_dir(&app).join("previews");

        let mut stmt = conn
            .prepare(
                "SELECT pf.face_id, pf.hash, pf.face_thumb, pf.person_name,
                        COALESCE(p.current_path, ''), pf.bbox_x, pf.bbox_y, pf.bbox_w, pf.bbox_h
                 FROM photo_faces pf
                 LEFT JOIN photos p ON pf.hash = p.hash
                 WHERE lower(pf.person_name) = lower(?1)
                 ORDER BY p.captured_at DESC, pf.face_id ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![clean], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, f64>(5)?,
                    r.get::<_, f64>(6)?,
                    r.get::<_, f64>(7)?,
                    r.get::<_, f64>(8)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for (face_id, hash, face_thumb, cur_person, photo_path, bx, by, bw, bh) in rows.flatten() {
            let (photo_name, display_photo_path) =
                format_display_photo_path(photo_path, &hash, &previews_dir, &thumbs_dir);
            out.push(SimilarFaceCandidate {
                face_id,
                hash,
                face_thumb,
                photo_name,
                photo_path: display_photo_path,
                bbox_x: bx,
                bbox_y: by,
                bbox_w: bw,
                bbox_h: bh,
                current_person: cur_person,
                similarity: 100.0,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_rejected_faces_for_person(
    app: AppHandle,
    person_name: String,
) -> Result<Vec<SimilarFaceCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let clean = person_name.trim().to_string();
        if clean.is_empty() {
            return Ok(Vec::new());
        }
        let thumbs_dir = get_app_storage_dir(&app).join("thumbnails");
        let previews_dir = get_app_storage_dir(&app).join("previews");

        let mut stmt = conn
            .prepare(
                "SELECT pf.face_id, pf.hash, pf.face_thumb, pf.person_name,
                        COALESCE(p.current_path, ''), pf.bbox_x, pf.bbox_y, pf.bbox_w, pf.bbox_h
                 FROM face_rejections fr
                 JOIN photo_faces pf ON fr.face_id = pf.face_id
                 LEFT JOIN photos p ON pf.hash = p.hash
                 WHERE lower(fr.person_name) = lower(?1)
                 ORDER BY p.captured_at DESC, pf.face_id ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![clean], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, f64>(5)?,
                    r.get::<_, f64>(6)?,
                    r.get::<_, f64>(7)?,
                    r.get::<_, f64>(8)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for (face_id, hash, face_thumb, cur_person, photo_path, bx, by, bw, bh) in rows.flatten() {
            let (photo_name, display_photo_path) =
                format_display_photo_path(photo_path, &hash, &previews_dir, &thumbs_dir);
            out.push(SimilarFaceCandidate {
                face_id,
                hash,
                face_thumb,
                photo_name,
                photo_path: display_photo_path,
                bbox_x: bx,
                bbox_y: by,
                bbox_w: bw,
                bbox_h: bh,
                current_person: cur_person,
                similarity: 0.0,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reject_face_candidates_batch(
    app: AppHandle,
    face_ids: Vec<String>,
    person_name: String,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = person_name.trim().to_string();
        if clean.is_empty() || face_ids.is_empty() {
            return Ok(0);
        }
        let mut conn = open_global_db(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for fid in &face_ids {
            let _ = tx.execute(
                "INSERT OR IGNORE INTO face_rejections (face_id, person_name) VALUES (?1, ?2)",
                params![fid, clean],
            );
        }
        tx.commit().map_err(|e| e.to_string())?;
        if let Ok(mut g) = PENDING_CANDIDATES_CACHE.lock() {
            let person_prefix = format!("{}|", clean.to_lowercase());
            let id_set: std::collections::HashSet<&String> = face_ids.iter().collect();
            for (key, list) in g.iter_mut() {
                if key.starts_with(&person_prefix) {
                    list.retain(|c| !id_set.contains(&c.face_id));
                }
            }
        }
        Ok(face_ids.len())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn unreject_face_candidates_batch(
    app: AppHandle,
    face_ids: Vec<String>,
    person_name: String,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = person_name.trim().to_string();
        if clean.is_empty() || face_ids.is_empty() {
            return Ok(0);
        }
        let mut conn = open_global_db(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for fid in &face_ids {
            let _ = tx.execute(
                "DELETE FROM face_rejections WHERE face_id = ?1 AND lower(person_name) = lower(?2)",
                params![fid, clean],
            );
        }
        tx.commit().map_err(|e| e.to_string())?;
        // Restored faces must show up as candidates again on the next lookup
        invalidate_pending_for_person(&clean);
        Ok(face_ids.len())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn unassign_faces_batch(
    app: AppHandle,
    face_ids: Vec<String>,
    person_name: String,
) -> Result<HashMap<String, Vec<FaceInstance>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = person_name.trim().to_string();
        if face_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut conn = open_global_db(&app)?;
        let mut affected_hashes: Vec<String> = Vec::new();

        if let Ok(tx) = conn.transaction() {
            for fid in &face_ids {
                if let Ok(h) = tx.query_row(
                    "SELECT hash FROM photo_faces WHERE face_id = ?1",
                    params![fid],
                    |r| r.get::<_, String>(0),
                ) {
                    let _ = tx.execute(
                        "UPDATE photo_faces SET person_name = NULL WHERE face_id = ?1",
                        params![fid],
                    );
                    if !affected_hashes.contains(&h) {
                        affected_hashes.push(h);
                    }
                }
            }
            let _ = tx.commit();
        }

        let mut updated_faces_map: HashMap<String, Vec<FaceInstance>> = HashMap::new();
        for h in affected_hashes {
            sync_photo_people_from_faces(&conn, &h, Some(&clean));
            updated_faces_map.insert(h.clone(), get_faces_for_hash(&conn, &h));
        }

        Ok(updated_faces_map)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_pending_face_match_counts(
    app: AppHandle,
    root_folder: Option<String>,
) -> Result<HashMap<String, usize>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        ensure_embedding_cache_loaded(&conn);
        let prefix = make_folder_prefix(root_folder.as_deref());
        let thumbs_dir = get_app_storage_dir(&app).join("thumbnails");
        let previews_dir = get_app_storage_dir(&app).join("previews");

        // 1. Query only (face_id, person_name) without reading the 8KB embedding strings!
        let mut person_ref_ids: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT face_id, person_name FROM photo_faces
                     WHERE person_name IS NOT NULL AND person_name != ''",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            for (fid, pname) in rows.flatten() {
                person_ref_ids.entry(pname).or_default().push(fid);
            }
        }

        if person_ref_ids.is_empty() {
            replace_pending_for_folder(root_folder.as_deref(), HashMap::new());
            return Ok(HashMap::new());
        }

        // 2. Load all rejected (face_id, lower_person_name) pairs
        let mut rejected_set: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();
        if let Ok(mut stmt) = conn.prepare("SELECT face_id, lower(person_name) FROM face_rejections") {
            if let Ok(rows) =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            {
                for pair in rows.flatten() {
                    rejected_set.insert(pair);
                }
            }
        }

        // 3. Query unassigned face metadata within the active folder (ZERO embedding blob reads!)
        struct UnassignedMeta {
            face_id: String,
            hash: String,
            face_thumb: String,
            photo_name: String,
            display_photo_path: String,
            bbox_x: f64,
            bbox_y: f64,
            bbox_w: f64,
            bbox_h: f64,
        }

        let mut unassigned_items: Vec<UnassignedMeta> = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT pf.face_id, pf.hash, pf.face_thumb, COALESCE(p.current_path, ''),
                            pf.bbox_x, pf.bbox_y, pf.bbox_w, pf.bbox_h
                     FROM photo_faces pf
                     JOIN photos p ON pf.hash = p.hash
                     WHERE (pf.person_name IS NULL OR pf.person_name = '')
                       AND p.current_path LIKE ?1 ESCAPE '!'",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![prefix], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, f64>(4)?,
                        r.get::<_, f64>(5)?,
                        r.get::<_, f64>(6)?,
                        r.get::<_, f64>(7)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for (face_id, hash, face_thumb, photo_path, bbox_x, bbox_y, bbox_w, bbox_h) in rows.flatten() {
                let (photo_name, display_photo_path) =
                    format_display_photo_path(photo_path, &hash, &previews_dir, &thumbs_dir);
                unassigned_items.push(UnassignedMeta {
                    face_id,
                    hash,
                    face_thumb,
                    photo_name,
                    display_photo_path,
                    bbox_x,
                    bbox_y,
                    bbox_w,
                    bbox_h,
                });
            }
        }

        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut new_pending_cache: HashMap<String, Vec<SimilarFaceCandidate>> = HashMap::new();

        if unassigned_items.is_empty() {
            replace_pending_for_folder(root_folder.as_deref(), HashMap::new());
            return Ok(counts);
        }

        let cache_guard = FACE_EMBEDDING_CACHE.lock().map_err(|e| e.to_string())?;

        // Load all assigned (hash, lower_person_name) pairs so a person is never matched to another face in a photo they are already in
        let mut assigned_people_set: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();
        if let Ok(mut stmt) = conn.prepare("SELECT hash, lower(person_name) FROM photo_people") {
            if let Ok(rows) =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            {
                for pair in rows.flatten() {
                    assigned_people_set.insert(pair);
                }
            }
        }

        for (pname, fids) in &person_ref_ids {
            let refs: Vec<Vec<f32>> = fids
                .iter()
                .filter_map(|id| cache_guard.get(id).cloned())
                .filter(|v| v.len() == 512)
                .collect();
            if refs.is_empty() {
                continue;
            }
            let lower_p = pname.to_lowercase();
            let c512 = compute_normalized_centroid(&refs, 512);
            let mut person_candidates: Vec<SimilarFaceCandidate> = Vec::new();

            for item in &unassigned_items {
                if rejected_set.contains(&(item.face_id.clone(), lower_p.clone())) {
                    continue;
                }
                if assigned_people_set.contains(&(item.hash.clone(), lower_p.clone())) {
                    continue;
                }
                let Some(cand_emb) = cache_guard.get(&item.face_id) else {
                    continue;
                };
                if cand_emb.len() != 512 {
                    continue;
                }
                // Same threshold as find_similar_faces, so the badge count and the modal always agree
                let sim = score_against_person_profile(cand_emb, &refs, c512.as_ref(), None);
                if sim >= FACE_MATCH_MIN_SIMILARITY {
                    person_candidates.push(SimilarFaceCandidate {
                        face_id: item.face_id.clone(),
                        hash: item.hash.clone(),
                        face_thumb: item.face_thumb.clone(),
                        photo_name: item.photo_name.clone(),
                        photo_path: item.display_photo_path.clone(),
                        bbox_x: item.bbox_x,
                        bbox_y: item.bbox_y,
                        bbox_w: item.bbox_w,
                        bbox_h: item.bbox_h,
                        current_person: None,
                        similarity: (sim * 1000.0).round() / 10.0,
                    });
                }
            }

            if !person_candidates.is_empty() {
                person_candidates.sort_by(|a, b| {
                    b.similarity
                        .partial_cmp(&a.similarity)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                person_candidates.truncate(120);
                counts.insert(pname.clone(), person_candidates.len());
                new_pending_cache.insert(pending_cache_key(pname, root_folder.as_deref()), person_candidates);
            }
        }
        drop(cache_guard);

        replace_pending_for_folder(root_folder.as_deref(), new_pending_cache);
        Ok(counts)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assign_faces_to_person_batch(
    app: AppHandle,
    face_ids: Vec<String>,
    person_name: String,
) -> Result<HashMap<String, Vec<FaceInstance>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = person_name.trim().to_string();
        if clean.is_empty() || face_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut conn = open_global_db(&app)?;
        let mut updated_hashes = Vec::new();
        let mut old_names_by_hash: Vec<(String, Option<String>)> = Vec::new();

        if let Ok(tx) = conn.transaction() {
            let _ = tx.execute(
                "INSERT OR IGNORE INTO people (name) VALUES (?1)",
                params![clean],
            );
            for fid in &face_ids {
                if let Ok((h, thumb, old_person)) = tx.query_row(
                    "SELECT hash, face_thumb, person_name FROM photo_faces WHERE face_id = ?1",
                    params![fid],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)),
                ) {
                    let _ = tx.execute(
                        "UPDATE photo_faces SET person_name = ?1 WHERE face_id = ?2",
                        params![clean, fid],
                    );
                    let _ = tx.execute(
                        "DELETE FROM face_rejections WHERE face_id = ?1 AND lower(person_name) = lower(?2)",
                        params![fid, clean],
                    );
                    let _ = tx.execute(
                        "INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)",
                        params![h, clean],
                    );
                    let _ = tx.execute(
                        "UPDATE people SET cover_face_thumb = ?1 WHERE name = ?2 AND (cover_face_thumb IS NULL OR cover_face_thumb = '')",
                        params![thumb, clean],
                    );
                    old_names_by_hash.push((h.clone(), old_person));
                    if !updated_hashes.contains(&h) {
                        updated_hashes.push(h);
                    }
                }
            }
            let _ = tx.commit();
        }

        if let Ok(mut g) = PENDING_CANDIDATES_CACHE.lock() {
            let id_set: std::collections::HashSet<&String> = face_ids.iter().collect();
            for list in g.values_mut() {
                list.retain(|c| !id_set.contains(&c.face_id));
            }
        }
        let mut updated_faces_map: HashMap<String, Vec<FaceInstance>> = HashMap::new();
        for (h, old_p) in old_names_by_hash {
            sync_photo_people_from_faces(&conn, &h, old_p.as_deref());
            updated_faces_map.insert(h.clone(), get_faces_for_hash(&conn, &h));
        }
        Ok(updated_faces_map)
    })
    .await
    .map_err(|e| e.to_string())?
}
