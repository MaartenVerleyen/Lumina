// A library's photo list, kept ready. Listing a large library takes seconds (the queries, a look on the disk
// for every file and thumbnail, tens of megabytes of JSON, gzip), and every window that opens the library asks
// for the same list. So the finished answer is kept, gzipped, until something changes: every change to a
// library goes past the server's host as an event, or is an editing command, and both move `version` on.
// A kept list also has an age limit, for a change that tells nobody (a file deleted on the server's disk
// while the watcher is off).
//
// Only the whole list is kept: someone who sees part of a library gets theirs worked out as before.
use crate::host::ServerHost;
use lumina_core::scan;
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const KEPT_FOR: Duration = Duration::from_secs(600);

pub struct Listing {
    // The JSON array of photos as scan_folder answers it, gzipped
    pub gzipped: axum::body::Bytes,
    pub photos: usize,
    // Names this list: the same tag means the same list, also for a client that kept its copy
    pub etag: String,
}

struct Kept {
    version: u64,
    made: Instant,
    listing: Arc<Listing>,
}

pub struct Listings {
    version: AtomicU64,
    // Tells this run's tags from the last run's, whose versions started at 0 too
    run: u64,
    made: AtomicU64,
    kept: Mutex<HashMap<String, Arc<Mutex<Option<Kept>>>>>,
}

impl Default for Listings {
    fn default() -> Listings {
        let run = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        Listings { version: AtomicU64::new(0), run, made: AtomicU64::new(0), kept: Default::default() }
    }
}

// Events that change nothing a list shows; any other event, also one not known here, ends the kept lists
const UNCHANGING: &[&str] = &["perf-log", "face-model-download", "clip-model-download", "ollama-pull-progress"];
// Progress that only counts until its last event
const COUNTING: &[&str] = &["scan-progress", "semantic-progress", "face-quality-progress"];

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

    // The list of the library at `root` (one of the server's, in its stored spelling), made now if the kept
    // one is out of date. Blocking: call it off the async threads. Two windows asking at once share one making.
    pub fn of(&self, host: &ServerHost, root: &str) -> Result<Arc<Listing>, String> {
        let slot = self.kept.lock().unwrap_or_else(|e| e.into_inner()).entry(root.to_string()).or_default().clone();
        let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
        // Read before the list is made: a change that comes during the making ends this list too
        let version = self.version.load(Ordering::SeqCst);
        if let Some(kept) = slot.as_ref() {
            if kept.version == version && kept.made.elapsed() < KEPT_FOR {
                return Ok(kept.listing.clone());
            }
        }
        let started = Instant::now();
        let photos = scan::list_library_photos(host, root)?;
        let count = photos.len();
        let mut value = serde_json::to_value(photos).map_err(|e| e.to_string())?;
        host.hide_data_dir(&mut value);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        serde_json::to_writer(&mut gz, &value).map_err(|e| e.to_string())?;
        gz.flush().map_err(|e| e.to_string())?;
        let gzipped = gz.finish().map_err(|e| e.to_string())?;
        println!(
            "[listing] {root}: {count} photos, {:.1} MB gzipped, made in {:.1} s",
            gzipped.len() as f64 / 1e6,
            started.elapsed().as_secs_f64()
        );
        let listing = Arc::new(Listing {
            gzipped: gzipped.into(),
            photos: count,
            // Every making has a tag of its own (a list made again after its age limit may differ too)
            etag: format!("\"{:x}-{:x}-{}\"", self.run, self.made.fetch_add(1, Ordering::SeqCst), &blake3::hash(root.as_bytes()).to_hex()[..8]),
        });
        *slot = Some(Kept { version, made: Instant::now(), listing: listing.clone() });
        Ok(listing)
    }
}
