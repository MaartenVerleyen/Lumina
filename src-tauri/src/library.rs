use crate::*;

// ----------------- OFFLINE CITY SEARCH & MANUAL LOCATION -----------------

#[tauri::command]
pub fn search_cities_offline(query: String) -> Result<Vec<CitySearchResult>, String> {
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return Ok(Vec::new());
    }

    let known_cities: &[(&str, &str, f64, f64)] = &[
        ("Brussels", "BE", 50.8503, 4.3517),
        ("Meise", "BE", 50.9333, 4.3333),
        ("Antwerp", "BE", 51.2194, 4.4025),
        ("Ghent", "BE", 51.0543, 3.7174),
        ("Bruges", "BE", 51.2093, 3.2247),
        ("Leuven", "BE", 50.8798, 4.7005),
        ("Liege", "BE", 50.6326, 5.5797),
        ("Namur", "BE", 50.4674, 4.8720),
        ("Paris", "FR", 48.8566, 2.3522),
        ("Alpe d'Huez", "FR", 45.0922, 6.0694),
        ("Nice", "FR", 43.7102, 7.2620),
        ("Lyon", "FR", 45.7640, 4.8357),
        ("Marseille", "FR", 43.2965, 5.3698),
        ("Amsterdam", "NL", 52.3676, 4.9041),
        ("Rotterdam", "NL", 51.9244, 4.4777),
        ("London", "GB", 51.5074, -0.1278),
        ("Berlin", "DE", 52.5200, 13.4050),
        ("Munich", "DE", 48.1351, 11.5820),
        ("Rome", "IT", 41.9028, 12.4964),
        ("Milan", "IT", 45.4642, 9.1900),
        ("Florence", "IT", 43.7696, 11.2558),
        ("Venice", "IT", 45.4408, 12.3155),
        ("Madrid", "ES", 40.4168, -3.7038),
        ("Barcelona", "ES", 41.3851, 2.1734),
        ("New York", "US", 40.7128, -74.0060),
        ("San Francisco", "US", 37.7749, -122.4194),
        ("Los Angeles", "US", 34.0522, -118.2437),
        ("Tokyo", "JP", 35.6762, 139.6503),
    ];

    let mut matches = Vec::new();
    for &(name, cc, lat, lon) in known_cities {
        if name.to_lowercase().contains(&q) || cc.to_lowercase() == q {
            matches.push(CitySearchResult {
                name: name.to_string(),
                country: cc.to_string(),
                latitude: lat,
                longitude: lon,
            });
        }
    }

    Ok(matches)
}

#[tauri::command]
pub fn set_manual_location(
    app: AppHandle,
    hashes: Vec<String>,
    location: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<(), String> {
    let clean_loc = location.trim().to_string();
    let mut conn = open_global_db(&app)?;

    let (final_loc, final_lat, final_lon) = if let (Some(lat), Some(lon)) = (latitude, longitude) {
        let rev = GEOCODER.search((lat, lon));
        let loc_name = if clean_loc.is_empty() {
            format!("{}, {}", rev.record.name, rev.record.cc)
        } else {
            clean_loc
        };
        (loc_name, Some(lat), Some(lon))
    } else {
        (clean_loc, latitude, longitude)
    };

    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let _ = tx.execute(
                "UPDATE photos SET location = ?1, latitude = ?2, longitude = ?3 WHERE hash = ?4",
                params![final_loc, final_lat, final_lon, h],
            );
        }
        let _ = tx.commit();
    }

    Ok(())
}

// ----------------- PICK/REJECT FLAGS, COLOR LABELS & ROTATION -----------------

#[tauri::command]
pub fn set_photo_flag(app: AppHandle, hashes: Vec<String>, flag: Option<String>) -> Result<(), String> {
    let mut conn = open_global_db(&app)?;
    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let _ = tx.execute(
                "UPDATE photos SET flag = ?1 WHERE hash = ?2",
                params![flag, h],
            );
        }
        let _ = tx.commit();
    }
    Ok(())
}

#[tauri::command]
pub fn set_photo_color_label(app: AppHandle, hashes: Vec<String>, color: Option<String>) -> Result<(), String> {
    let mut conn = open_global_db(&app)?;
    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let _ = tx.execute(
                "UPDATE photos SET color_label = ?1 WHERE hash = ?2",
                params![color, h],
            );
        }
        let _ = tx.commit();
    }
    Ok(())
}

#[tauri::command]
pub fn set_photo_rotation(app: AppHandle, hashes: Vec<String>, delta_degrees: i32) -> Result<HashMap<String, i32>, String> {
    let mut conn = open_global_db(&app)?;
    let mut out = HashMap::new();

    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let cur: i32 = tx
                .query_row("SELECT COALESCE(rotation, 0) FROM photos WHERE hash = ?1", params![h], |r| r.get(0))
                .unwrap_or(0);
            let next = (cur + delta_degrees).rem_euclid(360);
            let _ = tx.execute("UPDATE photos SET rotation = ?1 WHERE hash = ?2", params![next, h]);
            out.insert(h, next);
        }
        let _ = tx.commit();
    }

    Ok(out)
}

#[derive(Deserialize)]
pub struct RotationResetInput {
    pub hash: String,
    pub rotation: i32,
}

#[tauri::command]
pub fn set_photos_rotation_exact(app: AppHandle, ops: Vec<RotationResetInput>) -> Result<(), String> {
    if ops.is_empty() {
        return Ok(());
    }
    let mut conn = open_global_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE photos SET rotation = ?1 WHERE hash = ?2")
            .map_err(|e| e.to_string())?;
        for op in &ops {
            let _ = stmt.execute(params![op.rotation.rem_euclid(360), op.hash]);
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ----------------- NON-DESTRUCTIVE STAGING & DISMISS -----------------

#[derive(Deserialize)]
pub struct StagedMoveInput {
    pub hash: String,
    pub target_subfolder: Option<String>,
}

#[tauri::command]
pub fn stage_photo_move(app: AppHandle, hash: String, target_subfolder: Option<String>) -> Result<(), String> {
    let conn = open_global_db(&app)?;
    conn.execute(
        "UPDATE photos SET staged_target = ?1 WHERE hash = ?2",
        params![target_subfolder, hash],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn stage_photos_move(app: AppHandle, ops: Vec<StagedMoveInput>) -> Result<usize, String> {
    if ops.is_empty() {
        return Ok(0);
    }
    let mut conn = open_global_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE photos SET staged_target = ?1 WHERE hash = ?2")
            .map_err(|e| e.to_string())?;
        for op in &ops {
            let _ = stmt.execute(params![op.target_subfolder, op.hash]);
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ops.len())
}

#[tauri::command]
pub fn clear_all_staged(app: AppHandle, root_folder: Option<String>) -> Result<usize, String> {
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(root_folder.as_deref());
    let count = conn
        .execute(
            "UPDATE photos SET staged_target = NULL WHERE staged_target IS NOT NULL AND current_path LIKE ?1 ESCAPE '!'",
            params![prefix],
        )
        .map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub fn get_staged_operations(app: AppHandle, root_folder: Option<String>) -> Result<Vec<StagedOperation>, String> {
    let conn = open_global_db(&app)?;
    let prefix = make_folder_prefix(root_folder.as_deref());
    let mut stmt = conn
        .prepare("SELECT hash, current_path, staged_target FROM photos WHERE staged_target IS NOT NULL AND current_path LIKE ?1 ESCAPE '!'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![prefix], |row| {
            let p_str: String = row.get(1)?;
            let path = Path::new(&p_str);
            let fname = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            Ok(StagedOperation {
                hash: row.get(0)?,
                current_path: p_str,
                target_subfolder: row.get(2)?,
                filename: fname,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
}

// ----------------- PHASE 2: QUICK PINBOARD BASKET, CLOCK SHIFT, XMP EXPORT & HEALTH -----------------

#[tauri::command]
pub fn set_photo_basket(app: AppHandle, hashes: Vec<String>, in_basket: bool) -> Result<(), String> {
    let mut conn = open_global_db(&app)?;
    let val = if in_basket { 1 } else { 0 };
    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let _ = tx.execute(
                "UPDATE photos SET in_basket = ?1 WHERE hash = ?2",
                params![val, h],
            );
        }
        let _ = tx.commit();
    }
    Ok(())
}

pub fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

pub fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap_year(y) { 29 } else { 28 },
        _ => 30,
    }
}

pub fn shift_exif_datetime_str(raw: &str, offset_minutes: i64) -> Option<String> {
    let clean = raw.trim();
    if clean.len() < 16 {
        return None;
    }
    let y: i64 = clean.get(0..4)?.parse().ok()?;
    let m: i64 = clean.get(5..7)?.parse().ok()?;
    let d: i64 = clean.get(8..10)?.parse().ok()?;
    let hh: i64 = clean.get(11..13)?.parse().ok()?;
    let mm: i64 = clean.get(14..16)?.parse().ok()?;
    let ss: i64 = clean.get(17..19).and_then(|s| s.parse().ok()).unwrap_or(0);

    let mut total_minutes = hh * 60 + mm + offset_minutes;
    let day_delta = total_minutes.div_euclid(1440);
    total_minutes = total_minutes.rem_euclid(1440);

    let new_hh = total_minutes / 60;
    let new_mm = total_minutes % 60;

    let mut cur_y = y;
    let mut cur_m = m;
    let mut cur_d = d + day_delta;

    while cur_d > days_in_month(cur_y, cur_m) {
        cur_d -= days_in_month(cur_y, cur_m);
        cur_m += 1;
        if cur_m > 12 {
            cur_m = 1;
            cur_y += 1;
        }
    }
    while cur_d < 1 {
        cur_m -= 1;
        if cur_m < 1 {
            cur_m = 12;
            cur_y -= 1;
        }
        cur_d += days_in_month(cur_y, cur_m);
    }

    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        cur_y, cur_m, cur_d, new_hh, new_mm, ss
    ))
}

#[tauri::command]
pub fn shift_capture_timestamps(
    app: AppHandle,
    hashes: Vec<String>,
    offset_minutes: i64,
) -> Result<Vec<TimestampShiftResult>, String> {
    let mut conn = open_global_db(&app)?;
    let mut out = Vec::new();

    if let Ok(tx) = conn.transaction() {
        for h in hashes {
            let cur_dt: String = tx
                .query_row(
                    "SELECT COALESCE(captured_at, '') FROM photos WHERE hash = ?1",
                    params![h],
                    |r| r.get(0),
                )
                .unwrap_or_default();

            if let Some(shifted) = shift_exif_datetime_str(&cur_dt, offset_minutes) {
                let _ = tx.execute(
                    "UPDATE photos SET captured_at = ?1 WHERE hash = ?2",
                    params![shifted, h],
                );
                out.push(TimestampShiftResult {
                    hash: h,
                    captured_at: shifted,
                });
            }
        }
        let _ = tx.commit();
    }

    Ok(out)
}

// ----------------- CORE DATA COMMANDS -----------------

#[tauri::command]
pub fn set_photos_rating(app: AppHandle, hashes: Vec<String>, rating: i32) -> Result<(), String> {
    if hashes.is_empty() {
        return Ok(());
    }
    let mut conn = open_global_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE photos SET rating = ?1 WHERE hash = ?2")
            .map_err(|e| e.to_string())?;
        for h in &hashes {
            let _ = stmt.execute(params![rating, h]);
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn add_tag_batch(app: AppHandle, hashes: Vec<String>, tag: String) -> Result<String, String> {
    let clean_tag = tag.trim().to_lowercase();
    if clean_tag.is_empty() {
        return Err("Tag cannot be empty".into());
    }
    if hashes.is_empty() {
        return Ok(clean_tag);
    }
    let mut conn = open_global_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for h in &hashes {
            let _ = stmt.execute(params![h, clean_tag]);
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(clean_tag)
}

#[tauri::command]
pub fn remove_tag(app: AppHandle, hash: String, tag: String) -> Result<Vec<String>, String> {
    let conn = open_global_db(&app)?;
    conn.execute(
        "DELETE FROM photo_tags WHERE hash = ?1 AND tag = ?2",
        params![hash, tag],
    )
    .map_err(|e| e.to_string())?;

    get_tags_for_hash(&conn, &hash)
}

pub fn get_tags_for_hash(conn: &Connection, hash: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT tag FROM photo_tags WHERE hash = ?1 ORDER BY tag ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![hash], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}
