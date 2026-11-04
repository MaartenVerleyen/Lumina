// Dynamic albums (saved searches) shared with a user. The user sees the album's photos, never its query: the
// server runs the search itself (lumina_core::search) over the libraries the person who shared it may edit,
// and keeps the result in search_share_photos, which the scope reads as it reads album_photos. The results
// are worked out again after anything that can change them (see `keep_up`).
use crate::accounts::{self, Role};
use crate::host::ServerHost;
use crate::scope::Scope;
use lumina_core::host::{Host, SharedHost};
use lumina_core::search::{self, Day, SearchPhoto};
use lumina_core::{albums, clip, db, scan};
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub fn ensure_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS search_shares (
            search_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            shared_by INTEGER NOT NULL,
            PRIMARY KEY (search_id, user_id)
         );
         CREATE INDEX IF NOT EXISTS idx_search_shares_user ON search_shares(user_id);
         CREATE TABLE IF NOT EXISTS search_share_photos (
            search_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            hash TEXT NOT NULL,
            PRIMARY KEY (search_id, user_id, hash)
         );
         CREATE INDEX IF NOT EXISTS idx_search_share_photos_user ON search_share_photos(user_id);",
    )
    .map_err(|e| e.to_string())
}

pub fn share(conn: &Connection, search_id: i64, user_id: i64, shared_by: i64, shared: bool) -> Result<(), String> {
    if shared {
        let found: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM saved_searches WHERE id = ?1)", [search_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if !found {
            return Err("That smart album doesn't exist (any more)".into());
        }
        conn.execute(
            "INSERT INTO search_shares (search_id, user_id, shared_by) VALUES (?1, ?2, ?3)
             ON CONFLICT(search_id, user_id) DO UPDATE SET shared_by = excluded.shared_by",
            params![search_id, user_id, shared_by],
        )
    } else {
        conn.execute("DELETE FROM search_shares WHERE search_id = ?1 AND user_id = ?2", params![search_id, user_id])
    }
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// A saved search that is deleted: no one sees it any more
pub fn forget_search(conn: &Connection, search_id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM search_shares WHERE search_id = ?1", [search_id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM search_share_photos WHERE search_id = ?1", [search_id]).map_err(|e| e.to_string())?;
    Ok(())
}

// The names of the users a saved search is shared with
pub fn shares_of(conn: &Connection, search_id: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT u.name FROM search_shares s JOIN users u ON u.id = s.user_id WHERE s.search_id = ?1 ORDER BY u.name")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([search_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

// The shared dynamic albums this user sees: (search id, name, photos)
pub fn shared_with(conn: &Connection, user_id: i64) -> Result<Vec<(i64, String, Vec<String>)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.search_id, ss.name, p.hash FROM search_shares s JOIN saved_searches ss ON ss.id = s.search_id
             LEFT JOIN search_share_photos p ON p.search_id = s.search_id AND p.user_id = s.user_id
             WHERE s.user_id = ?1 ORDER BY ss.created_at, ss.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([user_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
        .map_err(|e| e.to_string())?;
    let mut out: Vec<(i64, String, Vec<String>)> = Vec::new();
    for row in rows {
        let (id, name, hash) = row.map_err(|e| e.to_string())?;
        if out.last().is_none_or(|l| l.0 != id) {
            out.push((id, name, Vec::new()));
        }
        if let Some(h) = hash {
            out.last_mut().unwrap().2.push(h);
        }
    }
    Ok(out)
}

// Smart search scores per free text, kept until the smart search index changes: embedding the text loads the
// model on the GPU, which the pipeline shares with Ollama
static SCORES: Mutex<Option<HashMap<String, Arc<HashMap<String, f64>>>>> = Mutex::new(None);

pub fn forget_scores() {
    *SCORES.lock().unwrap() = None;
}

async fn scores_for(host: &Arc<ServerHost>, text: &str) -> Option<Arc<HashMap<String, f64>>> {
    if let Some(found) = SCORES.lock().unwrap().as_ref().and_then(|m| m.get(text).cloned()) {
        return Some(found);
    }
    let shared: SharedHost = host.clone();
    match clip::semantic_search(shared, text.to_string()).await {
        Ok(hits) => {
            let scores = Arc::new(hits.into_iter().map(|h| (h.hash, h.score as f64)).collect::<HashMap<_, _>>());
            SCORES.lock().unwrap().get_or_insert_with(HashMap::new).insert(text.to_string(), scores.clone());
            Some(scores)
        }
        // No smart search on this server (yet): the words are looked for as text, as the grid does then
        Err(e) => {
            eprintln!("[dynamic albums] smart search for a shared album: {e}");
            None
        }
    }
}

struct Shared {
    search_id: i64,
    user_id: i64,
    shared_by: i64,
    query: String,
    smart: bool,
}

// Works out every shared dynamic album again; true when any album's photos changed
pub async fn refresh(host: &Arc<ServerHost>) -> Result<bool, String> {
    let h = host.clone();
    // What is shared, by whom, and the photos of the libraries each of them may edit
    let (shares, photos_by_sharer, album_sets) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let conn = db::open_global_db(&*h)?;
        // Shares of searches that are gone, and results of shares that are gone, go
        conn.execute_batch(
            "DELETE FROM search_shares WHERE search_id NOT IN (SELECT id FROM saved_searches);
             DELETE FROM search_share_photos WHERE NOT EXISTS (SELECT 1 FROM search_shares s
                WHERE s.search_id = search_share_photos.search_id AND s.user_id = search_share_photos.user_id);",
        )
        .map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.search_id, s.user_id, s.shared_by, ss.query, ss.smart FROM search_shares s
                 JOIN saved_searches ss ON ss.id = s.search_id",
            )
            .map_err(|e| e.to_string())?;
        let shares: Vec<Shared> = stmt
            .query_map([], |r| {
                Ok(Shared { search_id: r.get(0)?, user_id: r.get(1)?, shared_by: r.get(2)?, query: r.get(3)?, smart: r.get::<_, i64>(4)? != 0 })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        let users = accounts::list_users(&conn)?;
        let mut photos_by_sharer: HashMap<i64, Vec<SearchPhoto>> = HashMap::new();
        for sharer in shares.iter().map(|s| s.shared_by).collect::<HashSet<_>>() {
            // Someone who is gone shares nothing any more
            let Some(user) = users.iter().find(|u| u.id == sharer) else {
                photos_by_sharer.insert(sharer, Vec::new());
                continue;
            };
            let scope = Scope::load(&conn, user)?;
            let mut photos = Vec::new();
            for library in lumina_core::libraries::list(&conn)? {
                if scope.role_on(library.id) >= Role::Editor {
                    photos.extend(scan::list_library_photos(&*h, &library.root)?.iter().map(SearchPhoto::from));
                }
            }
            photos_by_sharer.insert(sharer, photos);
        }
        let shared: SharedHost = h.clone();
        let album_sets: HashMap<String, HashSet<String>> =
            albums::get_albums(shared)?.into_iter().map(|a| (a.name.to_lowercase(), a.hashes.into_iter().collect())).collect();
        Ok((shares, photos_by_sharer, album_sets))
    })
    .await
    .map_err(|e| e.to_string())??;

    let today = Day::today();
    let lookup = |name: &str| album_sets.get(&name.to_lowercase());
    let mut results: Vec<(i64, i64, HashSet<String>)> = Vec::new();
    for s in &shares {
        let photos = photos_by_sharer.get(&s.shared_by).map(Vec::as_slice).unwrap_or(&[]);
        let scores = if s.smart {
            let text = search::free_text(&s.query, photos, today);
            if text.is_empty() {
                None
            } else {
                scores_for(host, &text).await
            }
        } else {
            None
        };
        let found = search::run_search(photos, &s.query, today, &lookup, scores.as_deref());
        // A Live Photo's clip comes with its photo, so it plays for whoever sees the photo
        let clip_of: HashMap<&str, &str> =
            photos.iter().filter_map(|c| c.live_photo_hash.as_deref().map(|photo| (photo, c.hash.as_str()))).collect();
        let mut hashes: HashSet<String> = found.iter().map(|p| p.hash.clone()).collect();
        for p in &found {
            if let Some(clip) = clip_of.get(p.hash.as_str()) {
                hashes.insert(clip.to_string());
            }
        }
        results.push((s.search_id, s.user_id, hashes));
    }

    let h = host.clone();
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let mut conn = db::open_global_db(&*h)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut changed = false;
        for (search_id, user_id, hashes) in results {
            let old: HashSet<String> = {
                let mut stmt = tx
                    .prepare("SELECT hash FROM search_share_photos WHERE search_id = ?1 AND user_id = ?2")
                    .map_err(|e| e.to_string())?;
                let rows = stmt.query_map(params![search_id, user_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
                rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
            };
            if old == hashes {
                continue;
            }
            changed = true;
            tx.execute("DELETE FROM search_share_photos WHERE search_id = ?1 AND user_id = ?2", params![search_id, user_id])
                .map_err(|e| e.to_string())?;
            let mut insert = tx
                .prepare("INSERT INTO search_share_photos (search_id, user_id, hash) VALUES (?1, ?2, ?3)")
                .map_err(|e| e.to_string())?;
            for hash in &hashes {
                insert.execute(params![search_id, user_id, hash]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    })
    .await
    .map_err(|e| e.to_string())?
}

// The events after which a shared dynamic album can hold other photos
const TRIGGERS: &[&str] = &["photos-changed", "people-changed", "albums-changed", "shares-changed", "roles-changed", "library-files-changed"];
// Progress events count once their pass is done
const DONE_TRIGGERS: &[&str] = &["scan-progress", "semantic-progress", "ai-batch-progress", "face-scan-progress"];
// Our own albums-changed, which mustn't start another round
pub const ORIGIN: &str = "dynamic-albums";

fn triggers(event: &str, payload: &serde_json::Value) -> bool {
    if payload["origin"].as_str() == Some(ORIGIN) {
        return false;
    }
    TRIGGERS.contains(&event) || (DONE_TRIGGERS.contains(&event) && payload["done"].as_bool() == Some(true))
}

async fn refresh_and_tell(host: &Arc<ServerHost>) {
    match refresh(host).await {
        // Guests' sockets look at their scope again on albums-changed, and their windows list the library again
        Ok(true) => host.emit_value("albums-changed", serde_json::json!({ "by": "server", "origin": ORIGIN })),
        Ok(false) => {}
        Err(e) => eprintln!("[dynamic albums] couldn't work out the shared smart albums: {e}"),
    }
}

// Runs for as long as the server does: a second after the last event that can change a shared dynamic
// album, and every hour (for dates like "last week"), every shared one is worked out again
pub fn keep_up(host: Arc<ServerHost>) {
    let mut rx = host.subscribe();
    tokio::spawn(async move {
        refresh_and_tell(&host).await;
        let mut hourly = tokio::time::interval(Duration::from_secs(3600));
        hourly.tick().await;
        loop {
            let due = tokio::select! {
                event = rx.recv() => match event {
                    Ok((name, payload)) => {
                        if name == "semantic-progress" && payload["done"].as_bool() == Some(true) {
                            forget_scores();
                        }
                        triggers(&name, &payload)
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => true,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                },
                _ = hourly.tick() => true,
            };
            if !due {
                continue;
            }
            // Wait for a quiet second: a batch of edits is one round
            loop {
                match tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
                    Ok(Ok((name, payload))) => {
                        if name == "semantic-progress" && payload["done"].as_bool() == Some(true) {
                            forget_scores();
                        }
                    }
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => return,
                    Err(_) => break,
                }
            }
            refresh_and_tell(&host).await;
        }
    });
}
