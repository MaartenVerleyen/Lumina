// Names of your own for people of the server (docs/plans/one-view.md, People): what one user calls a person
// in their own view, kept with their account so every device of theirs shows it. Dad calls cachy's "Me"
// "Maarten"; nobody else sees that. `apart` keeps a person apart from a person of the same name elsewhere
// in All photos ("Not the same person"). The people themselves never change.
use rusqlite::{params, Connection};
use serde::Serialize;

pub fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS person_names (
            user_id INTEGER NOT NULL,
            person TEXT NOT NULL COLLATE NOCASE,
            shown_as TEXT,
            apart INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, person)
         );",
    )
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct PersonName {
    pub person: String,
    pub shown_as: Option<String>,
    pub apart: bool,
}

pub fn of_user(conn: &Connection, user_id: i64) -> Result<Vec<PersonName>, String> {
    ensure_table(conn)?;
    let mut stmt = conn
        .prepare("SELECT person, shown_as, apart FROM person_names WHERE user_id = ?1 ORDER BY person")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([user_id], |r| Ok(PersonName { person: r.get(0)?, shown_as: r.get(1)?, apart: r.get::<_, i64>(2)? != 0 }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// A name of your own (None: their name again) and whether they stay apart; with neither the row goes
pub fn set(conn: &Connection, user_id: i64, person: &str, shown_as: Option<&str>, apart: bool) -> Result<(), String> {
    ensure_table(conn)?;
    let person = person.trim();
    if person.is_empty() {
        return Err("Which person?".into());
    }
    let shown_as = shown_as.map(str::trim).filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case(person));
    if shown_as.is_none() && !apart {
        conn.execute("DELETE FROM person_names WHERE user_id = ?1 AND person = ?2", params![user_id, person])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO person_names (user_id, person, shown_as, apart) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (user_id, person) DO UPDATE SET shown_as = excluded.shown_as, apart = excluded.apart",
        params![user_id, person, shown_as, apart as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_of_your_own_is_yours_alone() {
        let conn = Connection::open_in_memory().unwrap();
        set(&conn, 1, "Me", Some("Maarten"), false).unwrap();
        set(&conn, 1, "Emma", None, true).unwrap();
        assert_eq!(
            of_user(&conn, 1).unwrap(),
            vec![
                PersonName { person: "Emma".into(), shown_as: None, apart: true },
                PersonName { person: "Me".into(), shown_as: Some("Maarten".into()), apart: false },
            ]
        );
        assert!(of_user(&conn, 2).unwrap().is_empty(), "another user sees their own names only");
        // Their name again, and no longer apart: nothing left to keep
        set(&conn, 1, "me", None, false).unwrap();
        set(&conn, 1, "Emma", Some("emma"), false).unwrap();
        assert!(of_user(&conn, 1).unwrap().is_empty());
    }
}
