// A library's listing that is kept and brought up to date, where scan::list_library_photos makes it anew
// each time (seconds for a large library). A server keeps one per library (lumina-server's listing.rs) and
// tells it which photos to read again: those with a newer revision (revision.rs), and those a scan no longer
// found. Photos that came are put in their place, those that went are taken out, and the links between
// photos (scan::link_library) are worked out again only when something they come from changed.
use crate::db::open_global_db;
use crate::host::Host;
use crate::scan;
use crate::types::PhotoItem;
use std::collections::{HashMap, HashSet};

pub struct LibraryList {
    root: String,
    // In the listing's order
    photos: Vec<PhotoItem>,
}

// What bringing a list up to date did to it
#[derive(Default, Debug, PartialEq)]
pub struct Followed {
    // Photos that came, or that may read differently now
    pub touched: Vec<String>,
    // Of those, the ones whose place in the list may have changed (a new name or folder)
    pub moved: Vec<String>,
    // Photos that are no longer in the list
    pub removed: Vec<String>,
}

// What the links between photos are worked out from, besides the smart search vectors
fn links_from(p: &PhotoItem) -> (&str, &str, &str, &str, Option<u64>, &str, &str, bool) {
    (&p.name, &p.subfolder, &p.captured_at, &p.media_type, p.duration_ms, &p.dhash, &p.camera_model, p.tags.iter().any(|t| t == "screenshot"))
}

type Links = (Option<usize>, Option<String>, Option<String>, Option<String>, Option<String>);

// What they set
fn links(p: &PhotoItem) -> Links {
    (p.duplicate_group, p.live_video_hash.clone(), p.live_video_path.clone(), p.live_photo_hash.clone(), p.pair_raw_path.clone())
}

fn is_jpeg(name: &str) -> bool {
    let name = name.to_lowercase();
    name.ends_with(".jpg") || name.ends_with(".jpeg")
}

impl LibraryList {
    pub fn make<H: Host + ?Sized>(app: &H, root: &str) -> Result<LibraryList, String> {
        Ok(LibraryList { root: root.to_string(), photos: scan::list_library_photos(app, root)? })
    }

    pub fn photos(&self) -> &[PhotoItem] {
        &self.photos
    }

    // The photos whose file is no longer on the disk (a look at each folder, not at each file): for `follow`
    // to look at, after a scan or when nobody may have said that files went
    pub fn missing_files(&self) -> Vec<String> {
        let mut folders = scan::Folders::default();
        let mut missing = Vec::new();
        for p in &self.photos {
            // A RAW or HEIC shows its preview as `path` and names its own file in pair_raw_path
            let ext = std::path::Path::new(&p.name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let file = if crate::decode::is_raw_or_heic_ext(&ext) { p.pair_raw_path.as_deref().unwrap_or(&p.path) } else { &p.path };
            if !folders.has(std::path::Path::new(file)) {
                missing.push(p.hash.clone());
            }
        }
        missing
    }

    // Brings the list up to date.
    //   look_at     photos to read again: changed in the database, or no longer found by a scan
    //   rows_went   rows of the library may have gone from the database (they leave no revision behind)
    //   relink      the links are worked out again whatever changed (new smart search vectors)
    pub fn follow<H: Host + ?Sized>(&mut self, app: &H, look_at: &[String], rows_went: bool, relink: bool) -> Result<Followed, String> {
        let conn = open_global_db(app)?;
        let read = scan::library_photos_by_hash(app, &self.root, look_at)?;
        let place: HashMap<String, usize> = self.photos.iter().enumerate().map(|(i, p)| (p.hash.clone(), i)).collect();
        let read_ids: HashSet<&str> = read.iter().map(|p| p.hash.as_str()).collect();
        let mut followed = Followed::default();
        // Looked at and not read: the file is gone, or the photo left the library
        let mut gone: HashSet<String> = look_at.iter().filter(|h| place.contains_key(*h) && !read_ids.contains(h.as_str())).cloned().collect();
        let came = read.iter().any(|p| !place.contains_key(&p.hash));
        // A row that went is seen in the count of rows, unless another came in its place
        if rows_went || came {
            let rows = scan::library_hashes(&conn, &self.root)?;
            gone.extend(place.keys().filter(|h| !rows.contains(*h)).cloned());
        }

        let mut relink = relink || came || !gone.is_empty();
        let mut resort = came;
        for mut new in read {
            followed.touched.push(new.hash.clone());
            match place.get(&new.hash) {
                Some(&i) => {
                    let old = &self.photos[i];
                    if links_from(old) != links_from(&new) {
                        relink = true;
                    }
                    if (&old.subfolder, &old.name) != (&new.subfolder, &new.name) {
                        resort = true;
                        followed.moved.push(new.hash.clone());
                    }
                    // Read on its own it has no links; they stand until worked out again
                    (new.duplicate_group, new.live_video_hash, new.live_video_path, new.live_photo_hash) =
                        (old.duplicate_group, old.live_video_hash.clone(), old.live_video_path.clone(), old.live_photo_hash.clone());
                    if new.pair_raw_path.is_none() {
                        new.pair_raw_path = old.pair_raw_path.clone();
                    }
                    self.photos[i] = new;
                }
                None => self.photos.push(new),
            }
        }
        if !gone.is_empty() {
            self.photos.retain(|p| !gone.contains(&p.hash));
            followed.removed = gone.into_iter().collect();
            followed.removed.sort();
        }
        if resort {
            scan::sort_library(&mut self.photos);
        }
        if relink {
            let before: HashMap<String, Links> = self.photos.iter().map(|p| (p.hash.clone(), links(p))).collect();
            for p in &mut self.photos {
                (p.live_video_hash, p.live_video_path, p.live_photo_hash) = (None, None, None);
                // A RAW or HEIC names itself here (scan::photo_item); a JPEG its RAW, which the pairing gives it
                if is_jpeg(&p.name) {
                    p.pair_raw_path = None;
                }
            }
            scan::link_library(&conn, &mut self.photos);
            let already: HashSet<String> = followed.touched.iter().cloned().collect();
            followed.touched.extend(self.photos.iter().filter(|p| !already.contains(&p.hash) && before.get(&p.hash) != Some(&links(p))).map(|p| p.hash.clone()));
        }
        Ok(followed)
    }
}
