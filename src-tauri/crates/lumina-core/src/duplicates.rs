use crate::*;

// Duplicates: the same photo more than once in the library, as opposed to a burst (similar shots).
//  - "exact": byte-identical copies (a Google Takeout export holds a photo once per album it is in).
//    Proven without reading the files: a copy's ID is the original's content hash salted with the copy's
//    path (scan::resolve_hash_collisions), so salt(A, path of B) == B means B is a copy of A.
//  - "same_photo": the same shot as different files (resized by Google Photos, a developed export, an edit,
//    a black and white version): taken in the same second and looking alike. RAW files are left out (a RAW
//    is the source of its JPG, not a duplicate of it), and so are bursts: two frame numbers of one camera,
//    or a phone's "_01" frame. Files whose names don't tie them to one shot (UUIDs, renamed exports, a time
//    that only came from copying the files) must also match closely on their thumbnails, as a burst where
//    someone moved still passes the 64-bit fingerprint.
// Every set lists the copy to keep first: the largest, then the oldest, then the one with the most information.

#[derive(Serialize)]
pub struct DuplicateSet {
    pub kind: String,
    pub hashes: Vec<String>,
}

#[derive(Clone)]
pub struct DupRow {
    pub hash: String,
    pub path: String,
    pub size: i64,
    pub mtime: i64,
    pub pixels: i64,
    pub captured_at: String,
    pub dhash: Option<u64>,
    // Ratings, flags, tags, people, caption and albums the user gave it
    pub info: i64,
}

// Fingerprint bits two versions of one shot may differ by (calibrated 2026-10-29 on 55k same-second pairs:
// black and white versions and developed exports differ by 0-4)
const SAME_PHOTO_MAX_BITS: u32 = 6;
const SAME_PHOTO_MAX_BITS_WITHOUT_CLIP: u32 = 4;
// Same-second pairs that really were one shot scored down to 0.77 (a black and white version); lower is two
// cameras catching the same moment
const SAME_PHOTO_MIN_CLIP: f32 = 0.75;
// Edge correlation of two thumbnails at 64x64 for files with unrelated names (calibrated 2026-10-31 on
// 13k same-second pairs): copies and edits score 0.95-1; bursts where a child or a dog moved score lower
const SAME_PHOTO_MIN_EDGES: f32 = 0.95;
pub const LOOK_EDGE: u32 = 64;
const RAW_EXTENSIONS: &[&str] = &["cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "pef", "raf"];
// What Google Photos and phone editors append to an edited copy's name
const EDIT_MARKERS: &[&str] = &["edited", "bewerkt", "bearbeitet", "modifié", "effects", "smile", "collage", "pano", "motion"];

// The copy to keep sorts first: largest (pixels, then bytes), oldest (capture time, then file time), most info,
// then the shortest path
pub fn keeper_order(a: &DupRow, b: &DupRow) -> std::cmp::Ordering {
    let date = |r: &DupRow| if r.captured_at.is_empty() { "9999".to_string() } else { r.captured_at.clone() };
    let mtime = |r: &DupRow| if r.mtime > 0 { r.mtime } else { i64::MAX };
    b.pixels
        .cmp(&a.pixels)
        .then(b.size.cmp(&a.size))
        .then(date(a).cmp(&date(b)))
        .then(mtime(a).cmp(&mtime(b)))
        .then(b.info.cmp(&a.info))
        .then(a.path.len().cmp(&b.path.len()))
        .then(a.path.cmp(&b.path))
}

fn find(parent: &mut [usize], i: usize) -> usize {
    let mut r = i;
    while parent[r] != r {
        r = parent[r];
    }
    let mut c = i;
    while parent[c] != r {
        let next = parent[c];
        parent[c] = r;
        c = next;
    }
    r
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let (ra, rb) = (find(parent, a), find(parent, b));
    if ra != rb {
        parent[rb] = ra;
    }
}

fn sets_from(parent: &mut [usize], members: &[usize]) -> Vec<Vec<usize>> {
    let mut by_root: HashMap<usize, Vec<usize>> = HashMap::new();
    for &i in members {
        let r = find(parent, i);
        by_root.entry(r).or_default().push(i);
    }
    by_root.into_values().filter(|s| s.len() > 1).collect()
}

// Sets of byte-identical copies (indices into `rows`)
pub fn exact_copy_sets(rows: &[DupRow]) -> Vec<Vec<usize>> {
    let mut by_size: HashMap<i64, Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        if r.size > 0 {
            by_size.entry(r.size).or_default().push(i);
        }
    }
    let mut parent: Vec<usize> = (0..rows.len()).collect();
    let mut linked = Vec::new();
    for members in by_size.values().filter(|m| m.len() > 1) {
        for &copy in members {
            for &original in members {
                if copy != original && scan::salt_hash_with_path(&rows[original].hash, &rows[copy].path) == rows[copy].hash {
                    union(&mut parent, original, copy);
                    linked.push(original);
                    linked.push(copy);
                }
            }
        }
    }
    linked.sort_unstable();
    linked.dedup();
    sets_from(&mut parent, &linked)
}

// "IMG_7619" -> ("img", 7619): a camera's own file name, to tell two frames of one burst apart
pub fn camera_frame(path: &str) -> Option<(String, u64)> {
    let stem = Path::new(path).file_stem()?.to_string_lossy().to_lowercase();
    let prefix: String = stem.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    if prefix.is_empty() || prefix.len() > 5 {
        return None;
    }
    let rest = stem[prefix.len()..].trim_start_matches('_');
    // An iPhone edit: IMG_E7619
    let rest = if prefix == "img" { rest.strip_prefix('e').unwrap_or(rest) } else { rest };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() < 3 || digits.len() > 6 {
        return None;
    }
    Some((prefix, digits.parse().ok()?))
}

fn is_raw(path: &str) -> bool {
    Path::new(path)
        .extension()
        .map(|e| RAW_EXTENSIONS.contains(&e.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

// The file name without what copies and edits add: "IMG_5748.CR3.jpg", "MAARTEN - IMG_5748(1).jpg" and
// "IMG_5748-EFFECTS-edited.jpg" are all "img_5748"
fn base_name(path: &str) -> String {
    let mut s = Path::new(path).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    if let Some((_, after)) = s.rsplit_once(" - ") {
        s = after.to_string();
    }
    loop {
        let before = s.len();
        if let Some((stem, ext)) = s.rsplit_once('.')
            && (RAW_EXTENSIONS.contains(&ext) || ["jpg", "jpeg", "heic", "png"].contains(&ext))
        {
            s = stem.to_string();
        }
        if let Some((stem, tag)) = s.rsplit_once('-')
            && EDIT_MARKERS.contains(&tag)
        {
            s = stem.to_string();
        }
        for (open, close) in [("(", ")"), ("~", "")] {
            if let Some((stem, n)) = s.rsplit_once(open)
                && let Some(n) = n.strip_suffix(close)
                && !n.is_empty()
                && n.chars().all(|c| c.is_ascii_digit())
            {
                s = stem.to_string();
            }
        }
        if let Some(stem) = s.strip_suffix(" copy") {
            s = stem.to_string();
        }
        s = s.trim().to_string();
        if s.len() == before {
            return s;
        }
    }
}

// "IMG20250906145215_01" -> ("img20250906145215", 1): a phone's numbered frames within one second, named
// after the date and time ("IMG_20171018_213508_012", "IMG_20210926_105547__01")
fn timed_frame(path: &str) -> Option<(String, u32)> {
    let name = base_name(path);
    let (base, n) = match name.rsplit_once('_') {
        Some((base, n)) if (1..=3).contains(&n.len()) && n.chars().all(|c| c.is_ascii_digit()) => {
            (base.trim_end_matches('_'), n.parse().ok()?)
        }
        _ => (name.as_str(), 0),
    };
    (base.chars().filter(|c| c.is_ascii_digit()).count() >= 14).then(|| (base.to_string(), n))
}

// What the file names alone say about two photos taken in the same second
#[derive(PartialEq, Debug)]
pub enum NamesSay {
    // Two frames of one burst
    OtherShot,
    // The same camera frame, or one file named after the other
    SameShot,
    // Unrelated names: only the pictures can tell
    Unknown,
}

pub fn names_say(a: &str, b: &str) -> NamesSay {
    if let (Some(fa), Some(fb)) = (camera_frame(a), camera_frame(b))
        && fa.0 == fb.0
    {
        return if fa.1 == fb.1 { NamesSay::SameShot } else { NamesSay::OtherShot };
    }
    if let (Some(fa), Some(fb)) = (timed_frame(a), timed_frame(b))
        && fa.0 == fb.0
        && fa.1 != fb.1
    {
        return NamesSay::OtherShot;
    }
    if base_name(a) == base_name(b) { NamesSay::SameShot } else { NamesSay::Unknown }
}

// Whether two photos taken in the same second are one shot (see the module comment). `None`: they may be,
// if their thumbnails match closely (`look_similarity`).
pub fn same_photo_by_data(a: &DupRow, b: &DupRow, clip: &HashMap<String, Vec<f32>>) -> Option<bool> {
    if is_raw(&a.path) || is_raw(&b.path) {
        return Some(false);
    }
    let names = names_say(&a.path, &b.path);
    if names == NamesSay::OtherShot {
        return Some(false);
    }
    let (Some(ha), Some(hb)) = (a.dhash, b.dhash) else {
        return Some(false);
    };
    let bits = (ha ^ hb).count_ones();
    let alike = match (clip.get(&a.hash), clip.get(&b.hash)) {
        (Some(va), Some(vb)) => bits <= SAME_PHOTO_MAX_BITS && face_match::dot(va, vb) >= SAME_PHOTO_MIN_CLIP,
        _ => bits <= SAME_PHOTO_MAX_BITS_WITHOUT_CLIP,
    };
    if !alike {
        return Some(false);
    }
    (names == NamesSay::SameShot).then_some(true)
}

// How surely two photos are one shot, or None when they aren't: matching names beat any look
fn link_strength(a: &DupRow, b: &DupRow, clip: &HashMap<String, Vec<f32>>, looks: &HashMap<String, Vec<u8>>) -> Option<f32> {
    match same_photo_by_data(a, b, clip) {
        Some(true) => Some(2.0),
        Some(false) => None,
        None => {
            let score = look_similarity(looks.get(&a.hash)?, looks.get(&b.hash)?);
            (score >= SAME_PHOTO_MIN_EDGES).then_some(score)
        }
    }
}

#[cfg(test)]
pub fn same_photo(a: &DupRow, b: &DupRow, clip: &HashMap<String, Vec<f32>>, looks: &HashMap<String, Vec<u8>>) -> bool {
    link_strength(a, b, clip, looks).is_some()
}

// A thumbnail as LOOK_EDGE x LOOK_EDGE grey pixels, for `look_similarity`
pub fn look_of(thumbnail: &Path) -> Option<Vec<u8>> {
    let img = image::open(thumbnail).ok()?;
    Some(img.resize_exact(LOOK_EDGE, LOOK_EDGE, image::imageops::FilterType::Triangle).to_luma8().into_raw())
}

// Correlation of the edges of two looks: robust to resizing, recompression, colour and tone edits, not to
// anything moving
fn look_similarity(a: &[u8], b: &[u8]) -> f32 {
    let edges = |px: &[u8]| -> Vec<f32> {
        let n = LOOK_EDGE as usize;
        let mut e = Vec::with_capacity((n - 1) * (n - 1));
        for y in 0..n - 1 {
            for x in 0..n - 1 {
                let p = px[y * n + x] as f32;
                e.push((px[y * n + x + 1] as f32 - p).abs() + (px[(y + 1) * n + x] as f32 - p).abs());
            }
        }
        let mean = e.iter().sum::<f32>() / e.len() as f32;
        e.iter_mut().for_each(|v| *v -= mean);
        let norm = e.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-6);
        e.iter_mut().for_each(|v| *v /= norm);
        e
    };
    let n = (LOOK_EDGE * LOOK_EDGE) as usize;
    if a.len() != n || b.len() != n {
        return 0.0;
    }
    face_match::dot(&edges(a), &edges(b))
}

// A real capture time to the second (a date from a file name alone has none)
fn has_exact_time(captured_at: &str) -> bool {
    captured_at.len() >= 19 && !captured_at.ends_with("00:00:00")
}

// Candidates (indices into `rows`) taken in the same second, per second
fn by_second<'a>(rows: &'a [DupRow], candidates: &[usize]) -> Vec<Vec<usize>> {
    let mut by_second: HashMap<&'a str, Vec<usize>> = HashMap::new();
    for &i in candidates {
        if has_exact_time(&rows[i].captured_at) {
            by_second.entry(&rows[i].captured_at[..19]).or_default().push(i);
        }
    }
    by_second.into_values().filter(|m| m.len() > 1).collect()
}

// The photos whose thumbnails `same_photo` has to compare
pub fn photos_to_look_at(rows: &[DupRow], candidates: &[usize], clip: &HashMap<String, Vec<f32>>) -> Vec<String> {
    let mut out = Vec::new();
    for members in by_second(rows, candidates) {
        for (x, &a) in members.iter().enumerate() {
            for &b in &members[x + 1..] {
                if same_photo_by_data(&rows[a], &rows[b], clip).is_none() {
                    out.push(rows[a].hash.clone());
                    out.push(rows[b].hash.clone());
                }
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

// Sets of the same shot among `candidates` (indices into `rows`: one per exact-copy set, plus every other photo)
pub fn same_photo_sets(
    rows: &[DupRow],
    candidates: &[usize],
    clip: &HashMap<String, Vec<f32>>,
    looks: &HashMap<String, Vec<u8>>,
) -> Vec<Vec<usize>> {
    let mut links: Vec<(f32, usize, usize)> = Vec::new();
    for members in by_second(rows, candidates) {
        for (x, &a) in members.iter().enumerate() {
            for &b in &members[x + 1..] {
                if let Some(strength) = link_strength(&rows[a], &rows[b], clip, looks) {
                    links.push((strength, a, b));
                }
            }
        }
    }
    // Surest links first: an export joins the burst frame it was made from before one that merely looks alike
    links.sort_by(|x, y| y.0.total_cmp(&x.0).then(x.1.cmp(&y.1)).then(x.2.cmp(&y.2)));

    let mut parent: Vec<usize> = (0..rows.len()).collect();
    // Burst frames in each set so far: an export can look like two frames of a burst, and must not join them
    let mut frames: HashMap<usize, Vec<(String, u64)>> = HashMap::new();
    let frame_of = |i: usize| camera_frame(&rows[i].path).or_else(|| timed_frame(&rows[i].path).map(|(base, n)| (base, n as u64)));
    let mut linked = Vec::new();
    for (_, a, b) in links {
        let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
        if ra == rb {
            continue;
        }
        let frames_of = |root: usize, i: usize, frames: &HashMap<usize, Vec<(String, u64)>>| {
            frames.get(&root).cloned().unwrap_or_else(|| frame_of(i).into_iter().collect())
        };
        let (fa, fb) = (frames_of(ra, a, &frames), frames_of(rb, b, &frames));
        if fa.iter().any(|x| fb.iter().any(|y| x.0 == y.0 && x.1 != y.1)) {
            continue;
        }
        parent[rb] = ra;
        frames.remove(&rb);
        frames.insert(ra, [fa, fb].concat());
        linked.push(a);
        linked.push(b);
    }
    linked.sort_unstable();
    linked.dedup();
    sets_from(&mut parent, &linked)
}

fn load_rows(conn: &Connection, root_folder: Option<&str>) -> Result<Vec<DupRow>, String> {
    let prefix = make_folder_prefix(root_folder);
    let mut stmt = conn
        .prepare(
            "SELECT p.hash, p.current_path, COALESCE(p.file_size, 0), COALESCE(p.modified_time, 0),
                    COALESCE(p.width, 0) * COALESCE(p.height, 0), COALESCE(p.captured_at, ''), COALESCE(p.dhash, ''),
                    (CASE WHEN p.rating > 0 THEN 1 + p.rating ELSE 0 END)
                    + (CASE WHEN p.flag = 'pick' THEN 1 ELSE 0 END)
                    + (CASE WHEN p.color_label IS NOT NULL THEN 1 ELSE 0 END)
                    + (CASE WHEN COALESCE(p.ai_caption, '') != '' THEN 1 ELSE 0 END)
                    + (SELECT COUNT(*) FROM photo_tags t WHERE t.hash = p.hash)
                    + (SELECT COUNT(*) FROM photo_people pp WHERE pp.hash = p.hash)
                    + (SELECT COUNT(*) FROM album_photos ap WHERE ap.hash = p.hash)
             FROM photos p
             WHERE p.current_path LIKE ?1 ESCAPE '!'
               AND COALESCE(p.subfolder, '') != '_Trash' AND COALESCE(p.staged_target, '') != '_Trash'",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![prefix], |r| {
            let dhash: String = r.get(6)?;
            Ok(DupRow {
                hash: r.get(0)?,
                path: r.get(1)?,
                size: r.get(2)?,
                mtime: r.get(3)?,
                pixels: r.get(4)?,
                captured_at: r.get(5)?,
                dhash: (dhash.len() == 16).then(|| u64::from_str_radix(&dhash, 16).ok()).flatten(),
                info: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    // A file that is gone keeps its row but isn't listed: it can't be a copy to keep or to move away
    Ok(rows.flatten().filter(|r| Path::new(&r.path).exists()).collect())
}

pub async fn find_duplicates(app: SharedHost, root_folder: Option<String>) -> Result<Vec<DuplicateSet>, String> {
    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let conn = open_global_db(&app)?;
        let thumbs_dir = get_app_storage_dir(&app).join("thumbnails");
        let (sets, photos) = find_duplicate_sets(&conn, root_folder.as_deref(), &thumbs_dir)?;
        emit_perf(&app, "Find duplicates", started, photos, format!("{} sets", sets.len()));
        Ok(sets)
    })
    .await
    .map_err(|e| e.to_string())?
}

// The duplicate sets of a folder, exact copies first, each newest first; also returns how many photos it read
pub fn find_duplicate_sets(conn: &Connection, root_folder: Option<&str>, thumbs_dir: &Path) -> Result<(Vec<DuplicateSet>, usize), String> {
    {
        let rows = load_rows(conn, root_folder)?;
        let ordered = |set: Vec<usize>| -> Vec<usize> {
            let mut s = set;
            s.sort_by(|&a, &b| keeper_order(&rows[a], &rows[b]));
            s
        };

        let exact: Vec<Vec<usize>> = exact_copy_sets(&rows).into_iter().map(ordered).collect();
        // Same photo, different file: one stand-in per exact-copy set (its keeper), so copies aren't matched twice
        let mut in_exact = vec![false; rows.len()];
        for set in &exact {
            for &i in &set[1..] {
                in_exact[i] = true;
            }
        }
        let candidates: Vec<usize> = (0..rows.len()).filter(|&i| !in_exact[i]).collect();
        let timed: Vec<String> = {
            let mut per_second: HashMap<&str, usize> = HashMap::new();
            for &i in &candidates {
                if has_exact_time(&rows[i].captured_at) {
                    *per_second.entry(&rows[i].captured_at[..19]).or_default() += 1;
                }
            }
            candidates
                .iter()
                .filter(|&&i| has_exact_time(&rows[i].captured_at) && per_second[&rows[i].captured_at[..19]] > 1)
                .map(|&i| rows[i].hash.clone())
                .collect()
        };
        let clip = clip::clip_vectors(conn, &timed);
        let looks: HashMap<String, Vec<u8>> = photos_to_look_at(&rows, &candidates, &clip)
            .into_par_iter()
            .filter_map(|h| look_of(&thumbs_dir.join(format!("{h}.jpg"))).map(|l| (h, l)))
            .collect();
        let same: Vec<Vec<usize>> = same_photo_sets(&rows, &candidates, &clip, &looks).into_iter().map(ordered).collect();

        let newest_first = |sets: Vec<Vec<usize>>, kind: &str| -> Vec<DuplicateSet> {
            let mut sets = sets;
            sets.sort_by(|a, b| rows[b[0]].captured_at.cmp(&rows[a[0]].captured_at));
            sets.into_iter()
                .map(|s| DuplicateSet { kind: kind.to_string(), hashes: s.into_iter().map(|i| rows[i].hash.clone()).collect() })
                .collect()
        };
        let mut out = newest_first(exact, "exact");
        out.extend(newest_first(same, "same_photo"));
        Ok((out, rows.len()))
    }
}

#[derive(Deserialize)]
pub struct DuplicateStageInput {
    pub keep: String,
    pub extras: Vec<String>,
}

// Stages the extra copies for _Trash, after giving the kept copy what the user added to them (stars, pick,
// colour label, caption, tags, people and albums), so nothing is lost when the extras go
pub async fn stage_duplicate_extras(app: SharedHost, sets: Vec<DuplicateStageInput>) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_global_db(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut staged = 0;
        for set in &sets {
            for extra in set.extras.iter().filter(|e| **e != set.keep) {
                merge_into_keeper(&tx, &set.keep, extra).map_err(|e| e.to_string())?;
                staged += tx
                    .execute("UPDATE photos SET staged_target = '_Trash' WHERE hash = ?1", params![extra])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(staged)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn merge_into_keeper(conn: &Connection, keep: &str, extra: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE photos SET
            rating = MAX(COALESCE(rating, 0), (SELECT COALESCE(rating, 0) FROM photos WHERE hash = ?2)),
            flag = CASE WHEN flag IS NULL AND (SELECT flag FROM photos WHERE hash = ?2) = 'pick' THEN 'pick' ELSE flag END,
            color_label = COALESCE(color_label, (SELECT color_label FROM photos WHERE hash = ?2)),
            ai_caption = CASE WHEN COALESCE(ai_caption, '') = '' THEN (SELECT COALESCE(ai_caption, '') FROM photos WHERE hash = ?2) ELSE ai_caption END
         WHERE hash = ?1",
        params![keep, extra],
    )?;
    for table in ["photo_tags", "photo_people", "album_photos"] {
        let column = match table {
            "photo_tags" => "tag",
            "photo_people" => "person_name",
            _ => "album_id",
        };
        conn.execute(
            &format!("INSERT OR IGNORE INTO {table} (hash, {column}) SELECT ?1, {column} FROM {table} WHERE hash = ?2"),
            params![keep, extra],
        )?;
    }
    Ok(())
}
