// The library folders Lumina has opened, and where each photo sits inside one: `photos.library_id` and
// `photos.rel_path` (relative to the library's root, always with '/'). `current_path` stays the full path on
// this machine and the folder-scoped queries keep using it; triggers keep the two in step, so every place
// that writes `current_path` (scan, moves, import, restore) files the photo under its library by itself.
// A library that moves (another drive letter, the server's /photos) is then one root change: see `relocate`.
use crate::*;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Library {
    pub id: i64,
    pub root: String,
    pub name: String,
    pub photos: usize,
}

// The library and relative path of the file at `path` (an SQL expression): the longest root it sits under,
// compared case-insensitively with either separator, as Windows does. NULLs when it is in no library.
fn placement(path: &str) -> String {
    format!(
        "(SELECT id, substr(replace({path}, '\\', '/'), length(r) + 2)
          FROM (SELECT id, rtrim(replace(root, '\\', '/'), '/') AS r FROM libraries)
          WHERE lower(substr(replace({path}, '\\', '/'), 1, length(r) + 1)) = lower(r) || '/'
          ORDER BY length(r) DESC LIMIT 1)"
    )
}

pub fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS libraries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root TEXT NOT NULL UNIQUE COLLATE NOCASE,
            name TEXT NOT NULL DEFAULT ''
        );",
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN library_id INTEGER", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN rel_path TEXT", []);
    conn.execute_batch(&format!(
        "CREATE INDEX IF NOT EXISTS idx_photos_library ON photos(library_id);
         CREATE TRIGGER IF NOT EXISTS photos_library_insert AFTER INSERT ON photos BEGIN
             UPDATE photos SET (library_id, rel_path) = {new} WHERE hash = NEW.hash;
         END;
         CREATE TRIGGER IF NOT EXISTS photos_library_update AFTER UPDATE OF current_path ON photos BEGIN
             UPDATE photos SET (library_id, rel_path) = {new} WHERE hash = NEW.hash;
         END;",
        new = placement("NEW.current_path")
    ))
    .map_err(|e| e.to_string())?;

    let done: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
    if done < 2 {
        // Earlier versions kept no list of libraries: work them out from where the photos are, the way a
        // backup does. Opening a folder later adds it (and folds in libraries inside it), see `open`.
        let paths: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT current_path FROM photos WHERE COALESCE(current_path, '') != ''")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };
        let roots: Vec<String> = crate::backup::library_roots(&paths, &[]).into_iter().map(|r| r.path).collect();
        for root in fold_siblings(roots) {
            let _ = conn.execute("INSERT OR IGNORE INTO libraries (root) VALUES (?1)", params![root]);
        }
        relink(conn, false)?;
        conn.execute_batch("PRAGMA user_version = 2").map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Folders that share a parent are one library in that parent (D:\Media\2023 and D:\Media\2024 are D:\Media),
// except at a drive root, where folders are usually unrelated
fn fold_siblings(mut roots: Vec<String>) -> Vec<String> {
    loop {
        let parent_of = |r: &str| -> Option<String> {
            let trimmed = r.trim_end_matches(['\\', '/']);
            let cut = trimmed.rfind(['\\', '/'])?;
            let parent = &trimmed[..cut];
            // "D:" or "" (a drive root or "/"): stop there
            (!parent.is_empty() && !parent.ends_with(':')).then(|| parent.to_string())
        };
        let mut folded = None;
        for r in &roots {
            if let Some(parent) = parent_of(r) {
                let siblings = roots.iter().filter(|o| parent_of(o).is_some_and(|p| p.eq_ignore_ascii_case(&parent))).count();
                if siblings >= 2 {
                    folded = Some(parent);
                    break;
                }
            }
        }
        let Some(parent) = folded else { return roots };
        roots.retain(|r| !crate::backup::under_root(r, &parent));
        roots.push(parent);
    }
}

// Files every photo (or only those without a library) under its library again
fn relink(conn: &Connection, only_unfiled: bool) -> Result<usize, String> {
    let filter = if only_unfiled { "WHERE library_id IS NULL" } else { "" };
    conn.execute(
        &format!("UPDATE photos SET (library_id, rel_path) = {} {filter}", placement("photos.current_path")),
        [],
    )
    .map_err(|e| e.to_string())
}

// A Windows path (drive letter or \\server\share), whichever separators it was typed with
fn is_windows_path(path: &str) -> bool {
    path.as_bytes().get(1) == Some(&b':') || path.starts_with(r"\\") || path.starts_with("//")
}

// A folder as typed or picked, in one spelling: backslashes in Windows paths, no trailing separator except on
// a drive root ("D:\") or "/"
pub fn normalize_root(root: &str) -> String {
    let root = root.trim();
    let root = if is_windows_path(root) { root.replace('/', "\\") } else { root.to_string() };
    let trimmed = root.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return root.chars().next().map(String::from).unwrap_or_default();
    }
    if trimmed.ends_with(':') {
        return format!("{trimmed}\\");
    }
    trimmed.to_string()
}

// Called when a folder is opened. A folder inside a library is a view of it (that library's id); any other
// folder becomes a library, taking in the libraries inside it.
pub fn open(conn: &Connection, root: &str) -> Result<i64, String> {
    let root = normalize_root(root);
    let libraries = list(conn)?;
    if let Some(outer) = libraries
        .iter()
        .filter(|l| crate::backup::under_root(&root, &l.root))
        .max_by_key(|l| l.root.len())
    {
        return Ok(outer.id);
    }
    let inner: Vec<i64> = libraries.iter().filter(|l| crate::backup::under_root(&l.root, &root)).map(|l| l.id).collect();
    for id in &inner {
        conn.execute("DELETE FROM libraries WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        conn.execute("UPDATE photos SET library_id = NULL WHERE library_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    conn.execute("INSERT INTO libraries (root) VALUES (?1)", params![root]).map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    relink(conn, true)?;
    Ok(id)
}

pub fn list(conn: &Connection) -> Result<Vec<Library>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT l.id, l.root, l.name, (SELECT COUNT(*) FROM photos p WHERE p.library_id = l.id)
             FROM libraries l ORDER BY l.root",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Library { id: r.get(0)?, root: r.get(1)?, name: r.get(2)?, photos: r.get::<_, i64>(3)?.max(0) as usize })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

// The library now lives at `new_root` (same files, another place): every photo's full path follows.
// Returns how many photos moved with it.
pub fn relocate(conn: &mut Connection, id: i64, new_root: &str) -> Result<usize, String> {
    let new_root = normalize_root(new_root);
    let sep = if is_windows_path(&new_root) { "\\" } else { "/" };
    let base = new_root.trim_end_matches(['\\', '/']).to_string();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE libraries SET root = ?2 WHERE id = ?1", params![id, new_root])
        .map_err(|e| format!("Another library already uses {new_root}: {e}"))?;
    let moved = tx
        .execute(
            "UPDATE photos SET current_path = ?2 || ?3 || replace(rel_path, '/', ?3) WHERE library_id = ?1 AND rel_path IS NOT NULL",
            params![id, base, sep],
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(moved)
}
