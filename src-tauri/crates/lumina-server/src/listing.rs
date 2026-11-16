// A library's photo list, kept ready. Listing a large library takes seconds (the queries, a look on the disk
// for every file and thumbnail, tens of megabytes of JSON), and every window that opens the library asks for
// the same list. So the list is kept, each photo as its JSON, and brought up to date when something changed:
//
// - Most changes are in the database, where every photo has a revision (lumina-core's revision.rs). The
//   photos with a newer one than the kept list's are read again, and only those.
// - A change the database doesn't show photo by photo (files that came or went, a library added, the smart
//   search vectors the duplicate groups use) makes the whole list anew. So does a photo that came, went, or
//   changed in what the library-wide links are worked out from (scan::keep_links), and the list's age: a
//   change may tell nobody (a file deleted on the server's disk while the watcher is off).
//
// Every change to a library goes past the server's host as an event, or is an editing command; both say here
// that the kept lists are to be looked at again.
//
// Each state of a list has a tag. A client that names the list it has can be sent only what differs: the
// photos that changed or came, and the ones that went. After a restart the client gets the whole list.
//
// Only the whole list is kept: someone who sees part of a library gets theirs worked out as before.
use crate::host::ServerHost;
use lumina_core::{db, revision, scan};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const KEPT_FOR: Duration = Duration::from_secs(1800);
const REMOVALS_KEPT: usize = 100_000;
// Differences up to this size (as JSON) are sent whatever the size of the whole list
const SMALL_ANSWER: usize = 256 * 1024;
// More changed photos than this are not read again one by one: the whole list is made
const MOST_FOLLOWED: usize = 5000;

// What a client that has a list (or none) is sent
pub enum Answer {
    // Its list is this one
    Same(String),
    // What differs from the list it named (`base`), gzipped JSON:
    // {"changed": [{"after": hash or null, "photo": {...}}, ...], "removed": [hash, ...]}
    // `changed` is in the list's order and `after` the photo before it there: where a new one goes.
    Differences { etag: String, base: String, gzipped: axum::body::Bytes },
    // The JSON array of photos as scan_folder answers it, gzipped
    Whole { etag: String, gzipped: axum::body::Bytes },
}

struct Tracked {
    // The state of the list (`Listings::made`) in which this photo came or last differed
    changed_at: u64,
    json: Box<[u8]>,
}

// The photos of one library's list, and what earlier states of it had
#[derive(Default)]
struct Track {
    order: Vec<String>,
    photos: HashMap<String, Tracked>,
    removed: Vec<(String, u64)>,
    // A state before this one can't be brought up to date with differences
    whole_before: u64,
}

impl Track {
    // Takes in a list made anew as state `made`: each photo's id and JSON, in the list's order
    fn take(&mut self, made: u64, items: Vec<(String, Vec<u8>)>) {
        let now: HashSet<&str> = items.iter().map(|(hash, _)| hash.as_str()).collect();
        // Differences say where a new photo goes, not that others changed places: the photos both lists
        // have must be in the same order (an id twice in a list can't be told apart either)
        let before = self.order.iter().filter(|hash| now.contains(hash.as_str()));
        let after = items.iter().map(|(hash, _)| hash).filter(|hash| self.photos.contains_key(hash.as_str()));
        let comparable = !self.photos.is_empty() && now.len() == items.len() && before.eq(after);

        for hash in &self.order {
            if !now.contains(hash.as_str()) {
                self.photos.remove(hash);
                self.removed.push((hash.clone(), made));
            }
        }
        let mut order = Vec::with_capacity(items.len());
        for (hash, json) in items {
            if self.photos.get(&hash).is_none_or(|t| *t.json != *json) {
                self.photos.insert(hash.clone(), Tracked { changed_at: made, json: json.into_boxed_slice() });
            }
            order.push(hash);
        }
        self.order = order;
        if !comparable || self.removed.len() > REMOVALS_KEPT {
            self.whole_before = made;
            self.removed.clear();
        }
    }

    // One photo of the list read again, in state `made`
    fn replace(&mut self, made: u64, hash: &str, json: Vec<u8>) {
        if let Some(t) = self.photos.get_mut(hash) {
            *t = Tracked { changed_at: made, json: json.into_boxed_slice() };
        }
    }

    // What differs since state `base`, as JSON; None when that can't be said
    fn since(&self, base: u64) -> Option<Vec<u8>> {
        if base < self.whole_before {
            return None;
        }
        let mut out = b"{\"changed\":[".to_vec();
        let mut some = false;
        let mut before: Option<&String> = None;
        for hash in &self.order {
            let t = self.photos.get(hash)?;
            if t.changed_at > base {
                if some {
                    out.push(b',');
                }
                some = true;
                out.extend_from_slice(b"{\"after\":");
                serde_json::to_writer(&mut out, &before).ok()?;
                out.extend_from_slice(b",\"photo\":");
                out.extend_from_slice(&t.json);
                out.push(b'}');
            }
            before = Some(hash);
        }
        let removed: Vec<&String> = self.removed.iter().filter(|(_, at)| *at > base).map(|(hash, _)| hash).collect();
        out.extend_from_slice(b"],\"removed\":");
        serde_json::to_writer(&mut out, &removed).ok()?;
        out.push(b'}');
        Some(out)
    }

    fn bytes(&self) -> usize {
        self.photos.values().map(|t| t.json.len()).sum()
    }

    // The whole list, gzipped: the same text as the array of photos written at once
    fn whole(&self) -> Result<Vec<u8>, String> {
        let failed = |e: std::io::Error| e.to_string();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(b"[").map_err(failed)?;
        for (i, hash) in self.order.iter().enumerate() {
            if i > 0 {
                gz.write_all(b",").map_err(failed)?;
            }
            gz.write_all(&self.photos.get(hash).ok_or("A photo of the kept list is missing")?.json).map_err(failed)?;
        }
        gz.write_all(b"]").map_err(failed)?;
        gz.finish().map_err(failed)
    }
}

// What the kept list is the library's list as of
struct Kept {
    version: u64,
    wholly: u64,
    // When the whole list was last made
    made: Instant,
    // The database then, or when it was last brought up to date: the newest revision, and the library's rows
    rev: i64,
    rows: i64,
    // This state of the list, and its tag
    number: u64,
    etag: String,
    // The whole list gzipped, once someone asked for this state of it
    gzipped: Option<axum::body::Bytes>,
}

#[derive(Default)]
struct Slot {
    kept: Option<Kept>,
    track: Track,
}

pub struct Listings {
    // Moves on with every change; `wholly` with those the database doesn't show photo by photo
    version: AtomicU64,
    wholly: AtomicU64,
    // Tells this run's tags from the last run's, whose states started at 1 too
    run: u64,
    made: AtomicU64,
    kept: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
}

impl Default for Listings {
    fn default() -> Listings {
        let run = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        // From 1: no state is "before" the first one
        Listings { version: AtomicU64::new(0), wholly: AtomicU64::new(0), run, made: AtomicU64::new(1), kept: Default::default() }
    }
}

// Events that change nothing a list shows
const UNCHANGING: &[&str] = &["perf-log", "face-model-download", "clip-model-download", "ollama-pull-progress"];
// Progress that only counts until its last event
const COUNTING: &[&str] = &["scan-progress", "semantic-progress", "face-quality-progress"];
// Events whose changes are all in the database, where each changed photo has a new revision. Any other event,
// also one not known here, makes the whole list anew.
const IN_THE_DATABASE: &[&str] = &[
    "photos-changed",
    "people-changed",
    "albums-changed",
    "shares-changed",
    "roles-changed",
    "thumb-batch-ready",
    "face-scan-progress",
    "face-quality-progress",
    "ai-batch-progress",
];

fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(bytes).map_err(|e| e.to_string())?;
    gz.finish().map_err(|e| e.to_string())
}

fn root_mark(root: &str) -> String {
    blake3::hash(root.as_bytes()).to_hex()[..8].to_string()
}

impl Listings {
    // Something changed in the database: the kept lists look for photos with a newer revision
    pub fn changed(&self) {
        self.version.fetch_add(1, Ordering::SeqCst);
    }

    // Something changed that the database doesn't show photo by photo: the lists are made anew
    pub fn changed_wholly(&self) {
        self.wholly.fetch_add(1, Ordering::SeqCst);
        self.changed();
    }

    pub fn note_event(&self, event: &str, payload: &serde_json::Value) {
        if UNCHANGING.contains(&event) || (COUNTING.contains(&event) && payload["done"].as_bool() != Some(true)) {
            return;
        }
        if IN_THE_DATABASE.contains(&event) {
            self.changed();
        } else {
            self.changed_wholly();
        }
    }

    fn tag(&self, number: u64, root: &str) -> String {
        format!("\"{:x}-{:x}-{}\"", self.run, number, root_mark(root))
    }

    // The state a tag of this run and this library names
    fn number_of(&self, tag: &str, root: &str) -> Option<u64> {
        let mut parts = tag.trim().trim_matches('"').split('-');
        let (run, number, mark) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() || u64::from_str_radix(run, 16).ok()? != self.run || mark != root_mark(root) {
            return None;
        }
        u64::from_str_radix(number, 16).ok()
    }

    fn slot(&self, root: &str) -> Arc<Mutex<Slot>> {
        self.kept.lock().unwrap_or_else(|e| e.into_inner()).entry(root.to_string()).or_default().clone()
    }

    // Brings the slot's list up to date: nothing to do, the changed photos read again, or the whole list made
    fn current(&self, slot: &mut Slot, host: &ServerHost, root: &str) -> Result<(), String> {
        // Read before the database is: a change that comes meanwhile is looked for again next time
        let (version, wholly) = (self.version.load(Ordering::SeqCst), self.wholly.load(Ordering::SeqCst));
        match slot.kept.as_ref().map(|k| (k.wholly == wholly && k.made.elapsed() < KEPT_FOR, k.version == version)) {
            Some((true, true)) => return Ok(()),
            Some((true, false)) if self.follow(slot, host, root, version)? => return Ok(()),
            _ => {}
        }
        self.make(slot, host, root, version, wholly)
    }

    // The whole list, made anew
    fn make(&self, slot: &mut Slot, host: &ServerHost, root: &str, version: u64, wholly: u64) -> Result<(), String> {
        let started = Instant::now();
        let (rev, rows) = {
            let conn = db::open_global_db(host)?;
            (revision::current(&conn)?, scan::library_rows(&conn, root)?)
        };
        let photos = scan::list_library_photos(host, root)?;
        let mut value = serde_json::to_value(photos).map_err(|e| e.to_string())?;
        host.hide_data_dir(&mut value);
        let mut items = Vec::new();
        for photo in value.as_array().map(Vec::as_slice).unwrap_or_default() {
            items.push((photo["hash"].as_str().unwrap_or_default().to_string(), serde_json::to_vec(photo).map_err(|e| e.to_string())?));
        }
        let count = items.len();
        let number = self.made.fetch_add(1, Ordering::SeqCst);
        slot.track.take(number, items);
        println!("[listing] {root}: {count} photos, made in {:.1} s", started.elapsed().as_secs_f64());
        slot.kept = Some(Kept { version, wholly, made: Instant::now(), rev, rows, number, etag: self.tag(number, root), gzipped: None });
        Ok(())
    }

    // The photos whose revision is newer than the kept list's, read again. False when that isn't enough: a
    // photo came or went, or the library-wide links have to be worked out again.
    fn follow(&self, slot: &mut Slot, host: &ServerHost, root: &str, version: u64) -> Result<bool, String> {
        let Slot { kept: Some(kept), track } = slot else { return Ok(false) };
        let started = Instant::now();
        let (rev, changed) = {
            let conn = db::open_global_db(host)?;
            let rev = revision::current(&conn)?;
            // A row that went has no revision to show for it
            if scan::library_rows(&conn, root)? != kept.rows {
                return Ok(false);
            }
            let Some(changed) = revision::changed_since(&conn, kept.rev, MOST_FOLLOWED)? else { return Ok(false) };
            (rev, changed)
        };
        let mut read: HashMap<String, serde_json::Value> = HashMap::new();
        for photo in scan::library_photos_by_hash(host, root, &changed)? {
            read.insert(photo.hash.clone(), serde_json::to_value(photo).map_err(|e| e.to_string())?);
        }
        let mut differ = Vec::new();
        for hash in &changed {
            match (track.photos.get(hash), read.remove(hash)) {
                // Another library's photo, or a row whose file isn't there
                (None, None) => {}
                (Some(old), Some(mut new)) => {
                    host.hide_data_dir(&mut new);
                    let old_photo: serde_json::Value = serde_json::from_slice(&old.json).map_err(|e| e.to_string())?;
                    if !scan::keep_links(&old_photo, &mut new) {
                        return Ok(false);
                    }
                    let json = serde_json::to_vec(&new).map_err(|e| e.to_string())?;
                    if *json != *old.json {
                        differ.push((hash, json));
                    }
                }
                // It came, or it went
                _ => return Ok(false),
            }
        }
        (kept.version, kept.rev) = (version, rev);
        // A change that shows in no photo leaves the list, and its tag, as they were
        if !differ.is_empty() {
            let count = differ.len();
            kept.number = self.made.fetch_add(1, Ordering::SeqCst);
            kept.etag = self.tag(kept.number, root);
            kept.gzipped = None;
            for (hash, json) in differ {
                track.replace(kept.number, hash, json);
            }
            println!("[listing] {root}: {count} photos read again in {:.0} ms", started.elapsed().as_secs_f64() * 1000.0);
        }
        Ok(true)
    }

    // How many photos the library at `root` (one of the server's, in its stored spelling) lists. Blocking, as
    // `answer` is: call them off the async threads. Two windows asking at once share one making.
    pub fn count_of(&self, host: &ServerHost, root: &str) -> Result<usize, String> {
        let slot = self.slot(root);
        let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
        self.current(&mut slot, host, root)?;
        Ok(slot.track.order.len())
    }

    // The library's list for a client that may have one already: `have` are the tags it named, `differences`
    // whether it can take only what differs from the list it has
    pub fn answer(&self, host: &ServerHost, root: &str, have: &[&str], differences: bool) -> Result<Answer, String> {
        let slot = self.slot(root);
        let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
        self.current(&mut slot, host, root)?;
        let Slot { kept: Some(kept), track } = &mut *slot else { return Err("The list was not made".to_string()) };
        let etag = kept.etag.clone();
        if have.iter().any(|tag| tag.trim() == etag) {
            return Ok(Answer::Same(etag));
        }
        if let ([base], true) = (have, differences) {
            if let Some(json) = self.number_of(base, root).filter(|n| *n < kept.number).and_then(|n| track.since(n)) {
                // Nearly everything changed: the whole list is no more to send, and less to work in
                if json.len() < SMALL_ANSWER || json.len() < track.bytes() / 2 {
                    return Ok(Answer::Differences { etag, base: base.trim().to_string(), gzipped: gzip(&json)?.into() });
                }
            }
        }
        // Gzipped once per state of the list, and only when someone needs all of it
        let gzipped = match &kept.gzipped {
            Some(gzipped) => gzipped.clone(),
            None => {
                let gzipped: axum::body::Bytes = track.whole()?.into();
                kept.gzipped = Some(gzipped.clone());
                gzipped
            }
        };
        Ok(Answer::Whole { etag, gzipped })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(photos: &[(&str, &str)]) -> Vec<(String, Vec<u8>)> {
        photos.iter().map(|(hash, rest)| (hash.to_string(), format!("{{\"hash\":\"{hash}\",\"v\":\"{rest}\"}}").into_bytes())).collect()
    }

    fn since(track: &Track, base: u64) -> Option<serde_json::Value> {
        track.since(base).map(|j| serde_json::from_slice(&j).unwrap())
    }

    #[test]
    fn lists_are_told_apart_photo_by_photo() {
        let mut t = Track::default();
        t.take(1, list(&[("a", "1"), ("b", "1"), ("c", "1")]));
        assert_eq!(since(&t, 0), None, "nobody has a list from before the first");
        assert_eq!(since(&t, 1), Some(serde_json::json!({"changed": [], "removed": []})));

        // b changed, c went, d and e came (d first in the list, e after b)
        t.take(2, list(&[("d", "1"), ("a", "1"), ("b", "2"), ("e", "1")]));
        let d = since(&t, 1).unwrap();
        assert_eq!(d["removed"], serde_json::json!(["c"]));
        let changed: Vec<(serde_json::Value, &str, &str)> =
            d["changed"].as_array().unwrap().iter().map(|c| (c["after"].clone(), c["photo"]["hash"].as_str().unwrap(), c["photo"]["v"].as_str().unwrap())).collect();
        assert_eq!(changed, vec![(serde_json::Value::Null, "d", "1"), ("a".into(), "b", "2"), ("b".into(), "e", "1")]);

        // Two lists later: what a client with list 1 and one with list 2 are sent
        t.take(3, list(&[("d", "1"), ("a", "2"), ("b", "2"), ("e", "1"), ("c", "1")]));
        let hashes = |v: &serde_json::Value| v["changed"].as_array().unwrap().iter().map(|c| c["photo"]["hash"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let from2 = since(&t, 2).unwrap();
        assert_eq!((hashes(&from2), &from2["removed"]), (vec!["a".to_string(), "c".to_string()], &serde_json::json!([])));
        // c went and came back: taken out and put in again, where it now is
        let from1 = since(&t, 1).unwrap();
        assert_eq!((hashes(&from1), &from1["removed"]), (vec!["d".to_string(), "a".into(), "b".into(), "e".into(), "c".into()], &serde_json::json!(["c"])));

        // One photo read again on its own
        t.replace(4, "e", list(&[("e", "2")]).remove(0).1);
        assert_eq!(hashes(&since(&t, 3).unwrap()), vec!["e".to_string()]);
        let whole: serde_json::Value = serde_json::from_reader(flate2::read::GzDecoder::new(&t.whole().unwrap()[..])).unwrap();
        assert_eq!(whole.as_array().unwrap().iter().map(|p| format!("{}{}", p["hash"].as_str().unwrap(), p["v"].as_str().unwrap())).collect::<Vec<_>>(), ["d1", "a2", "b2", "e2", "c1"]);

        // Photos that changed places can't be said with differences
        t.take(5, list(&[("a", "2"), ("d", "1"), ("b", "2"), ("e", "2"), ("c", "1")]));
        assert_eq!(since(&t, 4), None);
        assert_eq!(since(&t, 5), Some(serde_json::json!({"changed": [], "removed": []})));
        t.take(6, list(&[("a", "3"), ("d", "1"), ("b", "2"), ("e", "2"), ("c", "1")]));
        assert_eq!(hashes(&since(&t, 5).unwrap()), vec!["a".to_string()]);
        assert_eq!(since(&t, 4), None);
    }
}
