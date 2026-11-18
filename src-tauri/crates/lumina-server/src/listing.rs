// A library's photo list, kept ready. Listing a large library takes seconds (the queries, a look on the disk
// for every file and thumbnail, tens of megabytes of JSON), and every window that opens the library asks for
// the same list. So the list is kept (lumina-core's library_list.rs, and each photo's JSON here) and brought
// up to date when something changed:
//
// - Most changes are in the database, where every photo has a revision (revision.rs). The photos with a
//   newer one than the kept list's are read again, and only those. A photo that came is put in its place,
//   one that went is taken out.
// - After a scan, and when the list is half an hour old, each folder is looked at for files that went (their
//   rows stay). After a smart search pass the links between photos are worked out again.
// - The whole list is made anew for a change this file doesn't know (an event not named below, a library
//   added), when thousands of photos changed at once, and once a day.
//
// Every change to a library goes past the server's host as an event, or is an editing command; both say here
// that the kept lists are to be looked at again. A thread does that soon after (keep_ready), so the next
// window to open the library doesn't wait for it.
//
// Each state of a list has a tag. A client that names the list it has can be sent only what differs: the
// photos that changed or came, and the ones that went. After a restart the client gets the whole list.
//
// Only the whole list is kept: someone who sees part of a library gets theirs worked out as before.
use crate::host::ServerHost;
use lumina_core::library_list::LibraryList;
use lumina_core::types::PhotoItem;
use lumina_core::{db, libraries, revision, scan};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// How long a list goes without a look at the disk for files that went
const FILES_CHECKED_EVERY: Duration = Duration::from_secs(1800);
// How long before it is made anew whatever happened
const MADE_ANEW_EVERY: Duration = Duration::from_secs(24 * 3600);
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
    // `changed` is in the list's order and `after` the photo before it there: where a new one goes. A photo
    // in both went from its place and is put where `after` says.
    Differences { etag: String, base: String, gzipped: axum::body::Bytes },
    // The JSON array of photos as scan_folder answers it, compressed as `encoding` says
    Whole { etag: String, encoding: Encoding, body: axum::body::Bytes },
}

// How a whole list is sent: brotli to clients that take it (browsers over HTTPS, the apps), gzip to the others
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Encoding {
    Gzip,
    Brotli,
}

impl Encoding {
    pub fn name(self) -> &'static str {
        match self {
            Encoding::Gzip => "gzip",
            Encoding::Brotli => "br",
        }
    }
}

struct Tracked {
    // The state of the list (`Listings::made`) in which this photo came or last differed
    changed_at: u64,
    json: Box<[u8]>,
}

// The photos of one library's list as JSON, and what earlier states of it had
#[derive(Default)]
struct Track {
    order: Vec<String>,
    photos: HashMap<String, Tracked>,
    removed: Vec<(String, u64)>,
    // A state before this one can't be brought up to date with differences
    whole_before: u64,
}

impl Track {
    // Takes in the list's next state, `made`: its order, the JSON of the photos that came or may read
    // differently (`touched`; the others stand), and which of those may have another place in the list
    // (`moved`). Says whether anything differs from the state before.
    fn update(&mut self, made: u64, order: Vec<String>, touched: Vec<(String, Vec<u8>)>, moved: &[String]) -> bool {
        let now: HashSet<&str> = order.iter().map(String::as_str).collect();
        let moved: HashSet<&str> = moved.iter().map(String::as_str).filter(|h| self.photos.contains_key(*h) && now.contains(h)).collect();
        // Differences say where a photo goes, not that others changed places: the photos both states have
        // must be in the same order (an id twice in a list can't be told apart either). A moved photo is
        // said as one that went and came.
        let before = self.order.iter().filter(|hash| now.contains(hash.as_str()) && !moved.contains(hash.as_str()));
        let after = order.iter().filter(|hash| self.photos.contains_key(hash.as_str()) && !moved.contains(hash.as_str()));
        let comparable = !self.photos.is_empty() && now.len() == order.len() && before.eq(after);
        let mut differs = !comparable;

        for hash in &self.order {
            if !now.contains(hash.as_str()) {
                self.photos.remove(hash);
            }
            if !now.contains(hash.as_str()) || moved.contains(hash.as_str()) {
                self.removed.push((hash.clone(), made));
                differs = true;
            }
        }
        for (hash, json) in touched {
            if moved.contains(hash.as_str()) || self.photos.get(&hash).is_none_or(|t| *t.json != *json) {
                self.photos.insert(hash, Tracked { changed_at: made, json: json.into_boxed_slice() });
                differs = true;
            }
        }
        drop((now, moved));
        self.order = order;
        if !comparable || self.removed.len() > REMOVALS_KEPT {
            self.whole_before = made;
            self.removed.clear();
        }
        differs
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
        let removed: HashSet<&String> = self.removed.iter().filter(|(_, at)| *at > base).map(|(hash, _)| hash).collect();
        let mut removed: Vec<&String> = removed.into_iter().collect();
        removed.sort();
        out.extend_from_slice(b"],\"removed\":");
        serde_json::to_writer(&mut out, &removed).ok()?;
        out.push(b'}');
        Some(out)
    }

    fn bytes(&self) -> usize {
        self.photos.values().map(|t| t.json.len()).sum()
    }

    // The whole list, compressed: the same text as the array of photos written at once
    fn whole(&self, encoding: Encoding) -> Result<Vec<u8>, String> {
        let failed = |e: std::io::Error| e.to_string();
        let write = |out: &mut dyn Write| -> Result<(), String> {
            out.write_all(b"[").map_err(failed)?;
            for (i, hash) in self.order.iter().enumerate() {
                if i > 0 {
                    out.write_all(b",").map_err(failed)?;
                }
                out.write_all(&self.photos.get(hash).ok_or("A photo of the kept list is missing")?.json).map_err(failed)?;
            }
            out.write_all(b"]").map_err(failed)
        };
        match encoding {
            Encoding::Gzip => {
                let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                write(&mut gz)?;
                gz.finish().map_err(failed)
            }
            Encoding::Brotli => {
                // Quality 5: about 0.4 s for 40 MB, within 5 % of the best brotli does in 1.4 s
                let mut out = Vec::new();
                {
                    let mut br = brotli::CompressorWriter::new(&mut out, 1 << 16, 5, 22);
                    write(&mut br)?;
                    br.flush().map_err(failed)?;
                }
                Ok(out)
            }
        }
    }
}

// What the kept list is the library's list as of
struct Kept {
    list: LibraryList,
    version: u64,
    files: u64,
    links: u64,
    wholly: u64,
    // When the whole list was last made, and when the disk was last looked at for files that went
    made: Instant,
    files_checked: Instant,
    // The database then, or when the list was last brought up to date: the newest revision, the library's rows
    rev: i64,
    rows: i64,
    // This state of the list, and its tag
    number: u64,
    etag: String,
    // The whole list compressed, once someone asked for this state of it: per form (full, lean) and encoding
    compressed: Vec<((bool, Encoding), axum::body::Bytes)>,
}

#[derive(Default)]
struct Slot {
    kept: Option<Kept>,
    track: Track,
    // The same photos in their lean form (lean.rs), in the same states
    lean: Track,
}

// What changed since a list was last brought up to date. Each number moves on with changes of its kind.
#[derive(Clone, Copy, PartialEq)]
struct Marks {
    // Anything at all: the database is asked which photos have a newer revision
    version: u64,
    // Files may have come or gone (a scan ended): the folders are looked at too
    files: u64,
    // The smart search vectors, which the duplicate groups come from
    links: u64,
    // Something this file doesn't know the reach of: the list is made anew
    wholly: u64,
}

pub struct Listings {
    version: AtomicU64,
    files: AtomicU64,
    links: AtomicU64,
    wholly: AtomicU64,
    // Tells this run's tags from the last run's, whose states started at 1 too
    run: u64,
    made: AtomicU64,
    kept: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
}

impl Default for Listings {
    fn default() -> Listings {
        let run = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let zero = || AtomicU64::new(0);
        // States from 1: none is "before" the first one
        Listings { version: zero(), files: zero(), links: zero(), wholly: zero(), run, made: AtomicU64::new(1), kept: Default::default() }
    }
}

// Events that change nothing a list shows
// (an export's progress comes many times a second, for every zip someone asks for)
const UNCHANGING: &[&str] = &[
    "perf-log",
    "face-model-download",
    "clip-model-download",
    "ollama-pull-progress",
    "ffmpeg-download",
    "export-progress",
    "transcode-progress",
    "removable-drive-arrived",
];
// Progress that only counts until its last event
const COUNTING: &[&str] = &["scan-progress", "semantic-progress", "face-quality-progress", "import-progress"];
// Events whose changes are all in the database, where each changed photo has a new revision
const IN_THE_DATABASE: &[&str] = &[
    "photos-changed",
    "people-changed",
    "albums-changed",
    "shares-changed",
    "roles-changed",
    "thumb-batch-ready",
    "face-scan-progress",
    "face-quality-progress",
    "face-automatch-complete",
    "ai-batch-progress",
    // Part of a long first index was saved: the new rows have revisions
    "library-indexed",
];
// Events after which files may have come or gone
const FILES: &[&str] = &["scan-progress", "library-files-changed", "import-progress"];

fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(bytes).map_err(|e| e.to_string())?;
    gz.finish().map_err(|e| e.to_string())
}

fn root_mark(root: &str) -> String {
    blake3::hash(root.as_bytes()).to_hex()[..8].to_string()
}

// A photo as scan_folder answers it, in full and lean
fn json_of(host: &ServerHost, photo: &PhotoItem) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut value = serde_json::to_value(photo).map_err(|e| e.to_string())?;
    host.hide_data_dir(&mut value);
    let lean = crate::lean::lean_photo(&value);
    Ok((serde_json::to_vec(&value).map_err(|e| e.to_string())?, serde_json::to_vec(&lean).map_err(|e| e.to_string())?))
}

impl Listings {
    // Something changed in the database: the kept lists look for photos with a newer revision
    pub fn changed(&self) {
        self.version.fetch_add(1, Ordering::SeqCst);
    }

    // A scan ended: files may have come (they have rows now) or gone (the folders are looked at)
    pub fn changed_files(&self) {
        self.files.fetch_add(1, Ordering::SeqCst);
        self.changed();
    }

    // Something changed that this file doesn't know the reach of: the lists are made anew
    pub fn changed_wholly(&self) {
        self.wholly.fetch_add(1, Ordering::SeqCst);
        self.changed();
    }

    pub fn note_event(&self, event: &str, payload: &serde_json::Value) {
        if UNCHANGING.contains(&event) || (COUNTING.contains(&event) && payload["done"].as_bool() != Some(true)) {
            return;
        }
        if FILES.contains(&event) {
            self.changed_files();
        } else if event == "semantic-progress" {
            self.links.fetch_add(1, Ordering::SeqCst);
            self.changed();
        } else if IN_THE_DATABASE.contains(&event) {
            self.changed();
        } else {
            // Also an event not known here
            self.changed_wholly();
        }
    }

    fn marks(&self) -> Marks {
        let read = |n: &AtomicU64| n.load(Ordering::SeqCst);
        Marks { version: read(&self.version), files: read(&self.files), links: read(&self.links), wholly: read(&self.wholly) }
    }

    // The lean form's tags end in "l": a client that switches form never takes one list for the other
    fn tag(&self, number: u64, root: &str, lean: bool) -> String {
        format!("\"{:x}-{:x}-{}{}\"", self.run, number, root_mark(root), if lean { "l" } else { "" })
    }

    // The state a tag of this run, this library and this form names
    fn number_of(&self, tag: &str, root: &str, lean: bool) -> Option<u64> {
        let mut parts = tag.trim().trim_matches('"').split('-');
        let (run, number, mark) = (parts.next()?, parts.next()?, parts.next()?);
        let want = format!("{}{}", root_mark(root), if lean { "l" } else { "" });
        if parts.next().is_some() || u64::from_str_radix(run, 16).ok()? != self.run || mark != want {
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
        let marks = self.marks();
        if let Some(kept) = &slot.kept {
            let quiet = kept.version == marks.version && kept.files_checked.elapsed() < FILES_CHECKED_EVERY;
            if kept.wholly == marks.wholly && kept.made.elapsed() < MADE_ANEW_EVERY && (quiet || self.follow(slot, host, root, marks)?) {
                return Ok(());
            }
        }
        self.make(slot, host, root, marks)
    }

    // The whole list, made anew
    fn make(&self, slot: &mut Slot, host: &ServerHost, root: &str, marks: Marks) -> Result<(), String> {
        let started = Instant::now();
        let (rev, rows) = {
            let conn = db::open_global_db(host)?;
            (revision::current(&conn)?, scan::library_rows(&conn, root)?)
        };
        let list = LibraryList::make(host, root)?;
        let mut order = Vec::with_capacity(list.photos().len());
        let mut all = Vec::with_capacity(list.photos().len());
        let mut all_lean = Vec::with_capacity(list.photos().len());
        for photo in list.photos() {
            let (full, lean) = json_of(host, photo)?;
            order.push(photo.hash.clone());
            all.push((photo.hash.clone(), full));
            all_lean.push((photo.hash.clone(), lean));
        }
        let number = self.made.fetch_add(1, Ordering::SeqCst);
        slot.lean.update(number, order.clone(), all_lean, &[]);
        let differs = slot.track.update(number, order, all, &[]);
        println!("[listing] {root}: {} photos, made in {:.1} s", list.photos().len(), started.elapsed().as_secs_f64());
        // Made anew and the same as before: the list keeps its tag, and clients their copies
        let (number, etag, compressed) = match slot.kept.take() {
            Some(old) if !differs => (old.number, old.etag, old.compressed),
            _ => (number, self.tag(number, root, false), Vec::new()),
        };
        let now = Instant::now();
        let Marks { version, files, links, wholly } = marks;
        slot.kept = Some(Kept { list, version, files, links, wholly, made: now, files_checked: now, rev, rows, number, etag, compressed });
        Ok(())
    }

    // The kept list brought up to date with what changed since. False when the whole list is to be made.
    fn follow(&self, slot: &mut Slot, host: &ServerHost, root: &str, marks: Marks) -> Result<bool, String> {
        let Slot { kept: Some(kept), track, lean } = slot else { return Ok(false) };
        let started = Instant::now();
        let (rev, rows, mut look_at) = {
            let conn = db::open_global_db(host)?;
            let rev = revision::current(&conn)?;
            let Some(changed) = revision::changed_since(&conn, kept.rev, MOST_FOLLOWED)? else { return Ok(false) };
            (rev, scan::library_rows(&conn, root)?, changed)
        };
        let check_files = kept.files != marks.files || kept.files_checked.elapsed() >= FILES_CHECKED_EVERY;
        if check_files {
            look_at.extend(kept.list.missing_files());
        }
        // Rows that went leave no revision: the count shows them
        let followed = kept.list.follow(host, &look_at, rows != kept.rows, kept.links != marks.links)?;
        let photos: HashMap<&str, &PhotoItem> =
            if followed.touched.is_empty() { HashMap::new() } else { kept.list.photos().iter().map(|p| (p.hash.as_str(), p)).collect() };
        let mut touched = Vec::with_capacity(followed.touched.len());
        let mut touched_lean = Vec::with_capacity(followed.touched.len());
        for hash in &followed.touched {
            if let Some(photo) = photos.get(hash.as_str()) {
                let (full, slim) = json_of(host, photo)?;
                touched.push((hash.clone(), full));
                touched_lean.push((hash.clone(), slim));
            }
        }
        let count = (touched.len(), followed.removed.len());
        let order: Vec<String> = kept.list.photos().iter().map(|p| p.hash.clone()).collect();
        let number = self.made.fetch_add(1, Ordering::SeqCst);
        lean.update(number, order.clone(), touched_lean, &followed.moved);
        // A change that shows in no photo leaves the list, and its tag, as they were
        if track.update(number, order, touched, &followed.moved) {
            (kept.number, kept.etag, kept.compressed) = (number, self.tag(number, root, false), Vec::new());
            println!("[listing] {root}: {} read again, {} gone, in {:.0} ms", count.0, count.1, started.elapsed().as_secs_f64() * 1000.0);
        }
        (kept.version, kept.files, kept.links, kept.rev, kept.rows) = (marks.version, marks.files, marks.links, rev, rows);
        if check_files {
            kept.files_checked = Instant::now();
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
    pub fn answer(&self, host: &ServerHost, root: &str, have: &[&str], differences: bool, lean: bool, encoding: Encoding) -> Result<Answer, String> {
        let slot = self.slot(root);
        let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
        self.current(&mut slot, host, root)?;
        let Slot { kept: Some(kept), track, lean: lean_track } = &mut *slot else { return Err("The list was not made".to_string()) };
        let track = if lean { &*lean_track } else { &*track };
        let etag = if lean { self.tag(kept.number, root, true) } else { kept.etag.clone() };
        if have.iter().any(|tag| tag.trim() == etag) {
            return Ok(Answer::Same(etag));
        }
        if let ([base], true) = (have, differences) {
            if let Some(json) = self.number_of(base, root, lean).filter(|n| *n < kept.number).and_then(|n| track.since(n)) {
                // Nearly everything changed: the whole list is no more to send, and less to work in
                if json.len() < SMALL_ANSWER || json.len() < track.bytes() / 2 {
                    return Ok(Answer::Differences { etag, base: base.trim().to_string(), gzipped: gzip(&json)?.into() });
                }
            }
        }
        // Compressed once per state of the list, and only when someone needs all of it
        let body = match kept.compressed.iter().find(|(kind, _)| *kind == (lean, encoding)) {
            Some((_, body)) => body.clone(),
            None => {
                let body: axum::body::Bytes = track.whole(encoding)?.into();
                kept.compressed.push(((lean, encoding), body.clone()));
                body
            }
        };
        Ok(Answer::Whole { etag, encoding, body })
    }
}

// Brings every served library's list up to date soon after something changed, and makes them when the server
// starts, so that a window opening a library finds its list ready
pub fn keep_ready(host: Arc<ServerHost>) {
    const LOOK_EVERY: Duration = Duration::from_secs(2);
    // With nothing said: for the lists' age (the look at the disk, the making anew)
    const AT_LEAST_EVERY: Duration = Duration::from_secs(60);
    std::thread::spawn(move || {
        let mut seen: Option<(Marks, Instant)> = None;
        loop {
            let marks = host.listings.marks();
            if seen.is_none_or(|(m, at)| m != marks || at.elapsed() >= AT_LEAST_EVERY) {
                let roots = db::open_global_db(&*host).and_then(|conn| libraries::list(&conn)).map(crate::settings::served).unwrap_or_default();
                for library in roots {
                    if let Err(e) = host.listings.count_of(&host, &library.root) {
                        eprintln!("[listing] {}: {e}", library.root);
                    }
                }
                seen = Some((marks, Instant::now()));
            }
            std::thread::sleep(LOOK_EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(photos: &[(&str, &str)]) -> Vec<(String, Vec<u8>)> {
        photos.iter().map(|(hash, rest)| (hash.to_string(), format!("{{\"hash\":\"{hash}\",\"v\":\"{rest}\"}}").into_bytes())).collect()
    }

    // A list made anew: every photo may read differently
    fn take(track: &mut Track, made: u64, items: Vec<(String, Vec<u8>)>) -> bool {
        track.update(made, items.iter().map(|(hash, _)| hash.clone()).collect(), items, &[])
    }

    fn since(track: &Track, base: u64) -> Option<serde_json::Value> {
        track.since(base).map(|j| serde_json::from_slice(&j).unwrap())
    }

    #[test]
    fn lists_are_told_apart_photo_by_photo() {
        let mut t = Track::default();
        take(&mut t, 1, list(&[("a", "1"), ("b", "1"), ("c", "1")]));
        assert_eq!(since(&t, 0), None, "nobody has a list from before the first");
        assert_eq!(since(&t, 1), Some(serde_json::json!({"changed": [], "removed": []})));

        // b changed, c went, d and e came (d first in the list, e after b)
        take(&mut t, 2, list(&[("d", "1"), ("a", "1"), ("b", "2"), ("e", "1")]));
        let d = since(&t, 1).unwrap();
        assert_eq!(d["removed"], serde_json::json!(["c"]));
        let changed: Vec<(serde_json::Value, &str, &str)> =
            d["changed"].as_array().unwrap().iter().map(|c| (c["after"].clone(), c["photo"]["hash"].as_str().unwrap(), c["photo"]["v"].as_str().unwrap())).collect();
        assert_eq!(changed, vec![(serde_json::Value::Null, "d", "1"), ("a".into(), "b", "2"), ("b".into(), "e", "1")]);

        // Two lists later: what a client with list 1 and one with list 2 are sent
        take(&mut t, 3, list(&[("d", "1"), ("a", "2"), ("b", "2"), ("e", "1"), ("c", "1")]));
        let hashes = |v: &serde_json::Value| v["changed"].as_array().unwrap().iter().map(|c| c["photo"]["hash"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let from2 = since(&t, 2).unwrap();
        assert_eq!((hashes(&from2), &from2["removed"]), (vec!["a".to_string(), "c".to_string()], &serde_json::json!([])));
        // c went and came back: taken out and put in again, where it now is
        let from1 = since(&t, 1).unwrap();
        assert_eq!((hashes(&from1), &from1["removed"]), (vec!["d".to_string(), "a".into(), "b".into(), "e".into(), "c".into()], &serde_json::json!(["c"])));

        // One photo read again on its own; the same again differs in nothing
        let order = || ["d", "a", "b", "e", "c"].map(String::from).to_vec();
        assert!(t.update(4, order(), list(&[("e", "2")]), &[]));
        assert!(!t.update(5, order(), list(&[("e", "2")]), &[]));
        assert_eq!(hashes(&since(&t, 3).unwrap()), vec!["e".to_string()]);
        // A photo with a new name has another place: said as one that went and came
        assert!(t.update(5, ["a", "b", "e", "c", "d"].map(String::from).to_vec(), list(&[("d", "1")]), &["d".to_string()]));
        let from4 = since(&t, 4).unwrap();
        assert_eq!((hashes(&from4), &from4["removed"], &from4["changed"][0]["after"]), (vec!["d".to_string()], &serde_json::json!(["d"]), &serde_json::json!("c")));
        assert!(t.update(6, order(), list(&[("d", "1")]), &["d".to_string()]));
        let whole: serde_json::Value = serde_json::from_reader(flate2::read::GzDecoder::new(&t.whole(Encoding::Gzip).unwrap()[..])).unwrap();
        let in_brotli: serde_json::Value = serde_json::from_reader(brotli::Decompressor::new(&t.whole(Encoding::Brotli).unwrap()[..], 4096)).unwrap();
        assert_eq!(in_brotli, whole, "the same list in either encoding");
        assert_eq!(whole.as_array().unwrap().iter().map(|p| format!("{}{}", p["hash"].as_str().unwrap(), p["v"].as_str().unwrap())).collect::<Vec<_>>(), ["d1", "a2", "b2", "e2", "c1"]);

        // Photos that changed places can't be said with differences
        take(&mut t, 7, list(&[("a", "2"), ("d", "1"), ("b", "2"), ("e", "2"), ("c", "1")]));
        assert_eq!(since(&t, 6), None);
        assert_eq!(since(&t, 7), Some(serde_json::json!({"changed": [], "removed": []})));
        take(&mut t, 8, list(&[("a", "3"), ("d", "1"), ("b", "2"), ("e", "2"), ("c", "1")]));
        assert_eq!(hashes(&since(&t, 7).unwrap()), vec!["a".to_string()]);
        assert_eq!(since(&t, 6), None);
    }
}
