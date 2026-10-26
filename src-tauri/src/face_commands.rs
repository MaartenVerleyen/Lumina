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
                                    "INSERT INTO photo_faces (face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, person_name, face_thumb, embedding, embedding_blob, engine, confidence, source)
                                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '[]', ?9, ?11, ?10, 'scrfd')
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
                                        source = 'scrfd'",
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
                                        FACE_ENGINE_V2
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
    let models = face_models_v2(&app).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let clean_name = person_name.trim().to_string();
        if clean_name.is_empty() {
            return Err("Person name cannot be empty".into());
        }

        let img = open_and_orient_image(Path::new(&image_path))
            .map_err(|e| format!("Failed to open image: {e}"))?;
        let conn = open_global_db(&app)?;

        // The landmarks for alignment come from running the detector inside the box
        let bbox = (bbox_x, bbox_y, bbox_w, bbox_h);
        let embedding = models.embed_region(&img, bbox)?;
        let _saved_face = record_face_v2(&app, &conn, &hash, &img, bbox, embedding, 1.0, Some(clean_name.clone()), "user")
            .ok_or("Failed to save the face")?;

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
                        MIN(pp.hash) as fallback_hash, COALESCE(p.hidden, 0)
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
                    hidden: row.get::<_, i32>(5)? != 0,
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

// Removes a photo-level person tag from many photos (undo of a batch person assignment). Named face boxes are
// left alone: the batch assignment never names faces.
#[tauri::command]
pub fn remove_person_from_photos(app: AppHandle, hashes: Vec<String>, name: String) -> Result<(), String> {
    let mut conn = open_global_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("DELETE FROM photo_people WHERE hash = ?1 AND person_name = ?2")
            .map_err(|e| e.to_string())?;
        for h in &hashes {
            stmt.execute(params![h, name]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
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

// All pending face suggestions for a folder, keyed by person name. Every unnamed face (engine v2) is
// suggested to at most one person: its best match, only if that clears FACE_MATCH_MIN_SIMILARITY, beats the
// runner-up by FACE_ASSIGN_MARGIN, and doesn't look more like a face the user rejected for that person.
// A person is suggested at most once per photo (the best-scoring face), and never on a photo they are
// already confirmed in. The badge counts and the review modal both come from this, so they always agree.
pub fn compute_face_suggestions(
    app: &AppHandle,
    conn: &Connection,
    root_folder: Option<&str>,
) -> Result<HashMap<String, Vec<SimilarFaceCandidate>>, String> {
    ensure_embedding_cache_loaded(conn);
    let prefix = make_folder_prefix(root_folder);
    let thumbs_dir = get_app_storage_dir(app).join("thumbnails");
    let previews_dir = get_app_storage_dir(app).join("previews");

    let hidden: HashSet<String> = conn
        .prepare("SELECT lower(name) FROM people WHERE COALESCE(hidden, 0) = 1")
        .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()))
        .unwrap_or_default();

    // Confirmed faces per person (case-insensitive; the first spelling seen is displayed)
    let mut person_names: Vec<String> = Vec::new();
    let mut person_index: HashMap<String, usize> = HashMap::new();
    let mut person_ref_ids: Vec<Vec<String>> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT face_id, person_name FROM photo_faces
                 WHERE person_name IS NOT NULL AND person_name != '' AND engine = ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![FACE_ENGINE_V2], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for (fid, name) in rows.flatten() {
            let key = name.trim().to_lowercase();
            if hidden.contains(&key) {
                continue;
            }
            let idx = *person_index.entry(key).or_insert_with(|| {
                person_names.push(name.trim().to_string());
                person_ref_ids.push(Vec::new());
                person_names.len() - 1
            });
            person_ref_ids[idx].push(fid);
        }
    }
    if person_names.is_empty() {
        return Ok(HashMap::new());
    }

    // Rejections: excluded pairs, and the rejected faces' embeddings as negatives per person
    let mut rejected_pairs: std::collections::HashSet<(String, usize)> = std::collections::HashSet::new();
    let mut negative_ids: Vec<Vec<String>> = vec![Vec::new(); person_names.len()];
    if let Ok(mut stmt) = conn.prepare("SELECT face_id, lower(person_name) FROM face_rejections") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for (fid, lower) in rows.flatten() {
                if let Some(&idx) = person_index.get(lower.trim()) {
                    negative_ids[idx].push(fid.clone());
                    rejected_pairs.insert((fid, idx));
                }
            }
        }
    }

    // People already confirmed on each photo
    let mut assigned: std::collections::HashSet<(String, usize)> = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash, lower(person_name) FROM photo_people") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for (hash, lower) in rows.flatten() {
                if let Some(&idx) = person_index.get(lower.trim()) {
                    assigned.insert((hash, idx));
                }
            }
        }
    }

    // Unnamed faces of this engine in the folder
    struct Unassigned {
        face_id: String,
        hash: String,
        face_thumb: String,
        photo_path: String,
        bbox: (f64, f64, f64, f64),
    }
    let unassigned: Vec<Unassigned>;
    {
        let mut stmt = conn
            .prepare(
                "SELECT pf.face_id, pf.hash, pf.face_thumb, COALESCE(p.current_path, ''),
                        pf.bbox_x, pf.bbox_y, pf.bbox_w, pf.bbox_h
                 FROM photo_faces pf JOIN photos p ON pf.hash = p.hash
                 WHERE (pf.person_name IS NULL OR pf.person_name = '') AND pf.engine = ?1
                   AND p.current_path LIKE ?2 ESCAPE '!'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![FACE_ENGINE_V2, prefix], |r| {
                Ok(Unassigned {
                    face_id: r.get(0)?,
                    hash: r.get(1)?,
                    face_thumb: r.get(2)?,
                    photo_path: r.get(3)?,
                    bbox: (r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?),
                })
            })
            .map_err(|e| e.to_string())?;
        unassigned = rows.flatten().collect();
    }
    if unassigned.is_empty() {
        return Ok(HashMap::new());
    }

    // Copy what we need out of the shared cache, then score without holding its lock
    let (profiles, candidates): (Vec<Option<PersonProfile>>, Vec<Option<Vec<f32>>>) = {
        let cache = FACE_EMBEDDING_CACHE.lock().map_err(|e| e.to_string())?;
        let get = |ids: &[String]| -> Vec<Vec<f32>> { ids.iter().filter_map(|id| cache.get(id).cloned()).collect() };
        let profiles = person_names
            .iter()
            .enumerate()
            .map(|(i, _)| build_profile(get(&person_ref_ids[i]), get(&negative_ids[i])))
            .collect();
        let candidates = unassigned.iter().map(|u| cache.get(&u.face_id).cloned()).collect();
        (profiles, candidates)
    };
    // Keep the index mapping: assign_face returns an index into the profiles that exist
    let usable: Vec<(usize, PersonProfile)> = profiles
        .into_iter()
        .enumerate()
        .filter_map(|(i, p)| p.map(|p| (i, p)))
        .collect();
    let (person_of_profile, profile_list): (Vec<usize>, Vec<PersonProfile>) = usable.into_iter().unzip();
    if profile_list.is_empty() {
        return Ok(HashMap::new());
    }

    let assignments: Vec<Option<(usize, f32)>> = candidates
        .par_iter()
        .map(|emb| {
            let emb = emb.as_ref()?;
            let a = assign_face(emb, &profile_list, SCORE_METHOD, FACE_MATCH_MIN_SIMILARITY, FACE_ASSIGN_MARGIN)?;
            Some((person_of_profile[a.person], a.score))
        })
        .collect();

    // At most one suggestion per (photo, person): the best-scoring face
    let mut best_per_photo: HashMap<(String, usize), (usize, f32)> = HashMap::new();
    for (i, assignment) in assignments.iter().enumerate() {
        let Some((person, score)) = *assignment else { continue };
        let u = &unassigned[i];
        if rejected_pairs.contains(&(u.face_id.clone(), person)) || assigned.contains(&(u.hash.clone(), person)) {
            continue;
        }
        let key = (u.hash.clone(), person);
        if best_per_photo.get(&key).map(|&(_, s)| score > s).unwrap_or(true) {
            best_per_photo.insert(key, (i, score));
        }
    }

    let mut out: HashMap<String, Vec<SimilarFaceCandidate>> = HashMap::new();
    for ((_, person), (i, score)) in best_per_photo {
        let u = &unassigned[i];
        let (photo_name, display_photo_path) =
            format_display_photo_path(u.photo_path.clone(), &u.hash, &previews_dir, &thumbs_dir);
        out.entry(person_names[person].clone()).or_default().push(SimilarFaceCandidate {
            face_id: u.face_id.clone(),
            hash: u.hash.clone(),
            face_thumb: u.face_thumb.clone(),
            photo_name,
            photo_path: display_photo_path,
            bbox_x: u.bbox.0,
            bbox_y: u.bbox.1,
            bbox_w: u.bbox.2,
            bbox_h: u.bbox.3,
            current_person: None,
            similarity: (score * 1000.0).round() / 10.0,
        });
    }
    for list in out.values_mut() {
        list.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal));
        list.truncate(MAX_SUGGESTIONS_PER_PERSON);
    }
    Ok(out)
}

// Recomputes the folder's suggestions and stores them in the pending cache (keyed per person + folder)
fn refresh_suggestion_cache(
    app: &AppHandle,
    conn: &Connection,
    root_folder: Option<&str>,
) -> Result<HashMap<String, Vec<SimilarFaceCandidate>>, String> {
    let suggestions = compute_face_suggestions(app, conn, root_folder)?;
    let keyed: HashMap<String, Vec<SimilarFaceCandidate>> = suggestions
        .iter()
        .map(|(name, list)| (pending_cache_key(name, root_folder), list.clone()))
        .collect();
    replace_pending_for_folder(root_folder, keyed);
    Ok(suggestions)
}

#[tauri::command]
pub async fn find_similar_faces(
    app: AppHandle,
    person_name: String,
    root_folder: Option<String>,
    force_refresh: Option<bool>,
) -> Result<Vec<SimilarFaceCandidate>, String> {
    let clean_name = person_name.trim().to_string();
    let cache_key = pending_cache_key(&clean_name, root_folder.as_deref());

    // Fast path: the badge computation already cached this folder's suggestions
    if !force_refresh.unwrap_or(false) {
        if let Ok(guard) = PENDING_CANDIDATES_CACHE.lock() {
            if let Some(cached) = guard.get(&cache_key) {
                return Ok(cached.clone());
            }
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let suggestions = refresh_suggestion_cache(&app, &conn, root_folder.as_deref())?;
        Ok(suggestions
            .into_iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(&clean_name))
            .map(|(_, list)| list)
            .unwrap_or_default())
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
        let suggestions = refresh_suggestion_cache(&app, &conn, root_folder.as_deref())?;
        Ok(suggestions.into_iter().map(|(name, list)| (name, list.len())).collect())
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

// ----------------- "WHO IS THIS?": CLUSTERS OF UNKNOWN FACES -----------------

#[derive(Serialize, Clone)]
pub struct FaceCluster {
    pub size: usize,
    // Every face in the cluster (naming the cluster assigns all of them)
    pub face_ids: Vec<String>,
    // Up to 12 faces closest to the cluster's centre, for display
    pub samples: Vec<SimilarFaceCandidate>,
}

const MAX_FACES_TO_CLUSTER: usize = 20_000;
const MAX_CLUSTERS: usize = 200;
// Detections below this confidence are often partial or blurry faces: they would only add noise
const MIN_CLUSTER_FACE_CONFIDENCE: f64 = 0.6;

// Groups the folder's unnamed faces that aren't already suggested for someone, largest group first
#[tauri::command]
pub async fn get_unknown_face_clusters(app: AppHandle, root_folder: Option<String>) -> Result<Vec<FaceCluster>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let suggestions = refresh_suggestion_cache(&app, &conn, root_folder.as_deref())?;
        let suggested: std::collections::HashSet<String> =
            suggestions.values().flatten().map(|c| c.face_id.clone()).collect();
        let prefix = make_folder_prefix(root_folder.as_deref());
        let thumbs_dir = get_app_storage_dir(&app).join("thumbnails");
        let previews_dir = get_app_storage_dir(&app).join("previews");

        let mut stmt = conn
            .prepare(
                "SELECT pf.face_id, pf.hash, pf.face_thumb, COALESCE(p.current_path, ''),
                        pf.bbox_x, pf.bbox_y, pf.bbox_w, pf.bbox_h
                 FROM photo_faces pf JOIN photos p ON pf.hash = p.hash
                 WHERE (pf.person_name IS NULL OR pf.person_name = '') AND pf.engine = ?1
                   AND COALESCE(pf.confidence, 0) >= ?2 AND p.current_path LIKE ?3 ESCAPE '!'
                 ORDER BY pf.confidence DESC
                 LIMIT ?4",
            )
            .map_err(|e| e.to_string())?;
        let faces: Vec<SimilarFaceCandidate> = stmt
            .query_map(
                params![FACE_ENGINE_V2, MIN_CLUSTER_FACE_CONFIDENCE, prefix, MAX_FACES_TO_CLUSTER as i64],
                |r| {
                    let hash: String = r.get(1)?;
                    let (photo_name, photo_path) =
                        format_display_photo_path(r.get(3)?, &hash, &previews_dir, &thumbs_dir);
                    Ok(SimilarFaceCandidate {
                        face_id: r.get(0)?,
                        hash,
                        face_thumb: r.get(2)?,
                        photo_name,
                        photo_path,
                        bbox_x: r.get(4)?,
                        bbox_y: r.get(5)?,
                        bbox_w: r.get(6)?,
                        bbox_h: r.get(7)?,
                        current_person: None,
                        similarity: 0.0,
                    })
                },
            )
            .map_err(|e| e.to_string())?
            .flatten()
            .filter(|f| !suggested.contains(&f.face_id))
            .collect();

        let (faces, embeddings): (Vec<SimilarFaceCandidate>, Vec<Vec<f32>>) = {
            let cache = FACE_EMBEDDING_CACHE.lock().map_err(|e| e.to_string())?;
            faces
                .into_iter()
                .filter_map(|f| cache.get(&f.face_id).cloned().map(|e| (f, e)))
                .unzip()
        };

        let labels = cluster_faces(&embeddings, CLUSTER_SIMILARITY, 20);
        let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
        for (i, label) in labels.iter().enumerate() {
            groups.entry(*label).or_default().push(i);
        }
        let mut clusters: Vec<FaceCluster> = groups
            .into_values()
            .filter(|members| members.len() >= 2)
            .map(|members| {
                let member_embs: Vec<Vec<f32>> = members.iter().map(|&i| embeddings[i].clone()).collect();
                let centre = compute_normalized_centroid(&member_embs, 512).unwrap_or_default();
                let mut ranked: Vec<(usize, f32)> = members.iter().map(|&i| (i, dot(&embeddings[i], &centre))).collect();
                ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                FaceCluster {
                    size: members.len(),
                    face_ids: members.iter().map(|&i| faces[i].face_id.clone()).collect(),
                    samples: ranked
                        .iter()
                        .take(12)
                        .map(|&(i, sim)| SimilarFaceCandidate { similarity: (sim * 1000.0).round() / 10.0, ..faces[i].clone() })
                        .collect(),
                }
            })
            .collect();
        clusters.sort_by(|a, b| b.size.cmp(&a.size));
        clusters.truncate(MAX_CLUSTERS);
        Ok(clusters)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- PEOPLE: RENAME / MERGE / HIDE -----------------

// Renames a person everywhere (photo tags, named faces, rejections, the people list). When another person
// already has the new name, the two are merged into that one. Returns the final name.
#[tauri::command]
pub async fn rename_person(app: AppHandle, old_name: String, new_name: String) -> Result<String, String> {
    let old = old_name.trim().to_string();
    let new = new_name.trim().to_string();
    if old.is_empty() || new.is_empty() {
        return Err("The name can't be empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_global_db(&app)?;
        rename_person_in_db(&mut conn, &old, &new)?;
        // Suggestions are keyed by name: recompute them on next use
        if let Ok(mut cache) = PENDING_CANDIDATES_CACHE.lock() {
            cache.clear();
        }
        Ok(new)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn rename_person_in_db(conn: &mut Connection, old: &str, new: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // Another person (not just a different capitalisation of this one) already has the new name: merge
    let target_exists: bool = !old.eq_ignore_ascii_case(new)
        && tx
            .query_row("SELECT COUNT(*) FROM people WHERE lower(name) = lower(?1)", params![new], |r| r.get::<_, i64>(0))
            .unwrap_or(0)
            > 0;

    tx.execute(
        "UPDATE photo_faces SET person_name = ?2 WHERE lower(person_name) = lower(?1)",
        params![old, new],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO photo_people (hash, person_name)
         SELECT hash, ?2 FROM photo_people WHERE lower(person_name) = lower(?1)",
        params![old, new],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM photo_people WHERE lower(person_name) = lower(?1) AND person_name != ?2",
        params![old, new],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO face_rejections (face_id, person_name)
         SELECT face_id, ?2 FROM face_rejections WHERE lower(person_name) = lower(?1)",
        params![old, new],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM face_rejections WHERE lower(person_name) = lower(?1) AND person_name != ?2",
        params![old, new],
    )
    .map_err(|e| e.to_string())?;

    if target_exists {
        // Keep the target's cover unless it has none
        tx.execute(
            "UPDATE people SET cover_face_thumb = (SELECT cover_face_thumb FROM people WHERE lower(name) = lower(?1))
             WHERE lower(name) = lower(?2) AND COALESCE(cover_face_thumb, '') = ''",
            params![old, new],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM people WHERE lower(name) = lower(?1)", params![old]).map_err(|e| e.to_string())?;
    } else {
        tx.execute("UPDATE people SET name = ?2 WHERE lower(name) = lower(?1)", params![old, new])
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO people (name) VALUES (?1)", params![new]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

// Hidden people stay tagged on their photos but leave the people bar and get no new suggestions
#[tauri::command]
pub fn set_person_hidden(app: AppHandle, name: String, hidden: bool) -> Result<(), String> {
    let conn = open_global_db(&app)?;
    conn.execute(
        "UPDATE people SET hidden = ?2 WHERE lower(name) = lower(?1)",
        params![name.trim(), hidden as i32],
    )
    .map_err(|e| e.to_string())?;
    if let Ok(mut cache) = PENDING_CANDIDATES_CACHE.lock() {
        cache.clear();
    }
    Ok(())
}
