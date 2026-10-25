use crate::*;

#[derive(Serialize, Clone)]
pub struct FileOpFailure {
    pub file: String,
    pub error: String,
}

#[derive(Serialize, Default)]
pub struct CommitResult {
    pub moved: usize,
    pub failures: Vec<FileOpFailure>,
}

// Moves a file, falling back to copy + size check + delete when a plain rename fails
// (e.g. the target is on another drive). Never leaves two copies behind on failure.
pub fn move_file(src: &Path, dest: &Path) -> Result<(), String> {
    if fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    let src_len = fs::metadata(src).map_err(|e| e.to_string())?.len();
    fs::copy(src, dest).map_err(|e| format!("copy failed: {e}"))?;
    let dest_len = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    if dest_len != src_len {
        let _ = fs::remove_file(dest);
        return Err(format!("copy incomplete ({dest_len} of {src_len} bytes)"));
    }
    if let Err(e) = fs::remove_file(src) {
        let _ = fs::remove_file(dest);
        return Err(format!("could not remove original after copying: {e}"));
    }
    Ok(())
}

// Sidecars that travel with a photo: darktable-style `name.ext.xmp` always,
// and Lightroom-style `name.xmp` unless another file with the same name stays behind (RAW+JPEG pair).
pub fn sidecars_for(src: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let full = PathBuf::from(format!("{}.xmp", src.to_string_lossy()));
    if full.exists() {
        out.push(full);
    }
    let stem_xmp = src.with_extension("xmp");
    if stem_xmp.exists() {
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_lowercase());
        let partner_stays = src
            .parent()
            .and_then(|dir| fs::read_dir(dir).ok())
            .map(|entries| {
                entries.flatten().any(|e| {
                    let p = e.path();
                    p != src
                        && p.extension().map(|x| !x.eq_ignore_ascii_case("xmp")).unwrap_or(false)
                        && p.file_stem().map(|s| s.to_string_lossy().to_lowercase()) == stem
                })
            })
            .unwrap_or(false);
        if !partner_stays {
            out.push(stem_xmp);
        }
    }
    out
}

#[tauri::command]
pub async fn commit_staged_operations(
    app: AppHandle,
    root_folder: String,
    smart_rename: Option<bool>,
) -> Result<CommitResult, String> {
    tauri::async_runtime::spawn_blocking(move || commit_staged_blocking(&app, root_folder, smart_rename))
        .await
        .map_err(|e| e.to_string())?
}

fn commit_staged_blocking(
    app: &AppHandle,
    root_folder: String,
    smart_rename: Option<bool>,
) -> Result<CommitResult, String> {
    let do_rename = smart_rename.unwrap_or(false);
    let conn = open_global_db(app)?;
    let prefix = make_folder_prefix(Some(&root_folder));
    let mut stmt = conn
        .prepare(
            "SELECT hash, current_path, staged_target, COALESCE(captured_at, ''), COALESCE(location, '')
             FROM photos WHERE staged_target IS NOT NULL AND current_path LIKE ?1 ESCAPE '!'
             ORDER BY captured_at ASC, current_path ASC",
        )
        .map_err(|e| e.to_string())?;

    let ops: Vec<(String, String, String, String, String)> = stmt
        .query_map(params![prefix], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    let root = Path::new(&root_folder);
    let mut result = CommitResult::default();
    let mut seq = 1usize;
    let total = ops.len();

    for (op_idx, (hash, current_path, target_sub, captured_at, location)) in ops.into_iter().enumerate() {
        let src = Path::new(&current_path);
        let display_name = src
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| current_path.clone());
        if op_idx % 10 == 0 {
            let _ = app.emit(
                "scan-progress",
                ScanProgressEvent {
                    stage: "Committing moves to disk...".to_string(),
                    current_file: display_name.clone(),
                    completed: op_idx,
                    total,
                    percent: (op_idx * 100) / total.max(1),
                    done: false,
                },
            );
        }
        if !src.exists() {
            result.failures.push(FileOpFailure {
                file: current_path.clone(),
                error: "file no longer exists on disk".to_string(),
            });
            continue;
        }
        let orig_fname = match src.file_name() {
            Some(f) => f.to_string_lossy().to_string(),
            None => continue,
        };
        let ext = src
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "jpg".to_string());

        let clean_sub = target_sub.trim().replace('\\', "/");
        let target_dir = if clean_sub.is_empty() || clean_sub.eq_ignore_ascii_case("Root") {
            root.to_path_buf()
        } else {
            let mut d = root.to_path_buf();
            for part in clean_sub.split('/').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                d = d.join(part);
            }
            d
        };

        if let Err(e) = fs::create_dir_all(&target_dir) {
            result.failures.push(FileOpFailure {
                file: current_path.clone(),
                error: format!("could not create folder {}: {e}", target_dir.display()),
            });
            continue;
        }

        let final_fname = if do_rename && clean_sub != "_Trash" {
            let date_part = if captured_at.len() >= 10 {
                captured_at[..10].replace(':', "-")
            } else {
                "0000-00-00".to_string()
            };
            let time_part = if captured_at.len() >= 19 {
                captured_at[11..19].replace(':', "")
            } else {
                format!("{:04}", seq)
            };
            let city_part = if !location.is_empty() {
                let raw_city = location.split(',').next().unwrap_or("").trim();
                let sanitized: String = raw_city
                    .chars()
                    .filter(|c| c.is_alphanumeric() || *c == '-')
                    .collect();
                if sanitized.is_empty() {
                    String::new()
                } else {
                    format!("_{}", sanitized)
                }
            } else {
                String::new()
            };
            let name = format!("{}_{}{}_{:03}.{}", date_part, time_part, city_part, seq, ext);
            seq += 1;
            name
        } else {
            orig_fname
        };

        let mut dest = target_dir.join(&final_fname);
        if dest != src && dest.exists() {
            let stem = Path::new(&final_fname)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "photo".to_string());
            dest = target_dir.join(format!("{}_{}.{}", stem, &hash[..6], ext));
        }

        if dest == src {
            // Already where it was staged to: just clear the staging flag
            let _ = conn.execute("UPDATE photos SET staged_target = NULL WHERE hash = ?1", params![hash]);
            continue;
        }
        if dest.exists() {
            result.failures.push(FileOpFailure {
                file: current_path.clone(),
                error: format!("{} already exists", dest.display()),
            });
            continue;
        }

        let sidecars = sidecars_for(src);
        if let Err(e) = move_file(src, &dest) {
            result.failures.push(FileOpFailure { file: current_path.clone(), error: e });
            continue;
        }
        let new_stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        for sidecar in sidecars {
            let sidecar_name = sidecar.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            let new_name = if sidecar_name.to_lowercase().ends_with(&format!(".{}.xmp", ext)) {
                format!("{}.{}.xmp", new_stem, dest.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default())
            } else {
                format!("{}.xmp", new_stem)
            };
            let sidecar_dest = target_dir.join(new_name);
            if !sidecar_dest.exists() {
                if let Err(e) = move_file(&sidecar, &sidecar_dest) {
                    result.failures.push(FileOpFailure {
                        file: sidecar.to_string_lossy().to_string(),
                        error: format!("photo moved, but its sidecar could not be: {e}"),
                    });
                }
            }
        }

        let new_path = dest.to_string_lossy().to_string();
        let new_sub = get_relative_subfolder(root, &dest);
        let _ = conn.execute(
            "UPDATE photos SET current_path = ?1, subfolder = ?2, staged_target = NULL WHERE hash = ?3",
            params![new_path, new_sub, hash],
        );
        result.moved += 1;
    }

    let _ = app.emit(
        "scan-progress",
        ScanProgressEvent {
            stage: "Ready".to_string(),
            current_file: String::new(),
            completed: total,
            total,
            percent: 100,
            done: true,
        },
    );

    Ok(result)
}

pub struct XmpData<'a> {
    pub rating: i32,
    pub rejected: bool,
    pub color_label: &'a str,
    pub caption: &'a str,
    pub captured_at: &'a str,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub subjects: Vec<&'a str>,
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// XMP stores GPS as "DD,MM.mmmmmmR" (degrees, decimal minutes, hemisphere), not as a signed decimal
pub fn xmp_gps_coordinate(value: f64, positive_ref: char, negative_ref: char) -> String {
    let hemisphere = if value < 0.0 { negative_ref } else { positive_ref };
    let abs = value.abs();
    let degrees = abs.trunc();
    let minutes = (abs - degrees) * 60.0;
    format!("{},{:.6}{}", degrees as i64, minutes, hemisphere)
}

pub fn build_xmp_packet(data: &XmpData) -> String {
    // Lightroom convention: rejected photos carry rating -1
    let rating = if data.rejected { -1 } else { data.rating.clamp(0, 5) };
    let label = match data.color_label {
        "" => String::new(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    };
    let create_date = if data.captured_at.len() >= 19 {
        format!("{}T{}", &data.captured_at[..10], &data.captured_at[11..19])
    } else {
        String::new()
    };

    let mut attrs = format!("      xmp:CreatorTool=\"{LUMINA_XMP_CREATOR}\"\n      xmp:Rating=\"{rating}\"\n");
    if !label.is_empty() {
        attrs.push_str(&format!("      xmp:Label=\"{}\"\n", xml_escape(&label)));
    }
    if !create_date.is_empty() {
        attrs.push_str(&format!("      xmp:CreateDate=\"{create_date}\"\n"));
    }
    if let (Some(la), Some(lo)) = (data.lat, data.lon) {
        attrs.push_str(&format!(
            "      exif:GPSLatitude=\"{}\"\n      exif:GPSLongitude=\"{}\"\n",
            xmp_gps_coordinate(la, 'N', 'S'),
            xmp_gps_coordinate(lo, 'E', 'W')
        ));
    }

    let subject_xml: String = data
        .subjects
        .iter()
        .map(|s| format!("          <rdf:li>{}</rdf:li>\n", xml_escape(s)))
        .collect();

    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
    <rdf:Description rdf:about=\"\"\n\
      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n\
      xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n\
      xmlns:exif=\"http://ns.adobe.com/exif/1.0/\"\n\
{attrs}    >\n\
      <dc:description>\n\
        <rdf:Alt>\n\
          <rdf:li xml:lang=\"x-default\">{}</rdf:li>\n\
        </rdf:Alt>\n\
      </dc:description>\n\
      <dc:subject>\n\
        <rdf:Bag>\n\
{subject_xml}        </rdf:Bag>\n\
      </dc:subject>\n\
    </rdf:Description>\n\
  </rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>",
        xml_escape(data.caption)
    )
}

pub const LUMINA_XMP_CREATOR: &str = "Lumina";

// A sidecar we may overwrite: none yet, or one Lumina wrote itself (never touch Lightroom/darktable/Capture One files)
pub fn is_lumina_owned_sidecar(xmp_path: &Path) -> bool {
    match fs::read_to_string(xmp_path) {
        Ok(existing) => existing.contains(&format!("xmp:CreatorTool=\"{LUMINA_XMP_CREATOR}")),
        Err(_) => !xmp_path.exists(),
    }
}

// A JPEG with a same-named RAW beside it shares that RAW's sidecar; only the RAW writes it
fn has_raw_sibling(img_path: &Path) -> bool {
    let ext = img_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "jpg" | "jpeg") {
        return false;
    }
    ["cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "pef", "raf", "CR2", "CR3", "NEF", "ARW", "DNG", "ORF", "RW2", "PEF", "RAF"]
        .iter()
        .any(|raw_ext| img_path.with_extension(raw_ext).exists())
}

#[derive(Serialize, Default)]
pub struct XmpExportResult {
    pub exported: usize,
    pub skipped_foreign: usize,
    pub skipped_raw_pair: usize,
    pub failed: usize,
}

#[tauri::command]
pub async fn export_xmp_sidecars(
    app: AppHandle,
    hashes: Option<Vec<String>>,
    root_folder: Option<String>,
) -> Result<XmpExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || export_xmp_sidecars_blocking(&app, hashes, root_folder))
        .await
        .map_err(|e| e.to_string())?
}

fn export_xmp_sidecars_blocking(
    app: &AppHandle,
    hashes: Option<Vec<String>>,
    root_folder: Option<String>,
) -> Result<XmpExportResult, String> {
    let conn = open_global_db(app)?;
    let prefix = make_folder_prefix(root_folder.as_deref());

    let mut tags_map: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash, tag FROM photo_tags") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for r in rows.flatten() {
                tags_map.entry(r.0).or_default().push(r.1);
            }
        }
    }

    let mut people_map: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash, person_name FROM photo_people") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for r in rows.flatten() {
                people_map.entry(r.0).or_default().push(r.1);
            }
        }
    }

    let filter_set: Option<std::collections::HashSet<String>> =
        hashes.map(|v| v.into_iter().collect());

    let mut stmt = conn
        .prepare(
            "SELECT hash, current_path, rating, COALESCE(flag, ''), COALESCE(color_label, ''), COALESCE(ai_caption, ''),
                    COALESCE(captured_at, ''), latitude, longitude
             FROM photos WHERE current_path LIKE ?1 ESCAPE '!'",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![prefix], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i32>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<f64>>(7)?,
                r.get::<_, Option<f64>>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut result = XmpExportResult::default();
    for row in rows.flatten() {
        let (hash, path_str, rating, flag, color_label, caption, captured_at, lat, lon) = row;
        if let Some(ref set) = filter_set {
            if !set.contains(&hash) {
                continue;
            }
        }

        let img_path = Path::new(&path_str);
        if !img_path.exists() {
            continue;
        }
        if has_raw_sibling(img_path) {
            result.skipped_raw_pair += 1;
            continue;
        }
        let xmp_path = img_path.with_extension("xmp");
        if !is_lumina_owned_sidecar(&xmp_path) {
            result.skipped_foreign += 1;
            continue;
        }

        let tags = tags_map.get(&hash).cloned().unwrap_or_default();
        let people = people_map.get(&hash).cloned().unwrap_or_default();
        let packet = build_xmp_packet(&XmpData {
            rating,
            rejected: flag == "reject",
            color_label: &color_label,
            caption: &caption,
            captured_at: &captured_at,
            lat,
            lon,
            subjects: tags.iter().chain(people.iter()).map(|s| s.as_str()).collect(),
        });

        // Write-then-rename so a crash never leaves a half-written sidecar
        let tmp_path = xmp_path.with_extension("xmp.lumina-tmp");
        let written = fs::write(&tmp_path, packet).and_then(|_| fs::rename(&tmp_path, &xmp_path));
        if written.is_ok() {
            result.exported += 1;
        } else {
            let _ = fs::remove_file(&tmp_path);
            result.failed += 1;
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn get_library_health_stats(app: AppHandle, root_folder: Option<String>) -> Result<LibraryHealthStats, String> {
    tauri::async_runtime::spawn_blocking(move || get_library_health_stats_blocking(app, root_folder))
        .await
        .map_err(|e| e.to_string())?
}

fn get_library_health_stats_blocking(app: AppHandle, root_folder: Option<String>) -> Result<LibraryHealthStats, String> {
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(root_folder.as_deref());

    let total_photos: usize = conn
        .query_row("SELECT COUNT(*) FROM photos WHERE current_path LIKE ?1 ESCAPE '!'", params![prefix], |r| r.get(0))
        .unwrap_or(0);
    let total_bytes: i64 = conn
        .query_row("SELECT COALESCE(SUM(file_size), 0) FROM photos WHERE current_path LIKE ?1 ESCAPE '!'", params![prefix], |r| r.get(0))
        .unwrap_or(0);

    let (trash_cnt, trash_bytes): (usize, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(file_size), 0) FROM photos WHERE (staged_target = '_Trash' OR subfolder = '_Trash') AND current_path LIKE ?1 ESCAPE '!'",
            params![prefix],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    let dup_groups = compute_db_duplicate_groups(&conn, root_folder.as_deref());
    let mut seen_groups = std::collections::HashSet::new();
    let mut dup_extras_cnt = 0usize;
    let mut dup_extras_bytes = 0i64;

    for (h, grp) in &dup_groups {
        if !seen_groups.insert(*grp) {
            dup_extras_cnt += 1;
            let sz: i64 = conn
                .query_row("SELECT COALESCE(file_size, 0) FROM photos WHERE hash = ?1", params![h], |r| r.get(0))
                .unwrap_or(0);
            dup_extras_bytes += sz;
        }
    }

    let mut valid_hashes = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash FROM photos") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for h in rows.flatten() {
                valid_hashes.insert(h);
            }
        }
    }

    let app_dir = get_app_storage_dir(&app);
    let thumbs_dir = app_dir.join("thumbnails");
    let faces_dir = app_dir.join("faces");

    let mut cache_files_count = 0usize;
    let mut cache_bytes = 0u64;
    let mut orphaned_count = 0usize;

    for dir in [&thumbs_dir, &faces_dir] {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        cache_files_count += 1;
                        cache_bytes += meta.len();
                        let stem = entry
                            .path()
                            .file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_default();
                        let base_hash = stem.split('_').next().unwrap_or("");
                        if !base_hash.is_empty() && !valid_hashes.contains(base_hash) {
                            orphaned_count += 1;
                        }
                    }
                }
            }
        }
    }

    let damaged_count: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM photos WHERE damaged = 1 AND current_path LIKE ?1 ESCAPE '!'",
            params![prefix],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let mut damaged_files = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT current_path FROM photos WHERE damaged = 1 AND current_path LIKE ?1 ESCAPE '!' ORDER BY current_path LIMIT 50",
    ) {
        if let Ok(rows) = stmt.query_map(params![prefix], |r| r.get::<_, String>(0)) {
            damaged_files = rows.flatten().collect();
        }
    }

    let mut camera_breakdown = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT CASE WHEN camera_model = '' OR camera_model IS NULL THEN 'Unknown / No EXIF' ELSE camera_model END as cam,
                COUNT(*) as cnt
         FROM photos WHERE current_path LIKE ?1 ESCAPE '!' GROUP BY cam ORDER BY cnt DESC LIMIT 8",
    ) {
        if let Ok(rows) = stmt.query_map(params![prefix], |r| Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?))) {
            camera_breakdown = rows.flatten().collect();
        }
    }

    Ok(LibraryHealthStats {
        total_photos,
        total_library_size_mb: (total_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
        trash_staged_count: trash_cnt,
        trash_recoverable_mb: (trash_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
        duplicate_extras_count: dup_extras_cnt,
        duplicate_recoverable_mb: (dup_extras_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
        cache_files_count,
        cache_size_mb: (cache_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
        orphaned_cache_count: orphaned_count,
        camera_breakdown,
        damaged_count,
        damaged_files,
    })
}

#[tauri::command]
pub async fn prune_orphaned_cache(app: AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || prune_orphaned_cache_blocking(app))
        .await
        .map_err(|e| e.to_string())?
}

fn prune_orphaned_cache_blocking(app: AppHandle) -> Result<usize, String> {
    let conn = open_global_db(&app)?;
    let mut valid_hashes = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT hash FROM photos") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for h in rows.flatten() {
                valid_hashes.insert(h);
            }
        }
    }

    let app_dir = get_app_storage_dir(&app);
    let thumbs_dir = app_dir.join("thumbnails");
    let faces_dir = app_dir.join("faces");

    let mut removed = 0usize;
    for dir in [&thumbs_dir, &faces_dir] {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let stem = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let base_hash = stem.split('_').next().unwrap_or("");
                    if !base_hash.is_empty() && !valid_hashes.contains(base_hash) {
                        if fs::remove_file(&path).is_ok() {
                            removed += 1;
                        }
                    }
                }
            }
        }
    }

    Ok(removed)
}

// Sends files to the OS Recycle Bin in one batch. Never deletes permanently: a file that cannot be
// recycled is reported and left in place. Returns the paths that are gone afterwards.
pub fn recycle_files(paths: &[PathBuf]) -> (Vec<PathBuf>, Vec<FileOpFailure>) {
    let existing: Vec<&PathBuf> = paths.iter().filter(|p| p.exists()).collect();
    let mut failures = Vec::new();
    if trash::delete_all(&existing).is_err() {
        // Retry one by one so a single locked file doesn't block the rest
        for p in &existing {
            if p.exists() {
                if let Err(e) = trash::delete(p) {
                    failures.push(FileOpFailure {
                        file: p.to_string_lossy().to_string(),
                        error: format!("could not move to Recycle Bin: {e}"),
                    });
                }
            }
        }
    }
    let gone = paths.iter().filter(|p| !p.exists()).cloned().collect();
    (gone, failures)
}

#[derive(Serialize, Default)]
pub struct TrashResult {
    pub recycled: usize,
    pub failures: Vec<FileOpFailure>,
}

#[tauri::command]
pub async fn empty_library_trash_to_os(app: AppHandle, root_folder: String) -> Result<TrashResult, String> {
    tauri::async_runtime::spawn_blocking(move || empty_trash_blocking(&app, root_folder))
        .await
        .map_err(|e| e.to_string())?
}

fn empty_trash_blocking(app: &AppHandle, root_folder: String) -> Result<TrashResult, String> {
    let mut conn = open_global_db(app)?;
    let prefix = make_folder_prefix(Some(&root_folder));

    let targets: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT hash, current_path FROM photos
                 WHERE (subfolder = '_Trash' OR staged_target = '_Trash') AND current_path LIKE ?1 ESCAPE '!'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![prefix], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };

    if targets.is_empty() {
        return Ok(TrashResult::default());
    }

    let paths: Vec<PathBuf> = targets.iter().map(|(_, p)| PathBuf::from(p)).collect();
    let (gone, failures) = recycle_files(&paths);
    let gone_set: std::collections::HashSet<&PathBuf> = gone.iter().collect();
    let deleted_hashes: Vec<&String> = targets
        .iter()
        .filter(|(_, p)| gone_set.contains(&PathBuf::from(p)))
        .map(|(h, _)| h)
        .collect();

    // Drop DB rows and every cached derivative (thumbnail, preview, face crops, embeddings) of recycled photos
    let mut face_thumbs: Vec<String> = Vec::new();
    if let Ok(tx) = conn.transaction() {
        for h in &deleted_hashes {
            if let Ok(mut stmt) = tx.prepare_cached("SELECT face_id, face_thumb FROM photo_faces WHERE hash = ?1") {
                if let Ok(rows) = stmt.query_map(params![h], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                    for (face_id, thumb) in rows.flatten() {
                        let _ = tx.execute("DELETE FROM face_rejections WHERE face_id = ?1", params![face_id]);
                        if let Ok(mut cache) = FACE_EMBEDDING_CACHE.lock() {
                            cache.remove(&face_id);
                        }
                        face_thumbs.push(thumb);
                    }
                }
            }
            let _ = tx.execute("DELETE FROM photos WHERE hash = ?1", params![h]);
            let _ = tx.execute("DELETE FROM photo_tags WHERE hash = ?1", params![h]);
            let _ = tx.execute("DELETE FROM photo_people WHERE hash = ?1", params![h]);
            let _ = tx.execute("DELETE FROM photo_faces WHERE hash = ?1", params![h]);
        }
        let _ = tx.commit();
    }
    if let Ok(mut pending) = PENDING_CANDIDATES_CACHE.lock() {
        pending.clear();
    }

    let app_dir = get_app_storage_dir(app);
    for h in &deleted_hashes {
        let _ = fs::remove_file(app_dir.join("thumbnails").join(format!("{h}.jpg")));
        let _ = fs::remove_file(app_dir.join("previews").join(format!("{h}_preview.jpg")));
    }
    for thumb in face_thumbs {
        let _ = fs::remove_file(thumb);
    }

    // If the physical _Trash directory is now empty, remove it cleanly
    let trash_dir = Path::new(&root_folder).join("_Trash");
    if trash_dir.exists() {
        let _ = fs::remove_dir(&trash_dir);
    }

    Ok(TrashResult {
        recycled: deleted_hashes.len(),
        failures,
    })
}
