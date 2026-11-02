use crate::*;

// The schema is checked and migrated once per process, by the first open
static DB_SCHEMA_READY: AtomicBool = AtomicBool::new(false);

pub fn get_app_storage_dir<H: Host + ?Sized>(app: &H) -> PathBuf {
    let base = app.data_dir();
    let _ = fs::create_dir_all(&base);
    base
}

pub fn open_global_db<H: Host + ?Sized>(app: &H) -> Result<Connection, String> {
    let app_dir = get_app_storage_dir(app);
    let db_path = app_dir.join("library.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| e.to_string())?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -32000;",
    )
    .map_err(|e| e.to_string())?;

    if DB_SCHEMA_READY.load(Ordering::Acquire) {
        return Ok(conn);
    }

        conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS photos (
            hash TEXT PRIMARY KEY,
            current_path TEXT,
            subfolder TEXT,
            file_size INTEGER DEFAULT 0,
            modified_time INTEGER DEFAULT 0,
            width INTEGER DEFAULT 0,
            height INTEGER DEFAULT 0,
            rating INTEGER DEFAULT 0,
            flag TEXT DEFAULT NULL,
            color_label TEXT DEFAULT NULL,
            rotation INTEGER DEFAULT 0,
            in_basket INTEGER DEFAULT 0,
            ai_caption TEXT DEFAULT '',
            ocr_text TEXT DEFAULT '',
            captured_at TEXT DEFAULT '',
            camera_model TEXT DEFAULT '',
            location TEXT DEFAULT '',
            latitude REAL,
            longitude REAL,
            dhash TEXT DEFAULT '',
            sharpness REAL DEFAULT 0.0,
            staged_target TEXT DEFAULT NULL,
            exif_checked INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS photo_tags (
            hash TEXT,
            tag TEXT,
            PRIMARY KEY (hash, tag)
        );
        CREATE TABLE IF NOT EXISTS people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            cover_face_thumb TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS photo_people (
            hash TEXT,
            person_name TEXT,
            PRIMARY KEY (hash, person_name)
        );
        CREATE TABLE IF NOT EXISTS photo_faces (
            face_id TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            bbox_x REAL NOT NULL,
            bbox_y REAL NOT NULL,
            bbox_w REAL NOT NULL,
            bbox_h REAL NOT NULL,
            person_name TEXT,
            face_thumb TEXT NOT NULL,
            embedding TEXT NOT NULL,
            confidence REAL DEFAULT 1.0,
            source TEXT DEFAULT 'user'
        );
        CREATE TABLE IF NOT EXISTS face_rejections (
            face_id TEXT NOT NULL,
            person_name TEXT NOT NULL,
            PRIMARY KEY (face_id, person_name)
        );",
    )
    .map_err(|e| e.to_string())?;

    let _ = conn.execute("ALTER TABLE photos ADD COLUMN flag TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN color_label TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN rotation INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN in_basket INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN ocr_text TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN latitude REAL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN longitude REAL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN dhash TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN sharpness REAL DEFAULT 0.0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN staged_target TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN exif_checked INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN width INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN height INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN focal_length TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN aperture TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN shutter_speed TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN iso TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN lens_model TEXT DEFAULT NULL", []);
    let _ = conn.execute("ALTER TABLE people ADD COLUMN cover_face_thumb TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE photo_faces ADD COLUMN source TEXT DEFAULT 'user'", []);
    // 1 = the file is damaged (e.g. truncated); its thumbnail was recovered from the partial data or failed
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN damaged INTEGER DEFAULT 0", []);
    // Long edge the cached thumbnail was made at (0 = before 480 px thumbnails): older ones are regenerated
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN thumb_edge INTEGER DEFAULT 0", []);
    // Face engine v2: which engine produced the embedding (vectors of different engines are never compared)
    // and the embedding itself as little-endian f32 bytes
    let _ = conn.execute("ALTER TABLE photo_faces ADD COLUMN engine TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE photo_faces ADD COLUMN embedding_blob BLOB", []);
    // Culling: eye opening and focus per face (NULL until measured)
    let _ = conn.execute("ALTER TABLE photo_faces ADD COLUMN eyes_open REAL", []);
    let _ = conn.execute("ALTER TABLE photo_faces ADD COLUMN face_sharpness REAL", []);
    // Videos live in the same table: 'video' rows have a length (ms) and the codec named in their container
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN media_type TEXT DEFAULT 'photo'", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN duration_ms INTEGER", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN video_codec TEXT", []);

    ensure_album_tables(&conn);
    // Hidden people: kept on their photos, left out of the people bar and of suggestions
    let _ = conn.execute("ALTER TABLE people ADD COLUMN hidden INTEGER DEFAULT 0", []);
    // Starred people: Best of favours photos with them
    let _ = conn.execute("ALTER TABLE people ADD COLUMN starred INTEGER DEFAULT 0", []);

    // One-time clean-ups, in order; PRAGMA user_version records how many have run
    let done: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
    if done < 1 {
        // Up to 4.0.1 every photo of a screen size was tagged "screenshot", JPEGs included (mostly WhatsApp
        // and phone photos at 1080 x 1920). Only PNG and WebP count now: drop the tag those JPEGs got that way.
        let sizes: Vec<String> = crate::imaging::SCREEN_SIZES
            .iter()
            .flat_map(|&(w, h)| [format!("(width = {w} AND height = {h})"), format!("(width = {h} AND height = {w})")])
            .collect();
        let _ = conn.execute(
            &format!(
                "DELETE FROM photo_tags WHERE tag = 'screenshot' AND hash IN (
                   SELECT hash FROM photos WHERE ({})
                     AND lower(current_path) NOT LIKE '%.png' AND lower(current_path) NOT LIKE '%.webp'
                     AND lower(current_path) NOT LIKE '%screenshot%' AND lower(current_path) NOT LIKE '%screen shot%'
                     AND lower(current_path) NOT LIKE '%schermopname%' AND lower(current_path) NOT LIKE '%schermafbeelding%'
                     AND lower(current_path) NOT LIKE '%capture%' AND lower(current_path) NOT LIKE '%snip%')",
                sizes.join(" OR ")
            ),
            [],
        );
        let _ = conn.execute_batch("PRAGMA user_version = 1");
    }

    // Smart search: one CLIP image vector per photo (little-endian f32), tagged with the model that made it
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS photo_clip (hash TEXT PRIMARY KEY, embedding BLOB NOT NULL, model TEXT NOT NULL)",
        [],
    );
    // Videos: one vector per stored frame (search scores a video by its best frame; photo_clip holds their mean)
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS photo_clip_frames (hash TEXT NOT NULL, frame INTEGER NOT NULL, embedding BLOB NOT NULL,
            model TEXT NOT NULL, PRIMARY KEY (hash, frame))",
        [],
    );

    // Phase 2: Create high-speed covering indexes for folder-scoped & hash lookups
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_photos_path ON photos(current_path);
         CREATE INDEX IF NOT EXISTS idx_photos_captured ON photos(captured_at);
         CREATE INDEX IF NOT EXISTS idx_photos_staged ON photos(staged_target);
         CREATE INDEX IF NOT EXISTS idx_photos_subfolder ON photos(subfolder);
         CREATE INDEX IF NOT EXISTS idx_tags_tag ON photo_tags(tag);
         CREATE INDEX IF NOT EXISTS idx_tags_hash ON photo_tags(hash);
         CREATE INDEX IF NOT EXISTS idx_people_hash ON photo_people(hash);
         CREATE INDEX IF NOT EXISTS idx_faces_hash ON photo_faces(hash);
         CREATE INDEX IF NOT EXISTS idx_photos_media ON photos(media_type);",
    );

    DB_SCHEMA_READY.store(true, Ordering::Release);

    Ok(conn)
}

// LIKE pattern matching only files inside `root_folder` (never a sibling such as `Photos2` for `Photos`).
// Wildcard characters in folder names are escaped, so every query must use `LIKE ?n ESCAPE '!'`.
pub fn make_folder_prefix(root_folder: Option<&str>) -> String {
    match root_folder {
        Some(f) if !f.trim().is_empty() => {
            let root = f.trim().trim_end_matches(['\\', '/']);
            let escaped = root.replace('!', "!!").replace('%', "!%").replace('_', "!_");
            format!("{}{}%", escaped, std::path::MAIN_SEPARATOR)
        }
        _ => "%".to_string(),
    }
}

// Albums, trips' names and saved searches
pub fn ensure_album_tables(conn: &Connection) {
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS albums (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );
         CREATE TABLE IF NOT EXISTS album_photos (
            album_id INTEGER NOT NULL,
            hash TEXT NOT NULL,
            added_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            PRIMARY KEY (album_id, hash)
         );
         CREATE INDEX IF NOT EXISTS idx_album_photos_hash ON album_photos(hash);
         CREATE TABLE IF NOT EXISTS trip_names (
            trip_id TEXT PRIMARY KEY,
            name TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS saved_searches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            query TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );",
    );
}
