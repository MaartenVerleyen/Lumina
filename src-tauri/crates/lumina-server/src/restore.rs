// Restoring a .luminabackup on the server: the admin page uploads it into the data folder, the engine
// stages its database (with the folder remaps), and the server starts itself again, which moves the staged
// database in before anything opens it. A backup comes from the desktop app or from an older state of this
// server, so its database has no (or old) accounts: the server's own tables (users, sessions, who did what,
// roles per library, album shares) are carried over from the database it replaces.
use crate::accounts;
use crate::host::ServerHost;
use lumina_core::host::Host;
use lumina_core::{backup, db, libraries};
use std::path::{Path, PathBuf};

pub fn restores_dir(host: &ServerHost) -> PathBuf {
    host.data_dir().join("restores")
}

// An uploaded backup by the name the upload answered (never a path from the client)
pub fn uploaded(host: &ServerHost, name: &str) -> Result<PathBuf, String> {
    let ok = name.starts_with("upload-")
        && name.ends_with(".luminabackup")
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.');
    let path = restores_dir(host).join(name);
    if !ok || !path.is_file() {
        return Err("No such uploaded backup: upload it again".into());
    }
    Ok(path)
}

fn safety_copies(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("library-before-restore-") && n.ends_with(".db")))
        .collect()
}

// At start, before anything opens the database: moves a staged restore in and carries the server's own
// tables over. Answers whether a restore was applied.
pub fn apply_staged(host: &ServerHost, roots: &[String]) -> Result<bool, String> {
    let dir = host.data_dir();
    if !dir.join(backup::PENDING_RESTORE).exists() {
        return Ok(false);
    }
    let before = safety_copies(&dir);
    backup::apply_pending_restore(&dir);
    if dir.join(backup::PENDING_RESTORE).exists() {
        return Err("The restore was postponed: the current database couldn't be copied first".into());
    }
    let conn = db::open_global_db(host)?;
    db::migrate(&conn)?;
    accounts::ensure_tables(&conn)?;
    for root in roots {
        let _ = libraries::open(&conn, root);
    }
    let Some(old) = safety_copies(&dir).into_iter().find(|p| !before.contains(p)) else {
        // There was no database before: nothing to carry over
        return Ok(true);
    };
    carry_over(&conn, &old)?;
    Ok(true)
}

fn carry_over(conn: &rusqlite::Connection, old: &Path) -> Result<(), String> {
    conn.execute("ATTACH DATABASE ?1 AS old", [old.to_string_lossy()]).map_err(|e| e.to_string())?;
    let has = |table: &str| -> bool {
        conn.query_row("SELECT COUNT(*) FROM old.sqlite_master WHERE type = 'table' AND name = ?1", [table], |r| r.get::<_, i64>(0))
            .unwrap_or(0)
            > 0
    };
    let mut steps: Vec<&str> = Vec::new();
    if has("users") {
        steps.push(
            "INSERT OR REPLACE INTO users (id, name, role, password_hash, created_at)
             SELECT id, name, role, password_hash, created_at FROM old.users",
        );
    }
    if has("sessions") {
        steps.push(
            "INSERT OR REPLACE INTO sessions (token_hash, user_id, device, created_at, last_seen)
             SELECT token_hash, user_id, device, created_at, last_seen FROM old.sessions",
        );
    }
    if has("changes") {
        steps.push(
            "INSERT INTO changes (at, user_id, hash, what) SELECT at, user_id, hash, what FROM old.changes
             WHERE NOT EXISTS (SELECT 1 FROM main.changes)",
        );
    }
    // Libraries and albums get new ids in the restored database: matched by root and by name
    if has("library_roles") {
        steps.push(
            "INSERT OR REPLACE INTO library_roles (library_id, user_id, role)
             SELECT nl.id, r.user_id, r.role FROM old.library_roles r
             JOIN old.libraries ol ON ol.id = r.library_id JOIN main.libraries nl ON nl.root = ol.root",
        );
    }
    if has("album_shares") {
        steps.push(
            "INSERT OR IGNORE INTO album_shares (album_id, user_id)
             SELECT na.id, s.user_id FROM old.album_shares s
             JOIN old.albums oa ON oa.id = s.album_id JOIN main.albums na ON lower(na.name) = lower(oa.name)",
        );
    }
    let result = steps.iter().try_for_each(|sql| conn.execute(sql, []).map(|_| ()).map_err(|e| e.to_string()));
    let _ = conn.execute("DETACH DATABASE old", []);
    result
}

// Starts this server again with the same arguments, in place (the same process for Docker), so the staged
// database is moved in before anything opens it and every cache starts afresh
pub fn restart() -> ! {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("lumina-server"));
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    println!("[restore] starting again");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = std::process::Command::new(&exe).args(&args).exec();
        eprintln!("[restore] couldn't start again ({e}); start the server by hand");
        std::process::exit(1);
    }
    #[cfg(not(unix))]
    {
        let _ = std::process::Command::new(&exe).args(&args).spawn();
        std::process::exit(0);
    }
}

// Free and total bytes on the disk holding this folder
pub fn disk_space(dir: &Path) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: a valid C string and a zeroed struct for statvfs to fill
        if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
            return None;
        }
        let block = stat.f_frsize as u64;
        Some((stat.f_bavail as u64 * block, stat.f_blocks as u64 * block))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::Role;

    #[test]
    fn a_restore_keeps_the_servers_accounts_roles_and_shares() {
        let dir = std::env::temp_dir().join(format!("lumina_restore_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let host = ServerHost::new(dir.clone());
        let root = dir.join("Photos").to_string_lossy().to_string();
        {
            let conn = db::open_global_db(&host).unwrap();
            db::migrate(&conn).unwrap();
            accounts::ensure_tables(&conn).unwrap();
            let lib = libraries::open(&conn, &root).unwrap();
            let anna = accounts::create_user(&conn, "anna", Role::Guest, "long enough").unwrap();
            crate::scope::set_library_role(&conn, anna.id, lib, Some(Role::Editor)).unwrap();
            conn.execute("INSERT INTO albums (name) VALUES ('Holiday')", []).unwrap();
            let album: i64 = conn.query_row("SELECT id FROM albums", [], |r| r.get(0)).unwrap();
            crate::scope::share_album(&conn, album, anna.id, true).unwrap();
        }
        // A "backup" from a desktop: the same library and album (other ids), no accounts at all
        let staged = dir.join(backup::PENDING_RESTORE);
        {
            let conn = rusqlite::Connection::open(&staged).unwrap();
            db::migrate(&conn).unwrap();
            conn.execute("INSERT INTO libraries (id, root, name) VALUES (7, ?1, 'Photos')", [&root]).unwrap_or_default();
            conn.execute_batch("INSERT INTO albums (id, name) VALUES (40, 'Other'), (41, 'holiday');").unwrap();
        }
        assert!(apply_staged(&host, &[root.clone()]).unwrap());
        let conn = db::open_global_db(&host).unwrap();
        let anna = accounts::find_user(&conn, "anna").unwrap().expect("the account survives the restore");
        assert!(accounts::verify_login(&conn, "anna", "long enough").unwrap().is_some());
        let scope = crate::scope::Scope::load(&conn, &anna).unwrap();
        assert_eq!(scope.role_on_root(&root), Role::Editor, "her role on the library, matched by root");
        assert_eq!(scope.shared_albums.iter().copied().collect::<Vec<_>>(), [41], "the share, matched by album name");
        assert!(!apply_staged(&host, &[root]).unwrap(), "nothing staged any more");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
