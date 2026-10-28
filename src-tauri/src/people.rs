use crate::*;

// People: the people list, tagging photos with a person, rename / merge / hide, profile pictures

#[tauri::command]
pub async fn get_people(app: AppHandle, root_folder: Option<String>) -> Result<Vec<PersonItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let prefix = make_folder_prefix(root_folder.as_deref());
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.name, COUNT(DISTINCT pp.hash) as cnt,
                        COALESCE(NULLIF(p.cover_face_thumb, ''), '') as face_crop,
                        MIN(pp.hash) as fallback_hash, COALESCE(p.hidden, 0), COALESCE(p.starred, 0)
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
                    starred: row.get::<_, i32>(6)? != 0,
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
        // Starred if either of the two was
        tx.execute(
            "UPDATE people SET starred = 1
             WHERE lower(name) = lower(?2) AND EXISTS (SELECT 1 FROM people WHERE lower(name) = lower(?1) AND starred = 1)",
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

#[tauri::command]
pub fn set_person_starred(app: AppHandle, name: String, starred: bool) -> Result<(), String> {
    let conn = open_global_db(&app)?;
    conn.execute(
        "UPDATE people SET starred = ?2 WHERE lower(name) = lower(?1)",
        params![name.trim(), starred as i32],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// Profile picture: one of the person's named faces becomes their avatar in the People list
#[tauri::command]
pub fn set_person_cover(app: AppHandle, name: String, face_id: String) -> Result<(), String> {
    let conn = open_global_db(&app)?;
    let thumb: String = conn
        .query_row(
            "SELECT face_thumb FROM photo_faces WHERE face_id = ?1 AND lower(person_name) = lower(?2)",
            params![face_id, name.trim()],
            |r| r.get(0),
        )
        .map_err(|_| "That face is not (or no longer) named after this person".to_string())?;
    if thumb.is_empty() || !Path::new(&thumb).exists() {
        return Err("This face has no saved crop; pick another one".into());
    }
    conn.execute(
        "UPDATE people SET cover_face_thumb = ?1 WHERE lower(name) = lower(?2)",
        params![thumb, name.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
