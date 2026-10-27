use crate::*;

// Face detection: one photo on demand, and the background face scan over a library (detect, align, embed)

// ----------------- INTERACTIVE FACE SELECTION & PRECISION AUTO-MATCHER -----------------

#[tauri::command]
pub async fn detect_faces_in_photo(
    app: AppHandle,
    hash: String,
    image_path: String,
    force_onnx: Option<bool>,
) -> Result<Vec<FaceInstance>, String> {
    let run_neural = force_onnx.unwrap_or(false);
    let models = if run_neural { Some(face_models_v2(&app).await?) } else { loaded_face_models_v2() };

    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let existing = get_faces_for_hash(&conn, &hash);
        if !run_neural && !existing.is_empty() {
            return Ok(existing);
        }
        let Some(models) = models else {
            return Ok(existing);
        };

        if let Ok(img) = open_and_orient_image(Path::new(&image_path)) {
            let faces = models.analyze(&img)?;
            let old_rejected = rejected_unnamed_faces(&conn, &hash);
            // Clear any old un-named boxes on this photo before inserting the fresh detections
            let _ = conn.execute(
                "DELETE FROM photo_faces WHERE hash = ?1 AND (person_name IS NULL OR person_name = '')",
                params![hash],
            );
            for face in faces.into_iter().filter(|f| is_usable_face(&img, f.detection.bbox)) {
                let _ = record_face_v2(
                    &app,
                    &conn,
                    &hash,
                    &img,
                    face.detection.bbox,
                    face.embedding,
                    face.detection.score as f64,
                    None,
                    "scrfd",
                    face.quality,
                );
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
    pub embedding: Vec<f32>,
}

// Faces narrower than this (in the decoded ~1920px image) are too small to recognise reliably
const MIN_FACE_PX: f64 = 20.0;

pub fn is_usable_face(img: &DynamicImage, bbox: (f64, f64, f64, f64)) -> bool {
    bbox.2 * img.width() as f64 >= MIN_FACE_PX
}

#[tauri::command]
pub async fn scan_library_faces_batch(
    app: AppHandle,
    hashes: Vec<String>,
) -> Result<usize, String> {
    // Downloads (first time only) and loads engine v2 before the background thread starts
    let models = face_models_v2(&app).await?;

    let total_hashes = hashes.len();
    let app_clone = app.clone();
    FACE_SCAN_CANCEL.store(false, Ordering::Release);
    std::thread::spawn(move || {
        let outcome = run_face_scan(&app_clone, hashes, models);
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

fn run_face_scan(app_clone: &AppHandle, hashes: Vec<String>, models: Arc<FaceModels>) -> FaceScanOutcome {
    {
        let face_scan_started = Instant::now();
        let Ok(mut conn) = open_global_db(app_clone) else {
            return FaceScanOutcome::default();
        };

        // Named faces still embedded by the old engine: if the new detector doesn't find them again, they are
        // re-embedded from their stored box so no confirmed name is left on an incomparable embedding
        let mut named_outdated: HashMap<String, Vec<(String, (f64, f64, f64, f64))>> = HashMap::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h FROM photo_faces
             WHERE person_name IS NOT NULL AND person_name != '' AND COALESCE(engine, '') != ?1",
        ) {
            let wanted: std::collections::HashSet<&String> = hashes.iter().collect();
            if let Ok(rows) = stmt.query_map(params![FACE_ENGINE_V2], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, (r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            }) {
                for (fid, h, bbox) in rows.flatten() {
                    if wanted.contains(&h) {
                        named_outdated.entry(h).or_default().push((fid, bbox));
                    }
                }
            }
        }

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
                let chunk_results: Vec<(String, Vec<PendingFaceWrite>, Vec<(String, Vec<f32>)>)> = chunk
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
                        let faces: Vec<FaceV2> = models
                            .analyze(&img)
                            .ok()?
                            .into_iter()
                            .filter(|f| is_usable_face(&img, f.detection.bbox))
                            .collect();

                        // Old-engine named faces that no new detection covers: re-embed them from their box
                        let reembeds: Vec<(String, Vec<f32>)> = named_outdated
                            .get(h)
                            .map(|named| {
                                named
                                    .iter()
                                    .filter(|(_, bbox)| faces.iter().all(|f| bbox_iou(*bbox, f.detection.bbox) < 0.3))
                                    .filter_map(|(fid, bbox)| models.embed_region(&img, *bbox).ok().map(|e| (fid.clone(), e)))
                                    .collect()
                            })
                            .unwrap_or_default();

                        let mut writes = Vec::with_capacity(faces.len());
                        for face in faces {
                            let (bx, by, bw, bh) = face.detection.bbox;
                            let face_id = format!(
                                "{}_{}_{}",
                                h,
                                (bx * 100.0).round() as i32,
                                (by * 100.0).round() as i32
                            );
                            let face_thumb_path = faces_dir.join(format!("{}.jpg", face_id));
                            let _ = face_thumbnail(&img, face.detection.bbox).save(&face_thumb_path);
                            writes.push(PendingFaceWrite {
                                face: FaceInstance {
                                    face_id,
                                    hash: h.clone(),
                                    bbox_x: bx,
                                    bbox_y: by,
                                    bbox_w: bw,
                                    bbox_h: bh,
                                    person_name: None,
                                    face_thumb: face_thumb_path.to_string_lossy().to_string(),
                                    confidence: face.detection.score as f64,
                                    eyes_open: face.quality.eyes_open.map(f64::from),
                                    face_sharpness: face.quality.sharpness.map(f64::from),
                                },
                                embedding: face.embedding,
                            });
                        }

                        Some((h.clone(), writes, reembeds))
                    })
                    .collect();

                completed_count += chunk.len();
                let mut batch_faces: HashMap<String, Vec<FaceInstance>> = HashMap::new();
                let mut batch_people: HashMap<String, Vec<String>> = HashMap::new();

                if !chunk_results.is_empty() {
                    if let Ok(tx) = conn.transaction() {
                        for (h, writes, reembeds) in &chunk_results {
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

                                if let Ok(mut guard) = FACE_EMBEDDING_CACHE.lock() {
                                    guard.insert(target_face_id.clone(), item.embedding.clone());
                                }
                                let target_thumb_str = if target_face_id != f.face_id {
                                    let existing_thumb = faces_dir.join(format!("{}.jpg", target_face_id));
                                    let _ = fs::copy(&f.face_thumb, &existing_thumb);
                                    existing_thumb.to_string_lossy().to_string()
                                } else {
                                    f.face_thumb.clone()
                                };

                                let _ = tx.execute(
                                    "INSERT INTO photo_faces (face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, person_name, face_thumb, embedding, embedding_blob, engine, confidence, source, eyes_open, face_sharpness)
                                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '[]', ?9, ?11, ?10, 'scrfd', ?12, ?13)
                                    ON CONFLICT(face_id) DO UPDATE SET
                                        bbox_x = excluded.bbox_x,
                                        bbox_y = excluded.bbox_y,
                                        bbox_w = excluded.bbox_w,
                                        bbox_h = excluded.bbox_h,
                                        person_name = COALESCE(photo_faces.person_name, excluded.person_name),
                                        face_thumb = excluded.face_thumb,
                                        embedding = '[]',
                                        embedding_blob = excluded.embedding_blob,
                                        engine = excluded.engine,
                                        confidence = excluded.confidence,
                                        source = 'scrfd',
                                        eyes_open = excluded.eyes_open,
                                        face_sharpness = excluded.face_sharpness",
                                    params![
                                        target_face_id,
                                        f.hash,
                                        f.bbox_x,
                                        f.bbox_y,
                                        f.bbox_w,
                                        f.bbox_h,
                                        target_person,
                                        target_thumb_str,
                                        embedding_to_blob(&item.embedding),
                                        f.confidence,
                                        FACE_ENGINE_V2,
                                        f.eyes_open,
                                        f.face_sharpness
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
                            for (fid, embedding) in reembeds {
                                let _ = tx.execute(
                                    "UPDATE photo_faces SET embedding = '[]', embedding_blob = ?1, engine = ?2 WHERE face_id = ?3",
                                    params![embedding_to_blob(embedding), FACE_ENGINE_V2, fid],
                                );
                                if let Ok(mut guard) = FACE_EMBEDDING_CACHE.lock() {
                                    guard.insert(fid.clone(), embedding.clone());
                                }
                            }
                        }
                        let _ = tx.commit();
                    }

                    for (h, _, _) in &chunk_results {
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
            if cancelled { "Face scan (cancelled)" } else { "Face scan (SCRFD + aligned ArcFace)" },
            face_scan_started,
            completed_count,
            format!(
                "{} photos/s · {} decode threads · models on {} · {} faces found",
                per_second(completed_count, total_ms),
                num_threads,
                models.device,
                faces_found
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

// Photos in the folder that still have faces from an older face engine (they need re-detecting so their
// faces can be matched again). Used to start the automatic upgrade scan when a folder is opened.
#[tauri::command]
pub async fn get_outdated_face_photos(app: AppHandle, root_folder: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let prefix = make_folder_prefix(root_folder.as_deref());
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT pf.hash FROM photo_faces pf JOIN photos p ON p.hash = pf.hash
                 WHERE COALESCE(pf.engine, '') != ?1 AND p.current_path LIKE ?2 ESCAPE '!'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![FACE_ENGINE_V2, prefix], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(rows.flatten().collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
