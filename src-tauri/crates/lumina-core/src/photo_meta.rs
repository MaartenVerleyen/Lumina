use crate::*;

// What a photo's values are in one library, taken along when it is backed up to a server
// (docs/plans/one-view.md, Backup). The device collects them from its own library; the server applies them
// to its copy without overwriting what that copy already has: a rating, flag, label or caption only where
// the server has none, tags and albums added, and names put on the faces the server found at the same place.
// The server finds faces only after an upload is scanned, so names for faces it hasn't looked for yet wait
// in `backup_faces` until it has.

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PhotoMeta {
    pub hash: String,
    #[serde(default)]
    pub rating: i64,
    #[serde(default)]
    pub flag: Option<String>,
    #[serde(default)]
    pub color_label: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub albums: Vec<String>,
    // Named faces, with their box (fractions of the picture) and, in a video, the frame
    #[serde(default)]
    pub faces: Vec<NamedFace>,
    // People put on the photo without a face (the photo's people list)
    #[serde(default)]
    pub people: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct NamedFace {
    pub name: String,
    #[serde(default)]
    pub frame: Option<usize>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

// What applying did, for the backup report
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ApplyReport {
    // Photos the values went to
    pub photos: usize,
    // Photos the server doesn't have (their upload didn't arrive)
    pub missing: Vec<String>,
    pub faces_named: usize,
    // Names waiting for the server to find the faces
    pub faces_waiting: usize,
    // Photos with a named face the server didn't find
    pub faces_unplaced: Vec<String>,
}

// Faces whose box overlaps this much are the same face
const SAME_FACE_IOU: f64 = 0.3;

fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS backup_faces (
            hash TEXT NOT NULL,
            name TEXT NOT NULL,
            frame INTEGER,
            x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_backup_faces_hash ON backup_faces(hash);",
    )
    .map_err(|e| e.to_string())
}

fn strings(conn: &Connection, sql: &str, hash: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare_cached(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([hash], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// The values of these photos in this library; photos it doesn't have are left out
pub fn collect(conn: &Connection, hashes: &[String]) -> Result<Vec<PhotoMeta>, String> {
    db::ensure_album_tables(conn);
    let mut out = Vec::with_capacity(hashes.len());
    for hash in hashes {
        let row = conn
            .query_row(
                "SELECT COALESCE(rating, 0), flag, color_label, COALESCE(ai_caption, '') FROM photos WHERE hash = ?1",
                [hash],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?)),
            )
            .optional_row()?;
        let Some((rating, flag, color_label, caption)) = row else { continue };
        let tags = strings(conn, "SELECT tag FROM photo_tags WHERE hash = ?1 ORDER BY tag", hash)?;
        let albums = strings(
            conn,
            "SELECT a.name FROM album_photos ap JOIN albums a ON a.id = ap.album_id WHERE ap.hash = ?1 ORDER BY a.name",
            hash,
        )?;
        let mut faces = Vec::new();
        {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT face_id, person_name, bbox_x, bbox_y, bbox_w, bbox_h FROM photo_faces
                     WHERE hash = ?1 AND COALESCE(person_name, '') != '' AND person_name != ?2 ORDER BY face_id",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![hash, face_review::IGNORED_FACE], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, f64>(3)?, r.get::<_, f64>(4)?, r.get::<_, f64>(5)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (face_id, name, x, y, w, h) = row.map_err(|e| e.to_string())?;
                faces.push(NamedFace { name, frame: video_frames::frame_of_face(&face_id), x, y, w, h });
            }
        }
        let people = strings(conn, "SELECT person_name FROM photo_people WHERE hash = ?1 ORDER BY person_name", hash)?
            .into_iter()
            .filter(|p| !p.is_empty() && p != face_review::IGNORED_FACE && !faces.iter().any(|f| f.name.eq_ignore_ascii_case(p)))
            .collect();
        out.push(PhotoMeta { hash: hash.clone(), rating, flag, color_label, tags, caption, albums, faces, people });
    }
    Ok(out)
}

trait OptionalRow<T> {
    fn optional_row(self) -> Result<Option<T>, String>;
}

impl<T> OptionalRow<T> for rusqlite::Result<T> {
    fn optional_row(self) -> Result<Option<T>, String> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}

// The values on the server's copies (see the top of this file)
pub fn apply(conn: &mut Connection, metas: &[PhotoMeta]) -> Result<ApplyReport, String> {
    ensure_table(conn)?;
    db::ensure_album_tables(conn);
    let mut report = ApplyReport::default();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for m in metas {
        let scanned = tx
            .query_row("SELECT COALESCE(faces_engine, '') != '' FROM photos WHERE hash = ?1", [&m.hash], |r| r.get::<_, bool>(0))
            .optional_row()?;
        let Some(faces_scanned) = scanned else {
            report.missing.push(m.hash.clone());
            continue;
        };
        report.photos += 1;
        let run = |sql: &str, p: &[&dyn rusqlite::ToSql]| tx.execute(sql, p).map_err(|e| e.to_string());
        if m.rating > 0 {
            run("UPDATE photos SET rating = ?1 WHERE hash = ?2 AND COALESCE(rating, 0) = 0", &[&m.rating.clamp(0, 5), &m.hash])?;
        }
        if let Some(flag) = m.flag.as_deref().filter(|f| matches!(*f, "pick" | "reject")) {
            run("UPDATE photos SET flag = ?1 WHERE hash = ?2 AND flag IS NULL", &[&flag, &m.hash])?;
        }
        if let Some(label) = m.color_label.as_deref().filter(|l| !l.is_empty()) {
            run("UPDATE photos SET color_label = ?1 WHERE hash = ?2 AND color_label IS NULL", &[&label, &m.hash])?;
        }
        if !m.caption.trim().is_empty() {
            run(
                "UPDATE photos SET ai_caption = ?1 WHERE hash = ?2 AND COALESCE(ai_caption, '') = ''",
                &[&m.caption.trim(), &m.hash],
            )?;
        }
        for tag in m.tags.iter().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()) {
            run("INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, ?2)", &[&m.hash, &tag])?;
        }
        for album in m.albums.iter().map(|a| a.trim()).filter(|a| !a.is_empty()) {
            let album: String = album.chars().take(80).collect();
            run("INSERT OR IGNORE INTO albums (name) VALUES (?1)", &[&album])?;
            run(
                "INSERT OR IGNORE INTO album_photos (album_id, hash) SELECT id, ?2 FROM albums WHERE name = ?1",
                &[&album, &m.hash],
            )?;
        }
        for person in m.people.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
            name_photo(&tx, &m.hash, person)?;
        }
        if m.faces.is_empty() {
            continue;
        }
        if faces_scanned {
            let named = place_faces(&tx, &m.hash, &m.faces)?;
            report.faces_named += named;
            if named < m.faces.len() {
                report.faces_unplaced.push(m.hash.clone());
            }
        } else {
            tx.execute("DELETE FROM backup_faces WHERE hash = ?1", [&m.hash]).map_err(|e| e.to_string())?;
            for f in &m.faces {
                tx.execute(
                    "INSERT INTO backup_faces (hash, name, frame, x, y, w, h) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![m.hash, f.name.trim(), f.frame.map(|n| n as i64), f.x, f.y, f.w, f.h],
                )
                .map_err(|e| e.to_string())?;
            }
            report.faces_waiting += m.faces.len();
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(report)
}

// Names waiting for faces the server has now looked for go on (or, not found, are given up); answers the
// photos that got a name
pub fn apply_waiting_faces(conn: &mut Connection) -> Result<Vec<String>, String> {
    ensure_table(conn)?;
    let ready = {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT b.hash FROM backup_faces b JOIN photos p ON p.hash = b.hash
                 WHERE COALESCE(p.faces_engine, '') != ''",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let mut named = Vec::new();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for hash in ready {
        let faces = {
            let mut stmt = tx
                .prepare_cached("SELECT name, frame, x, y, w, h FROM backup_faces WHERE hash = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([&hash], |r| {
                    Ok(NamedFace {
                        name: r.get(0)?,
                        frame: r.get::<_, Option<i64>>(1)?.map(|n| n as usize),
                        x: r.get(2)?,
                        y: r.get(3)?,
                        w: r.get(4)?,
                        h: r.get(5)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        if place_faces(&tx, &hash, &faces)? > 0 {
            named.push(hash.clone());
        }
        tx.execute("DELETE FROM backup_faces WHERE hash = ?1", [&hash]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(named)
}

// The server's person by this name (in its spelling: "emma" is its "Emma"), made if it has none
fn person(tx: &rusqlite::Transaction, name: &str) -> Result<String, String> {
    if let Some(known) =
        tx.query_row("SELECT name FROM people WHERE lower(name) = lower(?1)", [name], |r| r.get::<_, String>(0)).optional_row()?
    {
        return Ok(known);
    }
    tx.execute("INSERT INTO people (name) VALUES (?1)", [name]).map_err(|e| e.to_string())?;
    Ok(name.to_string())
}

fn name_photo(tx: &rusqlite::Transaction, hash: &str, name: &str) -> Result<String, String> {
    let name = person(tx, name)?;
    tx.execute("INSERT OR IGNORE INTO photo_people (hash, person_name) VALUES (?1, ?2)", [hash, name.as_str()]).map_err(|e| e.to_string())?;
    Ok(name)
}

// Each name goes to the unnamed face the server found at the same place (the same frame in a video); a
// face the server already named keeps its name. Answers how many names found their face (or had it already).
fn place_faces(tx: &rusqlite::Transaction, hash: &str, faces: &[NamedFace]) -> Result<usize, String> {
    let found: Vec<(String, (f64, f64, f64, f64), Option<String>)> = {
        let mut stmt = tx
            .prepare_cached("SELECT face_id, bbox_x, bbox_y, bbox_w, bbox_h, person_name FROM photo_faces WHERE hash = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([hash], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?), r.get::<_, Option<String>>(5)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let mut claimed: HashSet<String> = HashSet::new();
    let mut placed = 0;
    for face in faces {
        let name = face.name.trim();
        if name.is_empty() {
            continue;
        }
        let best = found
            .iter()
            .filter(|(id, _, _)| !claimed.contains(id) && video_frames::frame_of_face(id) == face.frame)
            .map(|(id, bbox, person)| (id, person, face_engine::bbox_iou((face.x, face.y, face.w, face.h), *bbox)))
            .filter(|(_, _, iou)| *iou >= SAME_FACE_IOU)
            .max_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
        let Some((id, person, _)) = best else { continue };
        claimed.insert(id.clone());
        placed += 1;
        if person.as_deref().is_some_and(|p| !p.is_empty()) {
            continue;
        }
        let name = name_photo(tx, hash, name)?;
        tx.execute("UPDATE photo_faces SET person_name = ?1 WHERE face_id = ?2", [name.as_str(), id.as_str()]).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE people SET cover_face_thumb = (SELECT face_thumb FROM photo_faces WHERE face_id = ?1)
             WHERE name = ?2 AND COALESCE(cover_face_thumb, '') = ''",
            [id.as_str(), name.as_str()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(placed)
}
