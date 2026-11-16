// A library's photo list, kept ready. Listing a large library takes seconds (the queries, a look on the disk
// for every file and thumbnail, tens of megabytes of JSON, gzip), and every window that opens the library asks
// for the same list. So the finished answer is kept, gzipped, until something changes: every change to a
// library goes past the server's host as an event, or is an editing command, and both move `version` on.
// A kept list also has an age limit, for a change that tells nobody (a file deleted on the server's disk
// while the watcher is off).
//
// Each list made is compared with the one before it, photo by photo. A client that names the list it has (its
// tag) can so be sent only what differs: the photos that changed or came, and the ones that went. Nothing of
// this is in the database: after a restart, or when too much changed, the client gets the whole list.
//
// Only the whole list is kept: someone who sees part of a library gets theirs worked out as before.
use crate::host::ServerHost;
use lumina_core::scan;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const KEPT_FOR: Duration = Duration::from_secs(600);
// How much of changed photos' JSON is held to answer with differences. Past it (a pass that touches every
// photo) clients get the whole list again.
const CHANGES_KEPT: usize = 32 * 1024 * 1024;
const REMOVALS_KEPT: usize = 100_000;
// Differences up to this size are sent whatever the size of the whole list
const SMALL_ANSWER: usize = 64 * 1024;

pub struct Listing {
    // The JSON array of photos as scan_folder answers it, gzipped
    pub gzipped: axum::body::Bytes,
    pub photos: usize,
    // Names this list: the same tag means the same list, also for a client that kept its copy
    pub etag: String,
}

// What a client that has a list (or none) is sent
pub enum Answer {
    // Its list is this one
    Same(String),
    // What differs from the list it named (`base`), gzipped JSON:
    // {"changed": [{"after": hash or null, "photo": {...}}, ...], "removed": [hash, ...]}
    // `changed` is in the list's order and `after` the photo before it there: where a new one goes.
    Differences { etag: String, base: String, gzipped: axum::body::Bytes },
    Whole(Arc<Listing>),
}

struct Tracked {
    print: [u8; 16],
    // The making (`Listings::made`) in which this photo came or last differed
    changed_at: u64,
    // Its JSON since then, to send; none for a photo unchanged since the first list
    json: Option<Box<[u8]>>,
}

// What the lists of one library had in them, to tell a later one from an earlier one
#[derive(Default)]
struct Track {
    order: Vec<String>,
    photos: HashMap<String, Tracked>,
    removed: Vec<(String, u64)>,
    // A list made before this one can't be brought up to date with differences
    whole_before: u64,
    kept_bytes: usize,
}

impl Track {
    fn start_over(&mut self, made: u64) {
        self.whole_before = made;
        self.removed.clear();
        self.kept_bytes = 0;
        for t in self.photos.values_mut() {
            t.json = None;
        }
    }

    // Takes in the list made as number `made`: each photo's id and JSON, in the list's order
    fn take(&mut self, made: u64, items: Vec<(String, Vec<u8>)>) {
        let first = self.photos.is_empty();
        let now: HashSet<&str> = items.iter().map(|(hash, _)| hash.as_str()).collect();
        // Differences say where a new photo goes, not that others changed places: the photos both lists
        // have must be in the same order (an id twice in a list can't be told apart either)
        let before = self.order.iter().filter(|hash| now.contains(hash.as_str()));
        let after = items.iter().map(|(hash, _)| hash).filter(|hash| self.photos.contains_key(hash.as_str()));
        let comparable = now.len() == items.len() && before.eq(after);

        for hash in &self.order {
            if !now.contains(hash.as_str()) {
                if let Some(gone) = self.photos.remove(hash) {
                    self.kept_bytes -= gone.json.map_or(0, |j| j.len());
                }
                self.removed.push((hash.clone(), made));
            }
        }
        let mut order = Vec::with_capacity(items.len());
        for (hash, json) in items {
            let print: [u8; 16] = blake3::hash(&json).as_bytes()[..16].try_into().unwrap();
            let known = self.photos.get(&hash);
            if known.is_none_or(|t| t.print != print) {
                self.kept_bytes -= known.and_then(|t| t.json.as_ref()).map_or(0, |j| j.len());
                // The first list is what later ones are compared with: nobody is sent differences from before it
                let json = (!first).then(|| json.into_boxed_slice());
                self.kept_bytes += json.as_ref().map_or(0, |j| j.len());
                self.photos.insert(hash.clone(), Tracked { print, changed_at: made, json });
            }
            order.push(hash);
        }
        self.order = order;
        if first || !comparable || self.kept_bytes > CHANGES_KEPT || self.removed.len() > REMOVALS_KEPT {
            self.start_over(made);
        }
    }

    // What differs since the list made as number `base`, as JSON; None when that can't be said
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
                out.extend_from_slice(t.json.as_deref()?);
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
}

struct Kept {
    version: u64,
    made: Instant,
    number: u64,
    listing: Arc<Listing>,
}

#[derive(Default)]
struct Slot {
    kept: Option<Kept>,
    track: Track,
}

pub struct Listings {
    version: AtomicU64,
    // Tells this run's tags from the last run's, whose versions started at 0 too
    run: u64,
    made: AtomicU64,
    kept: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
}

impl Default for Listings {
    fn default() -> Listings {
        let run = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        // From 1: no list is "made before" the first one
        Listings { version: AtomicU64::new(0), run, made: AtomicU64::new(1), kept: Default::default() }
    }
}

// Events that change nothing a list shows; any other event, also one not known here, ends the kept lists
const UNCHANGING: &[&str] = &["perf-log", "face-model-download", "clip-model-download", "ollama-pull-progress"];
// Progress that only counts until its last event
const COUNTING: &[&str] = &["scan-progress", "semantic-progress", "face-quality-progress"];

fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(bytes).map_err(|e| e.to_string())?;
    gz.finish().map_err(|e| e.to_string())
}

fn root_mark(root: &str) -> String {
    blake3::hash(root.as_bytes()).to_hex()[..8].to_string()
}

impl Listings {
    // Something changed: lists made before now are no longer the library
    pub fn changed(&self) {
        self.version.fetch_add(1, Ordering::SeqCst);
    }

    pub fn note_event(&self, event: &str, payload: &serde_json::Value) {
        let counting = COUNTING.contains(&event) && payload["done"].as_bool() != Some(true);
        if !UNCHANGING.contains(&event) && !counting {
            self.changed();
        }
    }

    // Every making has a tag of its own (a list made again after its age limit may differ too)
    fn tag(&self, number: u64, root: &str) -> String {
        format!("\"{:x}-{:x}-{}\"", self.run, number, root_mark(root))
    }

    // The number of the making a tag of this run and this library names
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

    // The slot's list, made now if the kept one is out of date
    fn current(&self, slot: &mut Slot, host: &ServerHost, root: &str) -> Result<(u64, Arc<Listing>), String> {
        // Read before the list is made: a change that comes during the making ends this list too
        let version = self.version.load(Ordering::SeqCst);
        if let Some(kept) = slot.kept.as_ref() {
            if kept.version == version && kept.made.elapsed() < KEPT_FOR {
                return Ok((kept.number, kept.listing.clone()));
            }
        }
        let started = Instant::now();
        let photos = scan::list_library_photos(host, root)?;
        let mut value = serde_json::to_value(photos).map_err(|e| e.to_string())?;
        host.hide_data_dir(&mut value);
        // Photo by photo: the same text as the whole array written at once, and each photo's own for the
        // comparison with the list before
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut items = Vec::new();
        let write = |e: std::io::Error| e.to_string();
        gz.write_all(b"[").map_err(write)?;
        for (i, photo) in value.as_array().map(Vec::as_slice).unwrap_or_default().iter().enumerate() {
            let json = serde_json::to_vec(photo).map_err(|e| e.to_string())?;
            if i > 0 {
                gz.write_all(b",").map_err(write)?;
            }
            gz.write_all(&json).map_err(write)?;
            items.push((photo["hash"].as_str().unwrap_or_default().to_string(), json));
        }
        gz.write_all(b"]").map_err(write)?;
        let gzipped = gz.finish().map_err(write)?;
        let count = items.len();
        let number = self.made.fetch_add(1, Ordering::SeqCst);
        slot.track.take(number, items);
        println!(
            "[listing] {root}: {count} photos, {:.1} MB gzipped, made in {:.1} s",
            gzipped.len() as f64 / 1e6,
            started.elapsed().as_secs_f64()
        );
        let listing = Arc::new(Listing { gzipped: gzipped.into(), photos: count, etag: self.tag(number, root) });
        slot.kept = Some(Kept { version, made: Instant::now(), number, listing: listing.clone() });
        Ok((number, listing))
    }

    // The list of the library at `root` (one of the server's, in its stored spelling), made now if the kept
    // one is out of date. Blocking: call it off the async threads. Two windows asking at once share one making.
    pub fn of(&self, host: &ServerHost, root: &str) -> Result<Arc<Listing>, String> {
        let slot = self.slot(root);
        let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
        Ok(self.current(&mut slot, host, root)?.1)
    }

    // The same for a client that may have a list already: `have` are the tags it named, `differences` whether
    // it can take only what differs from the list it has
    pub fn answer(&self, host: &ServerHost, root: &str, have: &[&str], differences: bool) -> Result<Answer, String> {
        let slot = self.slot(root);
        let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
        let (number, listing) = self.current(&mut slot, host, root)?;
        if have.iter().any(|tag| tag.trim() == listing.etag) {
            return Ok(Answer::Same(listing.etag.clone()));
        }
        if let ([base], true) = (have, differences) {
            let json = self.number_of(base, root).filter(|n| *n < number).and_then(|n| slot.track.since(n));
            if let Some(gzipped) = json.map(|j| gzip(&j)).transpose()? {
                // Nearly everything changed: the whole list is no more to send, and less to work in
                if gzipped.len() < SMALL_ANSWER || gzipped.len() < listing.gzipped.len() / 2 {
                    return Ok(Answer::Differences { etag: listing.etag.clone(), base: base.trim().to_string(), gzipped: gzipped.into() });
                }
            }
        }
        Ok(Answer::Whole(listing))
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

        // Photos that changed places can't be said with differences
        t.take(4, list(&[("a", "2"), ("d", "1"), ("b", "2"), ("e", "1"), ("c", "1")]));
        assert_eq!(since(&t, 3), None);
        assert_eq!(since(&t, 4), Some(serde_json::json!({"changed": [], "removed": []})));
        t.take(5, list(&[("a", "3"), ("d", "1"), ("b", "2"), ("e", "1"), ("c", "1")]));
        assert_eq!(hashes(&since(&t, 4).unwrap()), vec!["a".to_string()]);
        assert_eq!(since(&t, 3), None);
    }
}
