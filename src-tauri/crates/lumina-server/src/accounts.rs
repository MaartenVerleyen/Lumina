// Accounts on the server: users with a role and a password, and their login sessions. Both live in the
// library's own database (library.db) as two extra tables; the engine never reads them.
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

// Lowest to highest. `uploader` can do what a viewer can until uploads exist (phase 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Uploader,
    Editor,
    Admin,
}

impl Role {
    pub fn parse(text: &str) -> Result<Role, String> {
        match text.trim().to_lowercase().as_str() {
            "viewer" => Ok(Role::Viewer),
            "uploader" => Ok(Role::Uploader),
            "editor" => Ok(Role::Editor),
            "admin" => Ok(Role::Admin),
            other => Err(format!("Unknown role \"{other}\": viewer, uploader, editor or admin")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Uploader => "uploader",
            Role::Editor => "editor",
            Role::Admin => "admin",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct User {
    #[serde(skip)]
    pub id: i64,
    pub name: String,
    pub role: Role,
}

// A session unused for this long has to log in again
pub const SESSION_IDLE_DAYS: i64 = 90;
const MIN_PASSWORD_LEN: usize = 8;

// Safe on every open: the server calls it when it starts and before every account command
pub fn ensure_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            name TEXT UNIQUE COLLATE NOCASE,
            role TEXT,
            password_hash TEXT,
            created_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER,
            device TEXT,
            created_at INTEGER,
            last_seen INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);",
    )
    .map_err(|e| e.to_string())?;
    crate::changes::ensure_table(conn)
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let mut salt_bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut salt_bytes);
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| format!("Can't make a salt: {e}"))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("Can't hash the password: {e}"))
}

fn password_matches(password: &str, stored: &str) -> bool {
    PasswordHash::new(stored).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
}

// Checked instead when the name doesn't exist, so a wrong name takes as long as a wrong password
static DUMMY_HASH: LazyLock<String> =
    LazyLock::new(|| hash_password("not a real password").unwrap_or_default());

fn check_password_rules(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(format!("A password needs at least {MIN_PASSWORD_LEN} characters"));
    }
    Ok(())
}

fn check_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 64 || name.chars().any(|c| c.is_control()) {
        return Err("A name is 1 to 64 characters, without control characters".to_string());
    }
    Ok(name.to_string())
}

pub fn create_user(conn: &Connection, name: &str, role: Role, password: &str) -> Result<User, String> {
    let name = check_name(name)?;
    check_password_rules(password)?;
    if find_user(conn, &name)?.is_some() {
        return Err(format!("There is already a user called {name}"));
    }
    let hash = hash_password(password)?;
    conn.execute(
        "INSERT INTO users (name, role, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![name, role.as_str(), hash, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(User { id: conn.last_insert_rowid(), name, role })
}

fn user_from_row(id: i64, name: String, role: String) -> Result<User, String> {
    Ok(User { id, name, role: Role::parse(&role)? })
}

pub fn find_user(conn: &Connection, name: &str) -> Result<Option<User>, String> {
    let row: Option<(i64, String, String)> = conn
        .query_row("SELECT id, name, role FROM users WHERE name = ?1", [name.trim()], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    row.map(|(id, name, role)| user_from_row(id, name, role)).transpose()
}

fn require_user(conn: &Connection, name: &str) -> Result<User, String> {
    find_user(conn, name)?.ok_or_else(|| format!("No user called {}", name.trim()))
}

pub fn list_users(conn: &Connection) -> Result<Vec<User>, String> {
    let mut stmt = conn.prepare("SELECT id, name, role FROM users ORDER BY name").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .map_err(|e| e.to_string())?;
    rows.flatten().map(|(id, name, role)| user_from_row(id, name, role)).collect()
}

// A new password also logs the user out everywhere
pub fn set_password(conn: &Connection, name: &str, password: &str) -> Result<(), String> {
    let user = require_user(conn, name)?;
    check_password_rules(password)?;
    let hash = hash_password(password)?;
    conn.execute("UPDATE users SET password_hash = ?2 WHERE id = ?1", params![user.id, hash]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sessions WHERE user_id = ?1", [user.id]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_role(conn: &Connection, name: &str, role: Role) -> Result<(), String> {
    let user = require_user(conn, name)?;
    conn.execute("UPDATE users SET role = ?2 WHERE id = ?1", params![user.id, role.as_str()]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_user(conn: &Connection, name: &str) -> Result<(), String> {
    let user = require_user(conn, name)?;
    conn.execute("DELETE FROM sessions WHERE user_id = ?1", [user.id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM users WHERE id = ?1", [user.id]).map_err(|e| e.to_string())?;
    Ok(())
}

// The user when name and password match. Never says which of the two was wrong, and takes about as long
// either way.
pub fn verify_login(conn: &Connection, name: &str, password: &str) -> Result<Option<User>, String> {
    let row: Option<(i64, String, String, String)> = conn
        .query_row("SELECT id, name, role, password_hash FROM users WHERE name = ?1", [name.trim()], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        Some((id, name, role, hash)) if password_matches(password, &hash) => Ok(Some(user_from_row(id, name, role)?)),
        Some(_) => Ok(None),
        None => {
            let _ = password_matches(password, &DUMMY_HASH);
            Ok(None)
        }
    }
}

fn token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

// A new random session token for the user (only its SHA-256 is stored)
pub fn create_session(conn: &Connection, user: &User, device: &str) -> Result<String, String> {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let device: String = device.chars().take(200).collect();
    let t = now();
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, device, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![token_hash(&token), user.id, device, t],
    )
    .map_err(|e| e.to_string())?;
    Ok(token)
}

// The user a session token belongs to, if the session exists and was used in the last 90 days. Marks it as
// used (at most once an hour, so browsing doesn't write to the database on every request).
pub fn session_user(conn: &Connection, token: &str) -> Result<Option<User>, String> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let hash = token_hash(token);
    let row: Option<(i64, String, String, i64)> = conn
        .query_row(
            "SELECT u.id, u.name, u.role, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1",
            [&hash],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((id, name, role, last_seen)) = row else { return Ok(None) };
    let t = now();
    if t - last_seen > SESSION_IDLE_DAYS * 86_400 {
        conn.execute("DELETE FROM sessions WHERE token_hash = ?1", [&hash]).map_err(|e| e.to_string())?;
        return Ok(None);
    }
    if t - last_seen > 3600 {
        conn.execute("UPDATE sessions SET last_seen = ?2 WHERE token_hash = ?1", params![hash, t])
            .map_err(|e| e.to_string())?;
    }
    Ok(Some(user_from_row(id, name, role)?))
}

pub fn delete_session(conn: &Connection, token: &str) -> Result<(), String> {
    conn.execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash(token)]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        ensure_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn roles_are_ordered_lowest_to_highest() {
        assert!(Role::Viewer < Role::Uploader && Role::Uploader < Role::Editor && Role::Editor < Role::Admin);
        assert_eq!(Role::parse(" Editor ").unwrap(), Role::Editor);
        assert!(Role::parse("owner").is_err());
    }

    #[test]
    fn passwords_are_hashed_with_argon2id_and_checked() {
        let hash = hash_password("correct horse").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(password_matches("correct horse", &hash));
        assert!(!password_matches("correct horsE", &hash));
        assert_ne!(hash, hash_password("correct horse").unwrap(), "every hash has its own salt");
    }

    #[test]
    fn login_needs_the_right_name_and_password() {
        let conn = db();
        create_user(&conn, "Maarten", Role::Admin, "long enough").unwrap();
        assert_eq!(verify_login(&conn, "maarten", "long enough").unwrap().unwrap().role, Role::Admin);
        assert!(verify_login(&conn, "maarten", "wrong password").unwrap().is_none());
        assert!(verify_login(&conn, "nobody", "long enough").unwrap().is_none());
        assert!(create_user(&conn, "MAARTEN", Role::Viewer, "long enough").is_err(), "names ignore case");
        assert!(create_user(&conn, "short", Role::Viewer, "1234567").is_err());
    }

    #[test]
    fn sessions_store_only_a_hash_and_end_with_a_new_password() {
        let conn = db();
        let user = create_user(&conn, "anna", Role::Editor, "long enough").unwrap();
        let token = create_session(&conn, &user, "test").unwrap();
        let stored: String = conn.query_row("SELECT token_hash FROM sessions", [], |r| r.get(0)).unwrap();
        assert_ne!(stored, token);
        assert_eq!(session_user(&conn, &token).unwrap().unwrap().name, "anna");
        assert!(session_user(&conn, &"0".repeat(64)).unwrap().is_none());
        assert!(session_user(&conn, "not a token").unwrap().is_none());
        set_password(&conn, "anna", "another one").unwrap();
        assert!(session_user(&conn, &token).unwrap().is_none());
    }

    #[test]
    fn an_idle_session_expires() {
        let conn = db();
        let user = create_user(&conn, "anna", Role::Viewer, "long enough").unwrap();
        let token = create_session(&conn, &user, "test").unwrap();
        conn.execute("UPDATE sessions SET last_seen = ?1", [now() - SESSION_IDLE_DAYS * 86_400 - 1]).unwrap();
        assert!(session_user(&conn, &token).unwrap().is_none());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
}
