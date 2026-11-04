use crate::*;

// Stored with every embedding: vectors from different engines must never be compared
pub const FACE_ENGINE_V2: &str = "scrfd10g-arcface_r50-aligned-v1";

// Embeddings are stored as little-endian f32 bytes (2 KB per face instead of ~6 KB of JSON text)
pub fn embedding_to_blob(embedding: &[f32]) -> Vec<u8> {
    embedding.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn blob_to_embedding(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

pub static FACE_EMBEDDING_CACHE: LazyLock<Mutex<HashMap<String, Vec<f32>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub static EMBEDDING_CACHE_WARMED: AtomicBool = AtomicBool::new(false);

pub static PENDING_CANDIDATES_CACHE: LazyLock<Mutex<HashMap<String, Vec<SimilarFaceCandidate>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn ensure_embedding_cache_loaded(conn: &Connection) {
    if EMBEDDING_CACHE_WARMED.load(Ordering::Acquire) {
        return;
    }
    // Only embeddings of the current engine: vectors from different engines are not comparable
    let mut parsed_map: HashMap<String, Vec<f32>> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT face_id, embedding_blob FROM photo_faces WHERE engine = ?1 AND embedding_blob IS NOT NULL",
    ) {
        if let Ok(rows) = stmt.query_map(params![FACE_ENGINE_V2], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        }) {
            for (fid, blob) in rows.flatten() {
                let vec = blob_to_embedding(&blob);
                if vec.len() == 512 {
                    parsed_map.insert(fid, vec);
                }
            }
        }
    }
    if let Ok(mut guard) = FACE_EMBEDDING_CACHE.lock() {
        for (k, v) in parsed_map {
            guard.entry(k).or_insert(v);
        }
    }
    EMBEDDING_CACHE_WARMED.store(true, Ordering::Release);
}

// ----------------- FACE MATCHING (the face engine itself lives in face_ort.rs) -----------------

pub fn get_models_dir<H: Host + ?Sized>(app: &H) -> PathBuf {
    let dir = get_app_storage_dir(app).join("models");
    let _ = fs::create_dir_all(&dir);
    dir
}

// Single source of truth for face-match thresholds (engine v2: aligned ArcFace r50 cosine). The badge counts,
// the review modal and its colour coding all use these via `get_face_match_config`. Chosen with face_eval on
// a 10-person labelled set (2026-10-26): at 0.50 recall 96-99% with 100% precision and 0% strangers suggested;
// at 0.60 every suggestion was correct but recall drops to 67-89%, so 0.60+ is shown as a "likely" match.
pub const FACE_MATCH_MIN_SIMILARITY: f32 = 0.50;
pub const FACE_MATCH_STRONG_SIMILARITY: f32 = 0.60;

#[derive(Serialize)]
pub struct FaceMatchConfig {
    pub min_similarity_percent: f32,
    pub strong_similarity_percent: f32,
}

pub fn get_face_match_config() -> FaceMatchConfig {
    FaceMatchConfig {
        min_similarity_percent: FACE_MATCH_MIN_SIMILARITY * 100.0,
        strong_similarity_percent: FACE_MATCH_STRONG_SIMILARITY * 100.0,
    }
}

// Pending-candidate cache entries are per person AND per library folder
pub fn pending_cache_key(person: &str, root_folder: Option<&str>) -> String {
    format!("{}|{}", person.trim().to_lowercase(), make_folder_prefix(root_folder).to_lowercase())
}

// Swaps in freshly computed candidates for one folder, leaving other folders' cached entries alone
pub fn replace_pending_for_folder(root_folder: Option<&str>, fresh: HashMap<String, Vec<SimilarFaceCandidate>>) {
    let suffix = format!("|{}", make_folder_prefix(root_folder).to_lowercase());
    if let Ok(mut g) = PENDING_CANDIDATES_CACHE.lock() {
        g.retain(|k, _| !k.ends_with(&suffix));
        g.extend(fresh);
    }
}

pub fn invalidate_pending_for_person(person: &str) {
    let prefix = format!("{}|", person.trim().to_lowercase());
    if let Ok(mut g) = PENDING_CANDIDATES_CACHE.lock() {
        g.retain(|k, _| !k.starts_with(&prefix));
    }
}

// Intersection-over-union of two normalized (x, y, w, h) boxes
pub fn bbox_iou(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> f64 {
    let ix = (a.0 + a.2).min(b.0 + b.2) - a.0.max(b.0);
    let iy = (a.1 + a.3).min(b.1 + b.3) - a.1.max(b.1);
    let inter = ix.max(0.0) * iy.max(0.0);
    let union = a.2 * a.3 + b.2 * b.3 - inter;
    if union > 0.0 { inter / union } else { 0.0 }
}

pub fn compute_normalized_centroid(embeddings: &[Vec<f32>], dim: usize) -> Option<Vec<f32>> {
    let valid: Vec<&Vec<f32>> = embeddings.iter().filter(|e| e.len() == dim).collect();
    if valid.is_empty() {
        return None;
    }
    let mut centroid = vec![0.0f32; dim];
    for emb in &valid {
        for (i, &val) in emb.iter().enumerate() {
            centroid[i] += val;
        }
    }
    let norm = centroid.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-6);
    for v in &mut centroid {
        *v /= norm;
    }
    Some(centroid)
}

pub fn find_overlapping_face_id(
    conn: &Connection,
    hash: &str,
    bbox: (f64, f64, f64, f64),
    claimed_ids: Option<&std::collections::HashSet<String>>,
) -> Option<(String, Option<String>)> {
    let existing = get_faces_for_hash(conn, hash);
    let (bx, by, bw, bh) = bbox;
    let bcx = bx + bw * 0.5;
    let bcy = by + bh * 0.5;

    let mut best_match: Option<(String, Option<String>, f64)> = None;

    for f in existing {
        if let Some(claimed) = claimed_ids {
            if claimed.contains(&f.face_id) {
                continue;
            }
        }
        let ix1 = bx.max(f.bbox_x);
        let iy1 = by.max(f.bbox_y);
        let ix2 = (bx + bw).min(f.bbox_x + f.bbox_w);
        let iy2 = (by + bh).min(f.bbox_y + f.bbox_h);
        let inter = (ix2 - ix1).max(0.0) * (iy2 - iy1).max(0.0);
        let area_a = bw * bh;
        let area_b = f.bbox_w * f.bbox_h;
        let union = area_a + area_b - inter;
        let min_area = area_a.min(area_b);

        let fcx = f.bbox_x + f.bbox_w * 0.5;
        let fcy = f.bbox_y + f.bbox_h * 0.5;
        let center_dist = ((bcx - fcx).powi(2) + (bcy - fcy).powi(2)).sqrt();
        let min_radius = (bw.min(f.bbox_w) + bh.min(f.bbox_h)) * 0.18;

        let iou = if union > 0.0 { inter / union } else { 0.0 };
        let containment = if min_area > 0.0 { inter / min_area } else { 0.0 };

        if iou > 0.30 || containment > 0.60 || center_dist < min_radius {
            let score = iou.max(containment);
            if best_match.as_ref().map(|b| score > b.2).unwrap_or(true) {
                best_match = Some((f.face_id, f.person_name, score));
            }
        }
    }
    best_match.map(|(id, name, _)| (id, name))
}

pub fn sync_photo_people_from_faces(conn: &Connection, hash: &str, previous_face_person: Option<&str>) {
    // Ensure all currently named faces on this photo exist in photo_people
    let faces = get_faces_for_hash(conn, hash);
    let active_face_names: std::collections::HashSet<String> = faces
        .iter()
        .filter_map(|f| f.person_name.as_ref().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect();

    for name in &active_face_names {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)",
            params![hash, name],
        );
    }

    // If a face was renamed or removed, remove the old person_name from photo_people if no other face on this photo still has it
    if let Some(prev_name) = previous_face_person {
        let clean_prev = prev_name.trim();
        if !clean_prev.is_empty() && !active_face_names.iter().any(|n| n.eq_ignore_ascii_case(clean_prev)) {
            let _ = conn.execute(
                "DELETE FROM photo_people WHERE hash = ?1 AND lower(person_name) = lower(?2)",
                params![hash, clean_prev],
            );
        }
        forget_unused_person(conn, clean_prev);
    }
}

// A person left on no photo and no face (the last name taken off) goes from the people list: People shows
// no one without photos, and the row would linger forever. One the user starred or hid stays.
pub fn forget_unused_person(conn: &Connection, name: &str) {
    if name.trim().is_empty() {
        return;
    }
    let _ = conn.execute(
        "DELETE FROM people WHERE lower(name) = lower(?1) AND COALESCE(starred, 0) = 0 AND COALESCE(hidden, 0) = 0
           AND NOT EXISTS (SELECT 1 FROM photo_people WHERE lower(person_name) = lower(?1))
           AND NOT EXISTS (SELECT 1 FROM photo_faces WHERE lower(person_name) = lower(?1))",
        params![name.trim()],
    );
}

pub fn get_faces_for_hash(conn: &Connection, hash: &str) -> Vec<FaceInstance> {
    let mut stmt = match conn.prepare(
        "SELECT face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, person_name, face_thumb, confidence, eyes_open, face_sharpness
         FROM photo_faces WHERE hash = ?1 ORDER BY bbox_x ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![hash], |row| {
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
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    rows.flatten().collect()
}

// ----------------- FACE PIPELINE (shared by Scan Faces and the face_eval benchmark) -----------------
