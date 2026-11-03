// Who changed what: one row per editing command and photo (no payloads), so a photo's history can say
// "Anna rated this, Bob tagged it". Written by the server only; the desktop app has no users.
use rusqlite::{params, Connection};
use serde::Serialize;

pub fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS changes (
            id INTEGER PRIMARY KEY,
            at INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            hash TEXT NOT NULL,
            what TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_changes_hash ON changes(hash, at);",
    )
    .map_err(|e| e.to_string())
}

pub fn record(conn: &mut Connection, user_id: i64, hashes: &[String], what: &str) -> Result<(), String> {
    if hashes.is_empty() {
        return Ok(());
    }
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut insert = tx
            .prepare_cached("INSERT INTO changes (at, user_id, hash, what) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| e.to_string())?;
        for hash in hashes {
            insert.execute(params![at, user_id, hash, what]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Change {
    // Seconds since 1970
    pub at: i64,
    // The user's name, or "" for a removed account
    pub user: String,
    // The command, e.g. "set_photos_rating"
    pub what: String,
}

// A photo's history, newest first (at most `limit` rows)
pub fn history(conn: &Connection, hash: &str, limit: usize) -> Result<Vec<Change>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.at, COALESCE(u.name, ''), c.what FROM changes c LEFT JOIN users u ON u.id = c.user_id
             WHERE c.hash = ?1 ORDER BY c.at DESC, c.id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![hash, limit as i64], |r| Ok(Change { at: r.get(0)?, user: r.get(1)?, what: r.get(2)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_photos_history_names_who_did_what_newest_first() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::accounts::ensure_tables(&conn).unwrap();
        let anna = crate::accounts::create_user(&conn, "anna", crate::accounts::Role::Editor, "long enough").unwrap();
        record(&mut conn, anna.id, &["h1".into(), "h2".into()], "set_photos_rating").unwrap();
        record(&mut conn, anna.id, &["h1".into()], "add_tag_batch").unwrap();
        record(&mut conn, 999, &["h1".into()], "set_photo_flag").unwrap();
        let h1 = history(&conn, "h1", 10).unwrap();
        assert_eq!(h1.iter().map(|c| (c.user.as_str(), c.what.as_str())).collect::<Vec<_>>(), vec![
            ("", "set_photo_flag"),
            ("anna", "add_tag_batch"),
            ("anna", "set_photos_rating"),
        ]);
        assert_eq!(history(&conn, "h2", 10).unwrap().len(), 1);
        assert_eq!(history(&conn, "h1", 1).unwrap().len(), 1);
    }
}
