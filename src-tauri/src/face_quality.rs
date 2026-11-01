use crate::*;

// Faces found before Lumina measured eyes and focus (or before the smart search models that judge eyes were
// installed) are measured in the background when a library opens. Only photos that already have faces are
// read, so this never starts the face model download by itself.

static QUALITY_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
pub struct FaceQualityProgress {
    pub completed: usize,
    pub total: usize,
    pub done: bool,
    // The measured faces of the photos finished since the last event, for patching the grid
    pub batch: HashMap<String, Vec<FaceInstance>>,
}

// Starts measuring the folder's unmeasured faces; returns how many photos it will read (0 = nothing to do)
#[tauri::command]
pub async fn measure_face_quality(app: AppHandle, root_folder: String) -> Result<usize, String> {
    if QUALITY_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(0);
    }
    let started = start_measuring(app, root_folder).await;
    if !matches!(started, Ok(n) if n > 0) {
        QUALITY_RUNNING.store(false, Ordering::SeqCst);
    }
    started
}

async fn start_measuring(app: AppHandle, root_folder: String) -> Result<usize, String> {
    let eyes_possible = clip::clip_models_present(&get_models_dir(&app));
    let conn = open_global_db(&app)?;
    let mut targets: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT pf.hash, p.current_path FROM photo_faces pf JOIN photos p ON p.hash = pf.hash
                 WHERE p.current_path LIKE ?1 ESCAPE '!' AND pf.engine = ?2 AND COALESCE(p.media_type, 'photo') != 'video'
                   AND (pf.face_sharpness IS NULL OR (?3 AND pf.eyes_open IS NULL))",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![make_folder_prefix(Some(&root_folder)), FACE_ENGINE_V2, eyes_possible], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        targets.extend(rows.flatten());
    }
    drop(conn);
    if targets.is_empty() {
        return Ok(0);
    }
    let models = face_models_v2(&app).await?;
    let total = targets.len();
    std::thread::spawn(move || {
        let started = Instant::now();
        let measured = measure(&app, &models, &targets);
        QUALITY_RUNNING.store(false, Ordering::SeqCst);
        emit_perf(&app, "Measured eyes and focus", started, measured, format!("{} photos", targets.len()));
    });
    Ok(total)
}

fn measure(app: &AppHandle, models: &Arc<FaceModels>, targets: &[(String, String)]) -> usize {
    let Ok(conn) = open_global_db(app) else { return 0 };
    let previews_dir = get_app_storage_dir(app).join("previews");
    let mut measured = 0;
    let mut completed = 0;
    for chunk in targets.chunks(16) {
        // Decode and measure in parallel on the background pool; write in one transaction per chunk
        let results: Vec<(String, Vec<(String, FaceQuality)>)> = BG_POOL.install(|| {
            chunk
                .par_iter()
                .filter_map(|(hash, path)| {
                    let preview = previews_dir.join(format!("{hash}_preview.jpg"));
                    let source = if preview.exists() { preview } else { PathBuf::from(path) };
                    let img = open_and_orient_image(&source).ok()?;
                    let rgb = img.to_rgb8();
                    let faces = open_global_db(app).ok().map(|c| get_faces_for_hash(&c, hash)).unwrap_or_default();
                    let measured: Vec<(String, FaceQuality)> = faces
                        .into_iter()
                        .filter_map(|f| {
                            let q = models.quality_for_box(&img, &rgb, (f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h)).ok()?;
                            Some((f.face_id, q))
                        })
                        .collect();
                    Some((hash.clone(), measured))
                })
                .collect()
        });
        let mut batch: HashMap<String, Vec<FaceInstance>> = HashMap::new();
        for (hash, faces) in &results {
            for (face_id, q) in faces {
                let _ = conn.execute(
                    "UPDATE photo_faces SET eyes_open = COALESCE(?1, eyes_open), face_sharpness = ?2 WHERE face_id = ?3",
                    params![q.eyes_open, q.sharpness, face_id],
                );
                measured += 1;
            }
            batch.insert(hash.clone(), get_faces_for_hash(&conn, hash));
        }
        completed += chunk.len();
        let _ = app.emit(
            "face-quality-progress",
            FaceQualityProgress { completed, total: targets.len(), done: completed >= targets.len(), batch },
        );
    }
    measured
}
