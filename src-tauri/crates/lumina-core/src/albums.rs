use crate::*;

// ----------------- ALBUMS & SMART ALBUMS -----------------
// Albums are named, hand-picked collections; they live in the global database, so one album can hold
// photos from several library folders. Smart albums are saved searches (the query text is re-run live).

#[derive(Serialize)]
pub struct Album {
    pub id: i64,
    pub name: String,
    pub hashes: Vec<String>,
}

#[derive(Serialize)]
pub struct SavedSearch {
    pub id: i64,
    pub name: String,
    pub query: String,
    // Free text runs as smart search (it was on when the search was saved)
    pub smart: bool,
}

fn clean_name(name: &str) -> Result<String, String> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err("The name can't be empty".into());
    }
    Ok(clean.chars().take(80).collect())
}

fn unique_error(e: rusqlite::Error, what: &str, name: &str) -> String {
    if e.to_string().contains("UNIQUE") {
        format!("There is already a {what} called \"{name}\"")
    } else {
        e.to_string()
    }
}

// Every album with all of its photos (the UI filters to the open folder); oldest album first
pub fn get_albums(app: SharedHost) -> Result<Vec<Album>, String> {
    let conn = open_global_db(&app)?;
    let mut albums: Vec<Album> = {
        let mut stmt = conn.prepare("SELECT id, name FROM albums ORDER BY created_at, id").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok(Album { id: r.get(0)?, name: r.get(1)?, hashes: Vec::new() }))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    let by_id: HashMap<i64, usize> = albums.iter().enumerate().map(|(i, a)| (a.id, i)).collect();
    let mut stmt = conn
        .prepare("SELECT album_id, hash FROM album_photos ORDER BY added_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for (album_id, hash) in rows.flatten() {
        if let Some(&i) = by_id.get(&album_id) {
            albums[i].hashes.push(hash);
        }
    }
    Ok(albums)
}

pub fn create_album(app: SharedHost, name: String) -> Result<i64, String> {
    let name = clean_name(&name)?;
    let conn = open_global_db(&app)?;
    conn.execute("INSERT INTO albums (name) VALUES (?1)", params![name])
        .map_err(|e| unique_error(e, "album", &name))?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_album(app: SharedHost, id: i64, name: String) -> Result<(), String> {
    let name = clean_name(&name)?;
    let conn = open_global_db(&app)?;
    conn.execute("UPDATE albums SET name = ?1 WHERE id = ?2", params![name, id])
        .map_err(|e| unique_error(e, "album", &name))?;
    Ok(())
}

// Deletes the album only; its photos stay where they are
pub fn delete_album(app: SharedHost, id: i64) -> Result<(), String> {
    let mut conn = open_global_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM album_photos WHERE album_id = ?1", params![id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM albums WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

// Returns the photos that were newly added (so undo removes only those)
pub fn add_to_album(app: SharedHost, id: i64, hashes: Vec<String>) -> Result<Vec<String>, String> {
    let mut conn = open_global_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut added = Vec::new();
    {
        let mut stmt = tx
            .prepare("INSERT OR IGNORE INTO album_photos (album_id, hash) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for h in &hashes {
            if stmt.execute(params![id, h]).map_err(|e| e.to_string())? > 0 {
                added.push(h.clone());
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(added)
}

// Returns the photos that were actually in the album
pub fn remove_from_album(app: SharedHost, id: i64, hashes: Vec<String>) -> Result<Vec<String>, String> {
    let mut conn = open_global_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut removed = Vec::new();
    {
        let mut stmt = tx
            .prepare("DELETE FROM album_photos WHERE album_id = ?1 AND hash = ?2")
            .map_err(|e| e.to_string())?;
        for h in &hashes {
            if stmt.execute(params![id, h]).map_err(|e| e.to_string())? > 0 {
                removed.push(h.clone());
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(removed)
}

pub fn get_saved_searches(app: SharedHost) -> Result<Vec<SavedSearch>, String> {
    let conn = open_global_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT id, name, query, smart FROM saved_searches ORDER BY created_at, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(SavedSearch { id: r.get(0)?, name: r.get(1)?, query: r.get(2)?, smart: r.get::<_, i64>(3)? != 0 }))
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

pub fn save_search(app: SharedHost, name: String, query: String, smart: bool) -> Result<i64, String> {
    let name = clean_name(&name)?;
    if query.trim().is_empty() {
        return Err("There is no search to save".into());
    }
    let conn = open_global_db(&app)?;
    conn.execute("INSERT INTO saved_searches (name, query, smart) VALUES (?1, ?2, ?3)", params![name, query.trim(), smart])
        .map_err(|e| unique_error(e, "smart album", &name))?;
    Ok(conn.last_insert_rowid())
}

pub fn delete_saved_search(app: SharedHost, id: i64) -> Result<(), String> {
    let conn = open_global_db(&app)?;
    conn.execute("DELETE FROM saved_searches WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

// Custom names for automatically found trips, keyed by the trip id the UI computes
pub fn get_trip_names(app: SharedHost) -> Result<HashMap<String, String>, String> {
    let conn = open_global_db(&app)?;
    let mut stmt = conn.prepare("SELECT trip_id, name FROM trip_names").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

// An empty name goes back to the automatic one
pub fn set_trip_name(app: SharedHost, trip_id: String, name: String) -> Result<(), String> {
    let conn = open_global_db(&app)?;
    if name.trim().is_empty() {
        conn.execute("DELETE FROM trip_names WHERE trip_id = ?1", params![trip_id]).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT OR REPLACE INTO trip_names (trip_id, name) VALUES (?1, ?2)",
            params![trip_id, name.trim()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
