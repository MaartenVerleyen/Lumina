use crate::*;

#[tauri::command]
pub fn commit_staged_operations(
    app: AppHandle,
    root_folder: String,
    smart_rename: Option<bool>,
) -> Result<usize, String> {
    let do_rename = smart_rename.unwrap_or(false);
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(Some(&root_folder));
    let mut stmt = conn
        .prepare(
            "SELECT hash, current_path, staged_target, COALESCE(captured_at, ''), COALESCE(location, '')
             FROM photos WHERE staged_target IS NOT NULL AND current_path LIKE ?1
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
    let mut count = 0;
    let mut seq = 1usize;

    for (hash, current_path, target_sub, captured_at, location) in ops {
        let src = Path::new(&current_path);
        if !src.exists() {
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

        if !target_dir.exists() {
            let _ = fs::create_dir_all(&target_dir);
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
            seq += 1;
            format!("{}_{}{}_{:03}.{}", date_part, time_part, city_part, seq, ext)
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

        if dest != src && !dest.exists() {
            if fs::rename(src, &dest).is_ok() {
                let new_path = dest.to_string_lossy().to_string();
                let new_sub = get_relative_subfolder(root, &dest);
                let _ = conn.execute(
                    "UPDATE photos SET current_path = ?1, subfolder = ?2, staged_target = NULL WHERE hash = ?3",
                    params![new_path, new_sub, hash],
                );
                count += 1;
            }
        }
    }

    Ok(count)
}

#[tauri::command]
pub fn export_xmp_sidecars(app: AppHandle, hashes: Option<Vec<String>>) -> Result<usize, String> {
    let conn = open_global_db(&app)?;

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
            "SELECT hash, current_path, rating, COALESCE(color_label, ''), COALESCE(ai_caption, ''),
                    COALESCE(captured_at, ''), latitude, longitude
             FROM photos",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i32>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<f64>>(6)?,
                r.get::<_, Option<f64>>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut exported = 0usize;
    for row in rows.flatten() {
        let (hash, path_str, rating, color_label, caption, captured_at, lat, lon) = row;
        if let Some(ref set) = filter_set {
            if !set.contains(&hash) {
                continue;
            }
        }

        let img_path = Path::new(&path_str);
        if !img_path.exists() {
            continue;
        }
        let xmp_path = img_path.with_extension("xmp");

        let tags = tags_map.get(&hash).cloned().unwrap_or_default();
        let people = people_map.get(&hash).cloned().unwrap_or_default();

        let mut subject_xml = String::new();
        for t in tags.iter().chain(people.iter()) {
            let escaped = t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
            subject_xml.push_str(&format!("          <rdf:li>{}</rdf:li>\n", escaped));
        }

        let escaped_caption = caption
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");

        let gps_xml = if let (Some(la), Some(lo)) = (lat, lon) {
            format!(
                "      exif:GPSLatitude=\"{}\"\n      exif:GPSLongitude=\"{}\"\n",
                la, lo
            )
        } else {
            String::new()
        };

        let xmp_content = format!(
            "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
    <rdf:Description rdf:about=\"\"\n\
      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n\
      xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n\
      xmlns:exif=\"http://ns.adobe.com/exif/1.0/\"\n\
      xmp:CreatorTool=\"Lumina v3.6\"\n\
      xmp:Rating=\"{}\"\n\
      xmp:Label=\"{}\"\n\
      xmp:CreateDate=\"{}\"\n\
{}>\n\
      <dc:description>\n\
        <rdf:Alt>\n\
          <rdf:li xml:lang=\"x-default\">{}</rdf:li>\n\
        </rdf:Alt>\n\
      </dc:description>\n\
      <dc:subject>\n\
        <rdf:Bag>\n\
{}        </rdf:Bag>\n\
      </dc:subject>\n\
    </rdf:Description>\n\
  </rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>",
            rating, color_label, captured_at, gps_xml, escaped_caption, subject_xml
        );

        if fs::write(&xmp_path, xmp_content).is_ok() {
            exported += 1;
        }
    }

    Ok(exported)
}

#[tauri::command]
pub fn get_library_health_stats(app: AppHandle, root_folder: Option<String>) -> Result<LibraryHealthStats, String> {
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(root_folder.as_deref());

    let total_photos: usize = conn
        .query_row("SELECT COUNT(*) FROM photos WHERE current_path LIKE ?1", params![prefix], |r| r.get(0))
        .unwrap_or(0);
    let total_bytes: i64 = conn
        .query_row("SELECT COALESCE(SUM(file_size), 0) FROM photos WHERE current_path LIKE ?1", params![prefix], |r| r.get(0))
        .unwrap_or(0);

    let (trash_cnt, trash_bytes): (usize, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(file_size), 0) FROM photos WHERE (staged_target = '_Trash' OR subfolder = '_Trash') AND current_path LIKE ?1",
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

    let mut camera_breakdown = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT CASE WHEN camera_model = '' OR camera_model IS NULL THEN 'Unknown / No EXIF' ELSE camera_model END as cam,
                COUNT(*) as cnt
         FROM photos WHERE current_path LIKE ?1 GROUP BY cam ORDER BY cnt DESC LIMIT 8",
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
    })
}

#[tauri::command]
pub fn prune_orphaned_cache(app: AppHandle) -> Result<usize, String> {
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

pub fn move_file_to_os_trash(p: &Path) -> bool {
    if !p.exists() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let escaped = p.to_string_lossy().replace('\'', "''");
        let ps_cmd = format!(
            "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('{}', 'OnlyErrorDialogs', 'SendToRecycleBin')",
            escaped
        );
        if let Ok(status) = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
        {
            if status.success() {
                return true;
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(status) = std::process::Command::new("gio")
            .arg("trash")
            .arg(p.as_os_str())
            .status()
        {
            if status.success() {
                return true;
            }
        }
        if let Ok(status) = std::process::Command::new("kioclient5")
            .args(["move", &p.to_string_lossy(), "trash:/"])
            .status()
        {
            if status.success() {
                return true;
            }
        }
    }
    fs::remove_file(p).is_ok()
}

#[tauri::command]
pub fn empty_library_trash_to_os(app: AppHandle, root_folder: String) -> Result<usize, String> {
    let mut conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(Some(&root_folder));

    let targets: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT hash, current_path FROM photos
                 WHERE (subfolder = '_Trash' OR staged_target = '_Trash') AND current_path LIKE ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![prefix], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };

    if targets.is_empty() {
        return Ok(0);
    }

    let mut deleted_hashes = Vec::new();
    for (hash, path_str) in targets {
        let p = Path::new(&path_str);
        if move_file_to_os_trash(p) {
            deleted_hashes.push(hash);
        }
    }

    let count = deleted_hashes.len();
    if let Ok(tx) = conn.transaction() {
        for h in &deleted_hashes {
            let _ = tx.execute("DELETE FROM photos WHERE hash = ?1", params![h]);
            let _ = tx.execute("DELETE FROM photo_tags WHERE hash = ?1", params![h]);
            let _ = tx.execute("DELETE FROM photo_people WHERE hash = ?1", params![h]);
            let _ = tx.execute("DELETE FROM photo_faces WHERE hash = ?1", params![h]);
        }
        let _ = tx.commit();
    }

    // If the physical _Trash directory is now empty, remove it cleanly
    let trash_dir = Path::new(&root_folder).join("_Trash");
    if trash_dir.exists() {
        let _ = fs::remove_dir(&trash_dir);
    }

    Ok(count)
}
