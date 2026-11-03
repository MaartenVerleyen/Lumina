// What a user may see and change, library by library. A server admin may do everything. Everyone else has a
// default role for every library (users.role: guest, viewer, uploader or editor) that an admin can set
// differently per library (library_roles): Anna can be an editor of her own library and a guest of
// Bob's. Albums shared with a user (album_shares) add their photos, to look at only, wherever the role
// doesn't already show them. The engine knows none of this: the server works out a Scope per request and
// checks or filters with it.
use crate::accounts::{Role, User};
use lumina_core::libraries;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

pub fn ensure_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS library_roles (
            library_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            PRIMARY KEY (library_id, user_id)
         );
         CREATE TABLE IF NOT EXISTS album_shares (
            album_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            PRIMARY KEY (album_id, user_id)
         );
         CREATE INDEX IF NOT EXISTS idx_album_shares_user ON album_shares(user_id);",
    )
    .map_err(|e| e.to_string())
}

// A user's own role on one library, instead of their default (None: back to the default). An admin's role
// can't be lowered per library; admins are server-wide.
pub fn set_library_role(conn: &Connection, user_id: i64, library_id: i64, role: Option<Role>) -> Result<(), String> {
    match role {
        Some(Role::Admin) => Err("Admin is for the whole server: change the user's role instead".into()),
        Some(role) => conn
            .execute(
                "INSERT INTO library_roles (library_id, user_id, role) VALUES (?1, ?2, ?3)
                 ON CONFLICT(library_id, user_id) DO UPDATE SET role = excluded.role",
                params![library_id, user_id, role.as_str()],
            )
            .map(|_| ())
            .map_err(|e| e.to_string()),
        None => conn
            .execute("DELETE FROM library_roles WHERE library_id = ?1 AND user_id = ?2", params![library_id, user_id])
            .map(|_| ())
            .map_err(|e| e.to_string()),
    }
}

pub fn library_roles_of(conn: &Connection, user_id: i64) -> Result<HashMap<i64, Role>, String> {
    let mut stmt = conn.prepare("SELECT library_id, role FROM library_roles WHERE user_id = ?1").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([user_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for row in rows {
        let (library, role) = row.map_err(|e| e.to_string())?;
        out.insert(library, Role::parse(&role)?);
    }
    Ok(out)
}

pub fn share_album(conn: &Connection, album_id: i64, user_id: i64, shared: bool) -> Result<(), String> {
    let sql = if shared {
        "INSERT OR IGNORE INTO album_shares (album_id, user_id) VALUES (?1, ?2)"
    } else {
        "DELETE FROM album_shares WHERE album_id = ?1 AND user_id = ?2"
    };
    conn.execute(sql, params![album_id, user_id]).map(|_| ()).map_err(|e| e.to_string())
}

// The names of the users an album is shared with
pub fn album_shares(conn: &Connection, album_id: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT u.name FROM album_shares s JOIN users u ON u.id = s.user_id WHERE s.album_id = ?1 ORDER BY u.name")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([album_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub struct Scope {
    pub user: User,
    // Each library's id and root, with this user's role on it
    libraries: Vec<(i64, String, Role)>,
    // Photos in albums shared with this user
    shared: HashSet<String>,
    pub shared_albums: HashSet<i64>,
}

impl Scope {
    pub fn load(conn: &Connection, user: &User) -> Result<Scope, String> {
        let own = if user.role == Role::Admin { HashMap::new() } else { library_roles_of(conn, user.id)? };
        let libraries = libraries::list(conn)?
            .into_iter()
            .map(|l| {
                let role = if user.role == Role::Admin { Role::Admin } else { own.get(&l.id).copied().unwrap_or(user.role) };
                (l.id, l.root, role)
            })
            .collect();
        let mut shared_albums = HashSet::new();
        let mut shared = HashSet::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT s.album_id, ap.hash FROM album_shares s LEFT JOIN album_photos ap ON ap.album_id = s.album_id
                     WHERE s.user_id = ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([user.id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (album, hash) = row.map_err(|e| e.to_string())?;
                shared_albums.insert(album);
                if let Some(h) = hash {
                    shared.insert(h);
                }
            }
        }
        Ok(Scope { user: user.clone(), libraries, shared, shared_albums })
    }

    pub fn admin(&self) -> bool {
        self.user.role == Role::Admin
    }

    // The highest role this user has anywhere: a command needing more is refused before anything else
    pub fn best_role(&self) -> Role {
        self.libraries.iter().map(|l| l.2).chain([self.user.role]).max().unwrap_or(Role::Guest)
    }

    pub fn role_on(&self, library_id: i64) -> Role {
        self.libraries.iter().find(|l| l.0 == library_id).map(|l| l.2).unwrap_or(Role::Guest)
    }

    pub fn role_on_root(&self, root: &str) -> Role {
        let wanted = libraries::normalize_root(root);
        self.libraries.iter().find(|l| libraries::normalize_root(&l.1) == wanted).map(|l| l.2).unwrap_or(Role::Guest)
    }

    pub fn library_id_of_root(&self, root: &str) -> Option<i64> {
        let wanted = libraries::normalize_root(root);
        self.libraries.iter().find(|l| libraries::normalize_root(&l.1) == wanted).map(|l| l.0)
    }

    // Every library at least at this role (none on a server without libraries counts as yes)
    pub fn everywhere(&self, role: Role) -> bool {
        self.libraries.iter().all(|l| l.2 >= role)
    }

    // On some library, or by default (also on a server without libraries yet)
    pub fn anywhere(&self, role: Role) -> bool {
        self.best_role() >= role
    }

    // Sees every photo on the server: nothing to filter
    pub fn sees_all(&self) -> bool {
        self.admin() || self.everywhere(Role::Viewer)
    }

    pub fn is_shared(&self, hash: &str) -> bool {
        self.shared.contains(hash)
    }

    pub fn shared_hashes(&self) -> impl Iterator<Item = &String> {
        self.shared.iter()
    }

    // The library each of these photos is in (photos outside every library are left out)
    pub fn libraries_of(conn: &Connection, hashes: &[String]) -> Result<HashMap<String, i64>, String> {
        if hashes.is_empty() {
            return Ok(HashMap::new());
        }
        let wanted = serde_json::to_string(hashes).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT hash, library_id FROM photos WHERE library_id IS NOT NULL
                 AND hash IN (SELECT value FROM json_each(?1))",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([wanted], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    // The ones of these photos this user may see, in the order given
    pub fn visible(&self, conn: &Connection, hashes: &[String]) -> Result<Vec<String>, String> {
        if self.sees_all() {
            let found = Scope::libraries_of(conn, hashes)?;
            return Ok(hashes.iter().filter(|h| found.contains_key(*h)).cloned().collect());
        }
        let found = Scope::libraries_of(conn, hashes)?;
        Ok(hashes
            .iter()
            .filter(|h| match found.get(*h) {
                Some(library) => self.role_on(*library) >= Role::Viewer || self.shared.contains(*h),
                None => false,
            })
            .cloned()
            .collect())
    }

    pub fn can_see(&self, conn: &Connection, hash: &str) -> Result<bool, String> {
        Ok(!self.visible(conn, &[hash.to_string()])?.is_empty())
    }

    // A set to filter result lists with; None when this user sees everything
    pub fn visible_set(&self, conn: &Connection, hashes: &[String]) -> Result<Option<HashSet<String>>, String> {
        if self.sees_all() {
            return Ok(None);
        }
        Ok(Some(self.visible(conn, hashes)?.into_iter().collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts;

    // A real database (the engine's tables and triggers) in a folder of its own
    fn db(name: &str) -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("lumina_scope_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let host = crate::host::ServerHost::new(dir.clone());
        let conn = lumina_core::db::open_global_db(&host).unwrap();
        lumina_core::db::migrate(&conn).unwrap();
        accounts::ensure_tables(&conn).unwrap();
        (conn, dir)
    }

    #[test]
    fn roles_per_library_and_shared_albums_decide_what_is_seen() {
        let (conn, dir) = db("roles");
        let a = libraries::open(&conn, "/anna").unwrap();
        let b = libraries::open(&conn, "/bob").unwrap();
        conn.execute_batch(
            "INSERT INTO photos (hash, current_path) VALUES ('a1', '/anna/1.jpg'), ('b1', '/bob/1.jpg'), ('b2', '/bob/2.jpg'), ('x', '/x.jpg');
             INSERT INTO albums (id, name) VALUES (10, 'Holiday');
             INSERT INTO album_photos (album_id, hash) VALUES (10, 'b2');",
        )
        .unwrap();
        // Anna: a guest by default, an editor of her own library; Bob shared one album with her
        let anna = accounts::create_user(&conn, "anna", Role::Guest, "long enough").unwrap();
        set_library_role(&conn, anna.id, a, Some(Role::Editor)).unwrap();
        share_album(&conn, 10, anna.id, true).unwrap();
        let s = Scope::load(&conn, &anna).unwrap();
        assert_eq!((s.role_on(a), s.role_on(b), s.best_role()), (Role::Editor, Role::Guest, Role::Editor));
        assert!(!s.sees_all());
        let all: Vec<String> = ["a1", "b1", "b2", "x", "nope"].iter().map(|h| h.to_string()).collect();
        assert_eq!(s.visible(&conn, &all).unwrap(), ["a1", "b2"]);

        // Unsharing takes the photo away again; an admin sees everything there is
        share_album(&conn, 10, anna.id, false).unwrap();
        assert_eq!(Scope::load(&conn, &anna).unwrap().visible(&conn, &all).unwrap(), ["a1"]);
        let ada = accounts::create_user(&conn, "ada", Role::Admin, "long enough").unwrap();
        let admin = Scope::load(&conn, &ada).unwrap();
        assert!(admin.sees_all());
        assert_eq!(admin.visible(&conn, &all).unwrap(), ["a1", "b1", "b2"]);
        assert!(set_library_role(&conn, anna.id, b, Some(Role::Admin)).is_err());

        // A viewer by default sees both libraries; back to the default when the override goes
        let vic = accounts::create_user(&conn, "vic", Role::Viewer, "long enough").unwrap();
        set_library_role(&conn, vic.id, b, Some(Role::Guest)).unwrap();
        assert_eq!(Scope::load(&conn, &vic).unwrap().visible(&conn, &all).unwrap(), ["a1"]);
        set_library_role(&conn, vic.id, b, None).unwrap();
        assert!(Scope::load(&conn, &vic).unwrap().sees_all());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
