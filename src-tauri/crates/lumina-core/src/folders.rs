// Folders inside a library, as the folder tree shows them: listed also while no photo is in them yet, renamed
// or moved inside the library with the photos' rows following, and removed when there is nothing in them.
// Every folder is named relative to the library's root with '/', the way the tree names them.
use crate::*;

// A folder name relative to the library: '/'-separated, without empty parts, never leading out of it
fn clean_rel(rel: &str) -> Result<String, String> {
    let parts: Vec<&str> = rel.split(['/', '\\']).map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|p| *p == ".." || *p == ".") {
        return Err("A folder stays inside the library: \"..\" isn't allowed".into());
    }
    if parts.iter().any(|p| p.contains([':', '*', '?', '"', '<', '>', '|'])) {
        return Err("A folder name can't contain : * ? \" < > |".into());
    }
    Ok(parts.join("/"))
}

fn join(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').filter(|p| !p.is_empty()).fold(root.to_path_buf(), |dir, part| dir.join(part))
}

// Lumina's own folders and hidden ones are not the user's folders
fn is_listed(name: &str) -> bool {
    !name.starts_with('.') && !name.eq_ignore_ascii_case("$RECYCLE.BIN") && !name.eq_ignore_ascii_case("System Volume Information")
}

// Every folder under the library's root (not the root itself), relative with '/'. Stops at 20,000.
pub fn list_library_folders(root_folder: &str) -> Result<Vec<String>, String> {
    let root = PathBuf::from(root_folder);
    if !root.is_dir() {
        return Err(format!("{root_folder} isn't there"));
    }
    let mut out = Vec::new();
    let mut stack = vec![(root.clone(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_listed(&name) {
                continue;
            }
            let child = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            out.push(child.clone());
            if out.len() >= 20_000 {
                return Ok(out);
            }
            stack.push((entry.path(), child));
        }
    }
    out.sort_by_key(|f| f.to_lowercase());
    Ok(out)
}

// Renames or moves a folder inside the library. The photos' rows follow (their ratings, tags and people stay),
// and photos staged for the folder are staged for its new name. Returns how many photos moved with it.
pub fn rename_library_folder(app: &dyn Host, root_folder: &str, rel_path: &str, new_rel_path: &str) -> Result<usize, String> {
    let (old, new) = (clean_rel(rel_path)?, clean_rel(new_rel_path)?);
    if old.is_empty() || new.is_empty() {
        return Err("The library's own folder can't be renamed here: use Locate… after renaming it".into());
    }
    let (old_l, new_l) = (old.to_lowercase(), new.to_lowercase());
    if new_l.starts_with(&format!("{old_l}/")) {
        return Err("A folder can't move into itself".into());
    }
    let root = PathBuf::from(root_folder);
    let (src, dest) = (join(&root, &old), join(&root, &new));
    if !src.is_dir() {
        return Err(format!("{old} isn't there any more"));
    }
    // Only the case changes ("trip" to "Trip"): the same folder on Windows, so it isn't in the way
    if dest.exists() && old_l != new_l {
        return Err(format!("There is already a folder {new}"));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    fs::rename(&src, &dest).map_err(|e| format!("Could not rename {old}: {e}"))?;

    let conn = open_global_db(app)?;
    let (old_full, new_full) = (src.to_string_lossy().to_string(), dest.to_string_lossy().to_string());
    let moved = conn
        .execute(
            "UPDATE photos SET current_path = ?2 || substr(current_path, length(?1) + 1) WHERE current_path LIKE ?3 ESCAPE '!'",
            params![old_full, new_full, make_folder_prefix(Some(&old_full))],
        )
        .map_err(|e| e.to_string())?;
    let escaped = old.replace('!', "!!").replace('%', "!%").replace('_', "!_");
    conn.execute(
        "UPDATE photos SET staged_target = ?2 || substr(staged_target, length(?1) + 1)
         WHERE lower(staged_target) = lower(?1) OR staged_target LIKE ?3 ESCAPE '!'",
        params![old, new, format!("{escaped}/%")],
    )
    .map_err(|e| e.to_string())?;
    Ok(moved)
}

// Removes a folder that holds no files (empty folders inside it go too); refuses one that holds anything
pub fn delete_empty_library_folder(root_folder: &str, rel_path: &str) -> Result<(), String> {
    let rel = clean_rel(rel_path)?;
    if rel.is_empty() {
        return Err("The library's own folder isn't removed here".into());
    }
    let dir = join(Path::new(root_folder), &rel);
    if !dir.is_dir() {
        return Err(format!("{rel} isn't there any more"));
    }
    let mut stack = vec![dir.clone()];
    while let Some(d) = stack.pop() {
        for entry in fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push(entry.path());
            } else {
                return Err(format!("{rel} isn't empty: it holds {}", entry.file_name().to_string_lossy()));
            }
        }
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("Could not remove {rel}: {e}"))
}
