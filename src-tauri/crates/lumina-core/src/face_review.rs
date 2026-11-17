use std::sync::Mutex;
use crate::*;

// Naming faces and reviewing suggestions: assign a face box, match suggestions, accept / reject, "Who is this?" clusters

pub async fn assign_face_region_and_automatch(app: SharedHost, hash: String, image_path: String, bbox_x: f64, bbox_y: f64, bbox_w: f64, bbox_h: f64, person_name: String) -> Result<Vec<FaceInstance>, String> {
    let models = face_models_v2(&app).await?;
    tokio::task::spawn_blocking(move || {
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
        let _saved_face = record_face_v2(&app, &conn, &hash, &img, bbox, embedding, 1.0, Some(clean_name.clone()), "user", FaceQuality::default())
            .ok_or("Failed to save the face")?;

        // Emit completion event without silently mutating other photos behind the user's back;
        // pending matches will surface via +N? badges for explicit confirmation in the Review Studio!
        let _ = emit_to(&app, 
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

pub fn remove_face_box(app: SharedHost, face_id: String, hash: String) -> Result<Vec<FaceInstance>, String> {
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

pub fn format_display_photo_path(
    face_id: &str,
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
    let video_frame = video_frames::frame_of_face(face_id)
        .filter(|_| video_meta::is_video_ext(&ext))
        .map(|n| video_frames::frame_path(&previews_dir.with_file_name("frames"), hash, n));
    let display_photo_path = if let Some(frame) = video_frame {
        frame.to_string_lossy().to_string()
    } else if is_raw_or_heic_ext(&ext) {
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
// Each person's list is cut to the best MAX_SUGGESTIONS_PER_PERSON (the batch a review shows)
pub fn compute_face_suggestions(
    app: &dyn Host,
    conn: &Connection,
    root_folder: Option<&str>,
) -> Result<HashMap<String, Vec<SimilarFaceCandidate>>, String> {
    let mut out = every_face_suggestion(app, conn, root_folder)?;
    for list in out.values_mut() {
        list.truncate(MAX_SUGGESTIONS_PER_PERSON);
    }
    Ok(out)
}

// The same, every suggestion: "Who is this?" leaves out every face that is someone's suggestion, also past the
// first batch (a person with 2,000 likely faces had 1,700 of them grouped as unknown)
fn every_face_suggestion(app: &dyn Host, conn: &Connection, root_folder: Option<&str>) -> Result<HashMap<String, Vec<SimilarFaceCandidate>>, String> {
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
        let ignored = ignored_face_ids(conn);
        unassigned = rows.flatten().filter(|u: &Unassigned| !ignored.contains(&u.face_id)).collect();
    }
    if unassigned.is_empty() {
        return Ok(HashMap::new());
    }

    // Copy what we need out of the shared cache, then score without holding its lock
    let (profiles, candidates): (Vec<Option<Arc<PersonProfile>>>, Vec<Option<Vec<f32>>>) = {
        let cache = FACE_EMBEDDING_CACHE.lock().map_err(|e| e.to_string())?;
        let get = |ids: &[String]| -> Vec<Vec<f32>> { ids.iter().filter_map(|id| cache.get(id).cloned()).collect() };
        let profiles = person_names
            .iter()
            .enumerate()
            .map(|(i, name)| kept_profile(&name.to_lowercase(), &person_ref_ids[i], &negative_ids[i], get))
            .collect();
        let candidates = unassigned.iter().map(|u| cache.get(&u.face_id).cloned()).collect();
        (profiles, candidates)
    };
    // Keep the index mapping: assign_face returns an index into the profiles that exist
    let usable: Vec<(usize, Arc<PersonProfile>)> = profiles
        .into_iter()
        .enumerate()
        .filter_map(|(i, p)| p.map(|p| (i, p)))
        .collect();
    let (person_of_profile, profile_list): (Vec<usize>, Vec<Arc<PersonProfile>>) = usable.into_iter().unzip();
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
            format_display_photo_path(&u.face_id, u.photo_path.clone(), &u.hash, &previews_dir, &thumbs_dir);
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
    }
    Ok(out)
}

// Recomputes the folder's suggestions and stores them in the pending cache (keyed per person + folder)
// One computation at a time: a window asks again whenever its list changes, and on a large library each ask is
// seconds of every core. Who asks while one runs waits for it and takes a result that started after they asked
// (so it holds every change made before), instead of starting their own.
static SUGGESTIONS_TURN: Mutex<()> = Mutex::new(());
type Suggestions = HashMap<String, Vec<SimilarFaceCandidate>>;
// The folder, when the computation started, each person's first batch, and every face suggested for anyone
type LastSuggestions = (Option<String>, std::time::Instant, Suggestions, Arc<HashSet<String>>);
static LAST_SUGGESTIONS: Mutex<Option<LastSuggestions>> = Mutex::new(None);

fn refresh_suggestion_cache(
    app: &dyn Host,
    conn: &Connection,
    root_folder: Option<&str>,
) -> Result<HashMap<String, Vec<SimilarFaceCandidate>>, String> {
    refresh_suggestions(app, conn, root_folder).map(|(suggestions, _)| suggestions)
}

fn refresh_suggestions(app: &dyn Host, conn: &Connection, root_folder: Option<&str>) -> Result<(Suggestions, Arc<HashSet<String>>), String> {
    let asked = std::time::Instant::now();
    let _turn = SUGGESTIONS_TURN.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((root, started, list, all)) = LAST_SUGGESTIONS.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if *started >= asked && root.as_deref() == root_folder {
            return Ok((list.clone(), all.clone()));
        }
    }
    let started = std::time::Instant::now();
    let mut suggestions = every_face_suggestion(app, conn, root_folder)?;
    let all: Arc<HashSet<String>> = Arc::new(suggestions.values().flatten().map(|c| c.face_id.clone()).collect());
    for list in suggestions.values_mut() {
        list.truncate(MAX_SUGGESTIONS_PER_PERSON);
    }
    *LAST_SUGGESTIONS.lock().unwrap_or_else(|e| e.into_inner()) = Some((root_folder.map(str::to_string), started, suggestions.clone(), all.clone()));
    let keyed: HashMap<String, Vec<SimilarFaceCandidate>> = suggestions
        .iter()
        .map(|(name, list)| (pending_cache_key(name, root_folder), list.clone()))
        .collect();
    replace_pending_for_folder(root_folder, keyed);
    Ok((suggestions, all))
}

pub async fn find_similar_faces(app: SharedHost, person_name: String, root_folder: Option<String>, force_refresh: Option<bool>) -> Result<Vec<SimilarFaceCandidate>, String> {
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

    tokio::task::spawn_blocking(move || {
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

pub async fn get_confirmed_faces_for_person(app: SharedHost, person_name: String) -> Result<Vec<SimilarFaceCandidate>, String> {
    tokio::task::spawn_blocking(move || {
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
                format_display_photo_path(&face_id, photo_path, &hash, &previews_dir, &thumbs_dir);
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

pub async fn get_rejected_faces_for_person(app: SharedHost, person_name: String) -> Result<Vec<SimilarFaceCandidate>, String> {
    tokio::task::spawn_blocking(move || {
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
                format_display_photo_path(&face_id, photo_path, &hash, &previews_dir, &thumbs_dir);
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

pub async fn reject_face_candidates_batch(app: SharedHost, face_ids: Vec<String>, person_name: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
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

// "Ignore" (a stranger, a face on a poster): a rejection for this reserved name, which no person can have.
// Being a rejection, it survives a rescan like the others (face_scan::carry_over_rejections).
pub const IGNORED_FACE: &str = "\u{1}ignored";

pub fn ignored_face_ids(conn: &Connection) -> HashSet<String> {
    conn.prepare("SELECT face_id FROM face_rejections WHERE person_name = ?1")
        .and_then(|mut s| s.query_map(params![IGNORED_FACE], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()))
        .unwrap_or_default()
}

// Ignored faces are left out of "Who is this?" and of every person's suggestions; `ignore: false` undoes it
pub async fn ignore_faces(app: SharedHost, face_ids: Vec<String>, ignore: bool) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_global_db(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for fid in &face_ids {
            let sql = if ignore {
                "INSERT OR IGNORE INTO face_rejections (face_id, person_name) VALUES (?1, ?2)"
            } else {
                "DELETE FROM face_rejections WHERE face_id = ?1 AND person_name = ?2"
            };
            tx.execute(sql, params![fid, IGNORED_FACE]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        if let Ok(mut g) = PENDING_CANDIDATES_CACHE.lock() {
            if ignore {
                let id_set: HashSet<&String> = face_ids.iter().collect();
                for list in g.values_mut() {
                    list.retain(|c| !id_set.contains(&c.face_id));
                }
            } else {
                // Restored faces may be someone's suggestion again
                g.clear();
            }
        }
        Ok(face_ids.len())
    })
    .await
    .map_err(|e| e.to_string())?
}

// The faces set aside ("Not someone I know"), the last set aside first, so they can be looked at and taken back
// (ignore_faces with ignore: false)
const MAX_SET_ASIDE_SHOWN: i64 = 5_000;

pub async fn get_ignored_faces(app: SharedHost, root_folder: Option<String>) -> Result<Vec<SimilarFaceCandidate>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let prefix = make_folder_prefix(root_folder.as_deref());
        let thumbs_dir = get_app_storage_dir(&app).join("thumbnails");
        let previews_dir = get_app_storage_dir(&app).join("previews");
        let mut stmt = conn
            .prepare(
                "SELECT pf.face_id, pf.hash, pf.face_thumb, COALESCE(p.current_path, ''),
                        pf.bbox_x, pf.bbox_y, pf.bbox_w, pf.bbox_h
                 FROM face_rejections fr
                 JOIN photo_faces pf ON pf.face_id = fr.face_id
                 JOIN photos p ON p.hash = pf.hash
                 WHERE fr.person_name = ?1 AND p.current_path LIKE ?2 ESCAPE '!'
                 ORDER BY fr.rowid DESC
                 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let faces = stmt
            .query_map(params![IGNORED_FACE, prefix, MAX_SET_ASIDE_SHOWN], |r| {
                let face_id: String = r.get(0)?;
                let hash: String = r.get(1)?;
                let (photo_name, photo_path) = format_display_photo_path(&face_id, r.get(3)?, &hash, &previews_dir, &thumbs_dir);
                Ok(SimilarFaceCandidate {
                    face_id,
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
            })
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        Ok(faces)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn unreject_face_candidates_batch(app: SharedHost, face_ids: Vec<String>, person_name: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
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

pub async fn unassign_faces_batch(app: SharedHost, face_ids: Vec<String>, person_name: String) -> Result<HashMap<String, Vec<FaceInstance>>, String> {
    tokio::task::spawn_blocking(move || {
        let clean = person_name.trim().to_string();
        if face_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut conn = open_global_db(&app)?;
        let mut affected_hashes: Vec<String> = Vec::new();

        {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for fid in &face_ids {
                if let Ok(h) = tx.query_row(
                    "SELECT hash FROM photo_faces WHERE face_id = ?1",
                    params![fid],
                    |r| r.get::<_, String>(0),
                ) {
                    tx.execute(
                        "UPDATE photo_faces SET person_name = NULL WHERE face_id = ?1",
                        params![fid],
                    ).map_err(|e| e.to_string())?;
                    if !affected_hashes.contains(&h) {
                        affected_hashes.push(h);
                    }
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
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

pub async fn get_pending_face_match_counts(app: SharedHost, root_folder: Option<String>) -> Result<HashMap<String, usize>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let suggestions = refresh_suggestion_cache(&app, &conn, root_folder.as_deref())?;
        Ok(suggestions.into_iter().map(|(name, list)| (name, list.len())).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn assign_faces_to_person_batch(app: SharedHost, face_ids: Vec<String>, person_name: String) -> Result<HashMap<String, Vec<FaceInstance>>, String> {
    tokio::task::spawn_blocking(move || {
        let clean = person_name.trim().to_string();
        if clean.is_empty() || face_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut conn = open_global_db(&app)?;
        let mut updated_hashes = Vec::new();
        let mut old_names_by_hash: Vec<(String, Option<String>)> = Vec::new();

        {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR IGNORE INTO people (name) VALUES (?1)",
                params![clean],
            ).map_err(|e| e.to_string())?;
            for fid in &face_ids {
                if let Ok((h, thumb, old_person)) = tx.query_row(
                    "SELECT hash, face_thumb, person_name FROM photo_faces WHERE face_id = ?1",
                    params![fid],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)),
                ) {
                    tx.execute(
                        "UPDATE photo_faces SET person_name = ?1 WHERE face_id = ?2",
                        params![clean, fid],
                    ).map_err(|e| e.to_string())?;
                    tx.execute(
                        "DELETE FROM face_rejections WHERE face_id = ?1 AND (lower(person_name) = lower(?2) OR person_name = ?3)",
                        params![fid, clean, IGNORED_FACE],
                    ).map_err(|e| e.to_string())?;
                    tx.execute(
                        "INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)",
                        params![h, clean],
                    ).map_err(|e| e.to_string())?;
                    tx.execute(
                        "UPDATE people SET cover_face_thumb = ?1 WHERE name = ?2 AND (cover_face_thumb IS NULL OR cover_face_thumb = '')",
                        params![thumb, clean],
                    ).map_err(|e| e.to_string())?;
                    old_names_by_hash.push((h.clone(), old_person));
                    if !updated_hashes.contains(&h) {
                        updated_hashes.push(h);
                    }
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
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

// Making the groups takes long in a large library (every person's suggestions, then every unnamed face against
// every other: tens of seconds on a server that is also writing captions), so the last groups are kept per
// folder with a mark of what they were made from. Asked again with nothing changed, they are the answer at once.
// After a change they are still the answer, without the faces that got a name or were set aside since, and new
// groups are made behind it for the next ask.
struct KeptClusters {
    mark: (i64, i64, i64),
    clusters: Vec<FaceCluster>,
}
static KEPT_CLUSTERS: LazyLock<Mutex<HashMap<Option<String>, KeptClusters>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
// One making at a time: each takes every core
static CLUSTERS_TURN: Mutex<()> = Mutex::new(());
static CLUSTERS_BEHIND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// What the groups depend on: the faces and their names (the revision counter, revision.rs) and the turned-down
// and set-aside faces
fn clusters_mark(conn: &Connection) -> (i64, i64, i64) {
    let rejections = conn
        .query_row("SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM face_rejections", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap_or((0, 0));
    (crate::revision::current(conn).unwrap_or(0), rejections.0, rejections.1)
}

// Kept groups without the faces that have a name now or were set aside
fn still_unknown(conn: &Connection, clusters: &[FaceCluster]) -> Vec<FaceCluster> {
    let unnamed: HashSet<String> = conn
        .prepare("SELECT face_id FROM photo_faces WHERE COALESCE(person_name, '') = ''")
        .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()))
        .unwrap_or_default();
    let ignored = ignored_face_ids(conn);
    let open = |id: &String| unnamed.contains(id) && !ignored.contains(id);
    clusters
        .iter()
        .filter_map(|c| {
            let face_ids: Vec<String> = c.face_ids.iter().filter(|id| open(id)).cloned().collect();
            let samples: Vec<SimilarFaceCandidate> = c.samples.iter().filter(|f| open(&f.face_id)).cloned().collect();
            (face_ids.len() >= 2 && !samples.is_empty()).then(|| FaceCluster { size: face_ids.len(), face_ids, samples })
        })
        .collect()
}

fn make_and_keep(app: &dyn Host, root_folder: Option<&str>) -> Result<Vec<FaceCluster>, String> {
    let _turn = CLUSTERS_TURN.lock().unwrap_or_else(|e| e.into_inner());
    let conn = open_global_db(app)?;
    let mark = clusters_mark(&conn);
    let key = root_folder.map(str::to_string);
    // Made meanwhile by whoever had the turn
    if let Some(kept) = KEPT_CLUSTERS.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        if kept.mark == mark {
            return Ok(kept.clusters.clone());
        }
    }
    let clusters = make_unknown_face_clusters(app, &conn, root_folder)?;
    KEPT_CLUSTERS.lock().unwrap_or_else(|e| e.into_inner()).insert(key, KeptClusters { mark, clusters: clusters.clone() });
    Ok(clusters)
}

// New groups for these folders (None: every library) made behind, unless they are being made already
pub fn keep_unknown_face_clusters_ready(app: SharedHost, roots: Vec<Option<String>>) {
    if CLUSTERS_BEHIND.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        for root in roots {
            let started = std::time::Instant::now();
            let fresh = KEPT_CLUSTERS.lock().unwrap_or_else(|e| e.into_inner()).get(&root).map(|k| k.mark);
            match make_and_keep(&*app, root.as_deref()) {
                Ok(c) => {
                    let mark = KEPT_CLUSTERS.lock().unwrap_or_else(|e| e.into_inner()).get(&root).map(|k| k.mark);
                    if mark != fresh {
                        eprintln!("[faces] {}: {} groups of faces without a name ready in {:.1} s", root.as_deref().unwrap_or("every library"), c.len(), started.elapsed().as_secs_f64());
                    }
                }
                Err(e) => eprintln!("[faces] couldn't group the faces without a name: {e}"),
            }
        }
        CLUSTERS_BEHIND.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

// Groups the folder's unnamed faces that aren't already suggested for someone, largest group first
pub async fn get_unknown_face_clusters(app: SharedHost, root_folder: Option<String>) -> Result<Vec<FaceCluster>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let mark = clusters_mark(&conn);
        let kept = KEPT_CLUSTERS.lock().unwrap_or_else(|e| e.into_inner()).get(&root_folder).map(|k| (k.mark == mark, k.clusters.clone()));
        match kept {
            Some((true, clusters)) => Ok(clusters),
            Some((false, clusters)) => {
                let clusters = still_unknown(&conn, &clusters);
                keep_unknown_face_clusters_ready(app.clone(), vec![root_folder]);
                Ok(clusters)
            }
            None => {
                drop(conn);
                make_and_keep(&*app, root_folder.as_deref())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn make_unknown_face_clusters(app: &dyn Host, conn: &Connection, root_folder: Option<&str>) -> Result<Vec<FaceCluster>, String> {
    {
        let (_, every) = refresh_suggestions(app, conn, root_folder)?;
        let mut suggested: HashSet<String> = (*every).clone();
        suggested.extend(ignored_face_ids(conn));
        let prefix = make_folder_prefix(root_folder);
        let thumbs_dir = get_app_storage_dir(app).join("thumbnails");
        let previews_dir = get_app_storage_dir(app).join("previews");

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
                    let face_id: String = r.get(0)?;
                    let hash: String = r.get(1)?;
                    let (photo_name, photo_path) =
                        format_display_photo_path(&face_id, r.get(3)?, &hash, &previews_dir, &thumbs_dir);
                    Ok(SimilarFaceCandidate {
                        face_id,
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
    }
}

// One person's face in short: the mean of their named faces' embeddings (normalized), in little-endian f32
// bytes as base64. All photos compares these between libraries to suggest that two people are one.
#[derive(Serialize)]
pub struct PersonCentroid {
    pub name: String,
    pub faces: usize,
    pub centroid: String,
}

// The people named on faces of the current engine; with `visible`, only faces on those photos (a guest's)
pub fn person_centroids(conn: &Connection, visible: Option<&HashSet<String>>) -> Result<Vec<PersonCentroid>, String> {
    let mut by_person: HashMap<String, (String, Vec<Vec<f32>>)> = HashMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT hash, person_name, embedding_blob FROM photo_faces
             WHERE engine = ?1 AND embedding_blob IS NOT NULL AND COALESCE(person_name, '') != '' AND person_name != ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![FACE_ENGINE_V2, IGNORED_FACE], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Vec<u8>>(2)?)))
        .map_err(|e| e.to_string())?;
    for (hash, name, blob) in rows.flatten() {
        if visible.is_some_and(|v| !v.contains(&hash)) {
            continue;
        }
        let entry = by_person.entry(name.to_lowercase()).or_insert_with(|| (name.clone(), Vec::new()));
        entry.1.push(blob_to_embedding(&blob));
    }
    let mut out: Vec<PersonCentroid> = by_person
        .into_values()
        .filter_map(|(name, faces)| {
            let centroid = compute_normalized_centroid(&faces, 512)?;
            let bytes: Vec<u8> = centroid.iter().flat_map(|f| f.to_le_bytes()).collect();
            Some(PersonCentroid { name, faces: faces.len(), centroid: general_purpose::STANDARD.encode(bytes) })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn face(id: &str) -> SimilarFaceCandidate {
        SimilarFaceCandidate {
            face_id: id.into(),
            hash: "a".into(),
            face_thumb: format!("{id}.jpg"),
            photo_name: String::new(),
            photo_path: String::new(),
            bbox_x: 0.0,
            bbox_y: 0.0,
            bbox_w: 1.0,
            bbox_h: 1.0,
            current_person: None,
            similarity: 0.0,
        }
    }

    // Kept groups answer at once after a change, without the faces that got a name or were set aside since
    #[test]
    fn kept_groups_leave_out_faces_named_or_set_aside_since() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO photos (hash, current_path) VALUES ('a', '/lib/a.jpg');
             INSERT INTO photo_faces (face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, face_thumb, embedding) VALUES
               ('f1', 'a', 0, 0, 1, 1, 'f1.jpg', ''), ('f2', 'a', 0, 0, 1, 1, 'f2.jpg', ''), ('f3', 'a', 0, 0, 1, 1, 'f3.jpg', ''),
               ('g1', 'a', 0, 0, 1, 1, 'g1.jpg', ''), ('g2', 'a', 0, 0, 1, 1, 'g2.jpg', '');",
        )
        .unwrap();
        let group = |ids: &[&str]| FaceCluster { size: ids.len(), face_ids: ids.iter().map(|s| s.to_string()).collect(), samples: ids.iter().map(|id| face(id)).collect() };
        let kept = vec![group(&["f1", "f2", "f3"]), group(&["g1", "g2"])];
        let mark = clusters_mark(&conn);
        assert_eq!(still_unknown(&conn, &kept).len(), 2);

        // f1 named, g1 set aside: the first group keeps two faces, the second is down to one and goes
        conn.execute_batch("UPDATE photo_faces SET person_name = 'Anna' WHERE face_id = 'f1'").unwrap();
        assert_ne!(clusters_mark(&conn), mark);
        let mark = clusters_mark(&conn);
        conn.execute("INSERT INTO face_rejections (face_id, person_name) VALUES ('g1', ?1)", [IGNORED_FACE]).unwrap();
        assert_ne!(clusters_mark(&conn), mark);
        let now = still_unknown(&conn, &kept);
        assert_eq!(now.len(), 1);
        assert_eq!((now[0].size, now[0].face_ids.clone()), (2, vec!["f2".to_string(), "f3".to_string()]));
        assert_eq!(now[0].samples.iter().map(|f| f.face_id.as_str()).collect::<Vec<_>>(), ["f2", "f3"]);
    }
}
