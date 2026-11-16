// A revision per photo: a number that goes up whenever something a listing shows about the photo changes (its
// row, its tags, its people, its faces). A server that keeps a library's list ready (lumina-server's
// listing.rs) asks which photos have a revision above the one its list was made at, and reads only those
// again. The database keeps it up to date itself, with triggers, so no code that writes can forget to.
//
// Only real changes count: a scan that writes the same values again moves nothing.
use rusqlite::{params, Connection};

// The columns of `photos` a listing shows (scan::load_index), and thumb_edge, which changes when the
// thumbnail is made
const PHOTO_COLUMNS: &[&str] = &[
    "hash",
    "current_path",
    "library_id",
    "file_size",
    "width",
    "height",
    "rating",
    "flag",
    "color_label",
    "rotation",
    "in_basket",
    "ai_caption",
    "ocr_text",
    "captured_at",
    "camera_model",
    "location",
    "latitude",
    "longitude",
    "dhash",
    "sharpness",
    "staged_target",
    "focal_length",
    "aperture",
    "shutter_speed",
    "iso",
    "lens_model",
    "damaged",
    "thumb_edge",
    "duration_ms",
    "video_codec",
];

// What a listing shows of a face (not its embedding, which is rewritten in bulk when faces are re-read)
const FACE_COLUMNS: &str = "hash, bbox_x, bbox_y, bbox_w, bbox_h, person_name, face_thumb, confidence, eyes_open, face_sharpness";

// Run with every migration (db::migrate), after the columns above exist
pub fn migrate(conn: &Connection) -> Result<(), String> {
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN rev INTEGER NOT NULL DEFAULT 0", []);
    let bump = |hash: &str| format!("UPDATE revision SET n = n + 1; UPDATE photos SET rev = (SELECT n FROM revision) WHERE hash = {hash};");
    let differs: Vec<String> = PHOTO_COLUMNS.iter().map(|c| format!("NEW.{c} IS NOT OLD.{c}")).collect();
    let mut sql = format!(
        "CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
         INSERT OR IGNORE INTO revision (id, n) VALUES (1, 0);
         CREATE INDEX IF NOT EXISTS idx_photos_rev ON photos(rev);
         CREATE TRIGGER IF NOT EXISTS photos_rev_insert AFTER INSERT ON photos BEGIN {new} END;
         CREATE TRIGGER IF NOT EXISTS photos_rev_update AFTER UPDATE OF {columns} ON photos WHEN {differs} BEGIN {new} END;
         CREATE TRIGGER IF NOT EXISTS faces_rev_update AFTER UPDATE OF {FACE_COLUMNS} ON photo_faces BEGIN {new} {old} END;",
        new = bump("NEW.hash"),
        old = bump("OLD.hash"),
        columns = PHOTO_COLUMNS.join(", "),
        differs = differs.join(" OR "),
    );
    for (table, name) in [("photo_tags", "tags"), ("photo_people", "people"), ("photo_faces", "faces")] {
        sql.push_str(&format!(
            "CREATE TRIGGER IF NOT EXISTS {name}_rev_insert AFTER INSERT ON {table} BEGIN {new} END;
             CREATE TRIGGER IF NOT EXISTS {name}_rev_delete AFTER DELETE ON {table} BEGIN {old} END;",
            new = bump("NEW.hash"),
            old = bump("OLD.hash"),
        ));
        if table != "photo_faces" {
            sql.push_str(&format!(
                "CREATE TRIGGER IF NOT EXISTS {name}_rev_update AFTER UPDATE ON {table} BEGIN {new} {old} END;",
                new = bump("NEW.hash"),
                old = bump("OLD.hash"),
            ));
        }
    }
    conn.execute_batch(&sql).map_err(|e| format!("The photo revisions could not be set up: {e}"))
}

// The newest revision any photo has
pub fn current(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT n FROM revision", [], |r| r.get(0)).map_err(|e| e.to_string())
}

// The photos changed after revision `since`, in any library. None when there are more than `most`: the
// caller is then better off reading everything.
pub fn changed_since(conn: &Connection, since: i64, most: usize) -> Result<Option<Vec<String>>, String> {
    let mut stmt = conn.prepare("SELECT hash FROM photos WHERE rev > ?1 LIMIT ?2").map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![since, most as i64 + 1], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    let hashes: Vec<String> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    Ok((hashes.len() <= most).then_some(hashes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_photos_revision_follows_what_a_listing_shows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        // On every open, as the app does
        crate::db::migrate(&conn).unwrap();
        let rev = |hash: &str| conn.query_row("SELECT rev FROM photos WHERE hash = ?1", [hash], |r| r.get::<_, i64>(0)).unwrap();
        let run = |sql: &str| conn.execute_batch(sql).unwrap();
        // Each step: the statement, and whether photo a's revision moves
        run("INSERT INTO photos (hash, current_path) VALUES ('a', '/lib/a.jpg'), ('b', '/lib/b.jpg')");
        assert!(rev("a") > 0 && rev("b") > rev("a"));
        let steps = [
            ("UPDATE photos SET rating = 3 WHERE hash = 'a'", true),
            ("UPDATE photos SET rating = 3 WHERE hash = 'a'", false),
            ("UPDATE photos SET rating = 3, ai_caption = COALESCE(ai_caption, ''), latitude = NULL WHERE hash = 'a'", false),
            ("UPDATE photos SET latitude = 51.2 WHERE hash = 'a'", true),
            ("UPDATE photos SET modified_time = 5, exif_checked = 1 WHERE hash = 'a'", false),
            ("UPDATE photos SET thumb_edge = 480 WHERE hash = 'a'", true),
            ("INSERT INTO photo_tags (hash, tag) VALUES ('a', 'beach')", true),
            ("INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES ('a', 'beach')", false),
            ("DELETE FROM photo_tags WHERE hash = 'a'", true),
            ("INSERT INTO photo_people (hash, person_name) VALUES ('a', 'Anna')", true),
            ("UPDATE photo_people SET person_name = 'Anne' WHERE person_name = 'Anna'", true),
            ("INSERT INTO photo_faces (face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, face_thumb, embedding) VALUES ('f1', 'a', 0, 0, 1, 1, 't.jpg', '')", true),
            ("UPDATE photo_faces SET person_name = 'Anne' WHERE face_id = 'f1'", true),
            ("UPDATE photo_faces SET embedding_blob = x'00', engine = 'v2' WHERE face_id = 'f1'", false),
            ("DELETE FROM photo_faces WHERE face_id = 'f1'", true),
            ("UPDATE photos SET rating = 1 WHERE hash = 'b'", false),
        ];
        for (sql, moves) in steps {
            let (before, b) = (rev("a"), rev("b"));
            run(sql);
            assert_eq!(rev("a") > before, moves, "{sql}");
            assert!(rev("a") <= current(&conn).unwrap() && rev("b") >= b);
        }
        // The newest change is b's
        let newest = current(&conn).unwrap();
        assert_eq!(rev("b"), newest);
        assert_eq!(changed_since(&conn, newest - 1, 10).unwrap(), Some(vec!["b".to_string()]));
        assert_eq!(changed_since(&conn, newest, 10).unwrap(), Some(vec![]));
        assert_eq!(changed_since(&conn, 0, 1).unwrap(), None, "more than the caller wants one by one");
    }
}
