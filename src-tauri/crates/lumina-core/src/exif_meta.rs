use crate::*;

pub fn parse_gps_rational(val: &Value) -> Option<f64> {
    match val {
        Value::Rational(rats) if rats.len() >= 3 => {
            let deg = rats[0].to_f64();
            let min = rats[1].to_f64();
            let sec = rats[2].to_f64();
            if deg.is_nan() || min.is_nan() || sec.is_nan() {
                None
            } else {
                Some(deg + (min / 60.0) + (sec / 3600.0))
            }
        }
        Value::SRational(rats) if rats.len() >= 3 => {
            let deg = rats[0].to_f64();
            let min = rats[1].to_f64();
            let sec = rats[2].to_f64();
            Some(deg + (min / 60.0) + (sec / 3600.0))
        }
        _ => None,
    }
}

pub fn format_system_time_iso(st: std::time::SystemTime) -> String {
    let secs = st
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if secs <= 0 {
        return String::new();
    }
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;

    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let yr = if m <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", yr, m, d, hh, mm, ss)
}

pub fn normalize_date_str(raw: &str) -> String {
    let clean = raw.trim().trim_matches('"').trim();
    if clean.len() >= 10 {
        let date_part = clean[..10].replace(':', "-");
        let time_part = if clean.len() >= 19 {
            clean[11..19].to_string()
        } else {
            "00:00:00".to_string()
        };
        if date_part.chars().take(4).all(|c| c.is_ascii_digit()) {
            return format!("{} {}", date_part, time_part);
        }
    }
    String::new()
}

// A date in a file name, as phones and apps write them: "IMG_20230615_183000", "IMG-20230615-WA0001",
// "PXL_20230615_183000123", "Screenshot_2023-06-15-18-30-00", "2023-06-15 18.30.00". Returns the date and,
// when the name has one, the time ("2023-06-15 18:30:00" / "2023-06-15").
pub fn date_from_filename(name: &str) -> Option<(String, Option<String>)> {
    let b = name.as_bytes();
    let digits = |from: usize, n: usize| -> Option<u32> {
        let s = b.get(from..from + n)?;
        s.iter().all(|c| c.is_ascii_digit()).then(|| std::str::from_utf8(s).ok()?.parse().ok())?
    };
    let is_sep = |i: usize| matches!(b.get(i), Some(b'-' | b'_' | b'.' | b' '));
    for start in 0..b.len() {
        if !b[start].is_ascii_digit() || (start > 0 && b[start - 1].is_ascii_digit()) {
            continue;
        }
        // YYYYMMDD or YYYY-MM-DD (one separator style throughout)
        let sep = is_sep(start + 4) as usize;
        if sep == 1 && b.get(start + 4) != b.get(start + 7) {
            continue;
        }
        let (Some(y), Some(m), Some(d)) = (digits(start, 4), digits(start + 4 + sep, 2), digits(start + 6 + 2 * sep, 2)) else {
            continue;
        };
        let mut i = start + 8 + 2 * sep;
        if !(1990..=2100).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            continue;
        }
        // Part of a longer number (an ID, a Unix timestamp) unless a time follows
        let joined_time = sep == 0 && b.get(i).is_some_and(|c| c.is_ascii_digit());
        if joined_time && digits(i, 6).is_none() {
            continue;
        }
        let date = format!("{y:04}-{m:02}-{d:02}");
        // HHMMSS or HH-MM-SS / HH.MM.SS, right after the date or after one separator (or "T")
        if !joined_time && (is_sep(i) || b.get(i) == Some(&b'T')) {
            i += 1;
        }
        let tsep = (b.get(i).is_some_and(|c| c.is_ascii_digit()) && is_sep(i + 2)) as usize;
        let time = match (digits(i, 2), digits(i + 2 + tsep, 2), digits(i + 4 + 2 * tsep, 2)) {
            (Some(hh), Some(mm), Some(ss)) if hh < 24 && mm < 60 && ss < 60 => Some(format!("{date} {hh:02}:{mm:02}:{ss:02}")),
            _ => None,
        };
        return Some((date, time));
    }
    None
}

// File times are UTC; photo dates (EXIF) are local wall-clock time
pub fn system_time_local_iso(st: std::time::SystemTime) -> String {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::Storage::FileSystem::FileTimeToLocalFileTime;
        const UNIX_TO_FILETIME_SECS: u64 = 11_644_473_600;
        if let Ok(d) = st.duration_since(std::time::UNIX_EPOCH) {
            let ticks = (d.as_secs() + UNIX_TO_FILETIME_SECS) * 10_000_000 + u64::from(d.subsec_nanos() / 100);
            let utc = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
            let mut local = FILETIME::default();
            if unsafe { FileTimeToLocalFileTime(&utc, &mut local) }.is_ok() {
                let local_ticks = (u64::from(local.dwHighDateTime) << 32) | u64::from(local.dwLowDateTime);
                if let Some(secs) = (local_ticks / 10_000_000).checked_sub(UNIX_TO_FILETIME_SECS) {
                    return format_system_time_iso(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs));
                }
            }
        }
    }
    // Linux and macOS: the C library's local time (TZ, or /etc/localtime; a container sets TZ)
    #[cfg(unix)]
    {
        if let Ok(d) = st.duration_since(std::time::UNIX_EPOCH) {
            let t = d.as_secs() as libc::time_t;
            let mut tm: libc::tm = unsafe { std::mem::zeroed() };
            if !unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
                if let Some(secs) = (d.as_secs() as i64).checked_add(tm.tm_gmtoff as i64).filter(|s| *s >= 0) {
                    return format_system_time_iso(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs as u64));
                }
            }
        }
    }
    format_system_time_iso(st)
}

// The earliest file time as local time. Copying a file gives it a new creation time but keeps its
// modification time, so the earlier one is the closer to the shot.
fn file_time_date(meta: Option<&fs::Metadata>) -> Option<String> {
    meta.and_then(|m| match (m.created().ok(), m.modified().ok()) {
        (Some(c), Some(m)) => Some(c.min(m)),
        (c, m) => c.or(m),
    })
    .map(system_time_local_iso)
    .filter(|s| !s.is_empty())
}

// JSON names Google Takeout writes next to a photo, newest style first: "IMG_1.jpg.supplemental-metadata.json",
// "IMG_1.jpg.json"; a duplicate "IMG_1(1).jpg" gets "IMG_1.jpg.supplemental-metadata(1).json" / "IMG_1.jpg(1).json".
// An "-edited" copy has no JSON of its own: it uses the original's; a "(1)" copy without one does too.
fn takeout_json_names(name: &str) -> Vec<String> {
    let (stem, ext) = match name.rfind('.') {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    let mut stems = vec![stem.to_string()];
    for suffix in ["-edited", "-bewerkt"] {
        if let Some(original) = stem.strip_suffix(suffix) {
            stems.push(original.to_string());
        }
    }
    let mut out = Vec::new();
    for stem in stems {
        let copy = stem
            .strip_suffix(')')
            .and_then(|s| s.rsplit_once('('))
            .filter(|(_, n)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
        out.push(format!("{stem}{ext}.supplemental-metadata.json"));
        out.push(format!("{stem}{ext}.json"));
        if let Some((base, n)) = copy {
            out.insert(out.len() - 2, format!("{base}{ext}.supplemental-metadata({n}).json"));
            out.insert(out.len() - 2, format!("{base}{ext}({n}).json"));
            // Last resort: the original's JSON (a copy with the same name is almost always the same shot)
            out.push(format!("{base}{ext}.supplemental-metadata.json"));
            out.push(format!("{base}{ext}.json"));
        }
    }
    out
}

// "Google Photos (2)" -> "Google Photos"
fn takeout_part_base(name: &str) -> &str {
    name.strip_suffix(')')
        .and_then(|s| s.rsplit_once(" ("))
        .filter(|(_, n)| n.chars().all(|c| c.is_ascii_digit()))
        .map(|(base, _)| base)
        .unwrap_or(name)
}

// When Google Takeout exported this photo: its JSON sidecar's "photoTakenTime" (UTC) as local time.
// A large export is split into parts ("Google Photos", "Google Photos (2)", …) and a photo's JSON can land in
// the same album folder of another part, so those are tried too.
pub fn takeout_photo_date(file_path: &Path) -> Option<String> {
    let name = file_path.file_name()?.to_string_lossy().to_string();
    let album_dir = file_path.parent()?;
    let mut dirs = vec![album_dir.to_path_buf()];
    if let (Some(album), Some(part)) = (album_dir.file_name(), album_dir.parent()) {
        if let (Some(part_name), Some(export)) = (part.file_name().map(|n| n.to_string_lossy().to_string()), part.parent()) {
            let base = takeout_part_base(&part_name);
            if base.starts_with("Google Photos") || base.starts_with("Google Foto") {
                if let Ok(entries) = fs::read_dir(export) {
                    for e in entries.flatten() {
                        let other = e.file_name().to_string_lossy().to_string();
                        if other != part_name && takeout_part_base(&other) == base {
                            dirs.push(e.path().join(album));
                        }
                    }
                }
            }
        }
    }
    let names = takeout_json_names(&name);
    for dir in &dirs {
        for json_name in &names {
            let Ok(text) = fs::read_to_string(dir.join(json_name)) else { continue };
            let Ok(json) = serde_json::from_str::<JsonValue>(&text) else { continue };
            let ts = &json["photoTakenTime"]["timestamp"];
            let Some(secs) = ts.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| ts.as_u64()) else {
                continue;
            };
            if secs == 0 {
                continue;
            }
            return Some(system_time_local_iso(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs)));
        }
    }
    None
}

// The year in the nearest folder name that has one ("Photos from 2022", "New Zealand 2018"), up to three levels up
fn folder_year(file_path: &Path) -> Option<u32> {
    for dir in file_path.ancestors().skip(1).take(3) {
        let name = dir.file_name()?.to_string_lossy().to_string();
        let b = name.as_bytes();
        let mut years = (0..b.len().saturating_sub(3)).filter_map(|i| {
            let standalone = (i == 0 || !b[i - 1].is_ascii_digit()) && b.get(i + 4).is_none_or(|c| !c.is_ascii_digit());
            let y: u32 = name.get(i..i + 4)?.parse().ok()?;
            (standalone && (1990..=2100).contains(&y)).then_some(y)
        });
        if let Some(y) = years.next() {
            // Two different years ("2019-2021") say nothing about one photo
            if years.all(|other| other == y) {
                return Some(y);
            }
            return None;
        }
    }
    None
}

// The date of a photo without an EXIF date, from the most to the least trustworthy: a date in its name,
// Google Takeout's record of when it was taken, the year in its folder name when the file time is later
// (a file time years after the folder's year is when it was copied), else the earliest file time.
pub fn fallback_photo_date(file_path: &Path, meta: Option<&fs::Metadata>) -> String {
    let file_time = file_time_date(meta);
    let name = file_path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    match date_from_filename(&name) {
        Some((_, Some(date_time))) => date_time,
        // A name with only a date: the file time when it falls on that day (it has the time), else midnight
        Some((date, None)) => match file_time {
            Some(ft) if ft.starts_with(&date) => ft,
            _ => format!("{date} 00:00:00"),
        },
        None => {
            if let Some(taken) = takeout_photo_date(file_path) {
                return taken;
            }
            let ft = file_time.unwrap_or_default();
            let ft_year = ft.get(..4).and_then(|y| y.parse::<u32>().ok());
            match (folder_year(file_path), ft_year) {
                (Some(year), Some(fy)) if fy > year => format!("{year:04}-01-01 00:00:00"),
                _ => ft,
            }
        }
    }
}

// A photo dated from its file's times: before 4.0.1 the creation time (UTC), since then the earliest file time.
// Such dates are recognised without reading the photo, and read again when a better source now gives
// another date (a Takeout JSON, the folder's year).
pub fn is_old_creation_time_date(file_path: &Path, captured_at: &str, meta: &fs::Metadata) -> bool {
    !captured_at.is_empty()
        && (meta.created().map(|c| format_system_time_iso(c) == captured_at).unwrap_or(false)
            || file_time_date(Some(meta)).as_deref() == Some(captured_at))
        && fallback_photo_date(file_path, Some(meta)) != captured_at
}

pub struct FullExifPass {
    pub width: u32,
    pub height: u32,
    pub captured_at: String,
    pub camera_model: String,
    pub location: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub focal_length: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub iso: Option<String>,
    pub lens_model: Option<String>,
    // Videos only: length and codec from the container
    pub duration_ms: Option<u64>,
    pub video_codec: Option<String>,
}

// Single-Pass Header & EXIF Reader: extracts dimensions, orientation, GPS, date & telemetry
pub fn extract_all_exif_single_pass(file_path: &Path) -> FullExifPass {
    extract_all_exif_with_head(file_path, None)
}

// Same, but parses from `head` (the file's first bytes, already read for hashing) when that is enough;
// only falls back to reading the file for formats whose header/EXIF lies beyond the head (some RAW/HEIC).
pub fn extract_all_exif_with_head(file_path: &Path, head: Option<&[u8]>) -> FullExifPass {
    if crate::video_meta::is_video_path(file_path) {
        return crate::video_meta::extract_video_pass(file_path);
    }
    let mut width = 0u32;
    let mut height = 0u32;
    let mut orientation = 1u32;
    let mut date_str = String::new();
    let mut make_str = String::new();
    let mut camera = String::new();
    let mut location = String::new();
    let mut raw_lat = None;
    let mut raw_lon = None;
    let mut focal = None;
    let mut aperture = None;
    let mut shutter = None;
    let mut iso = None;
    let mut lens = None;

    let head_dims = head.and_then(|h| {
        image::ImageReader::new(Cursor::new(h))
            .with_guessed_format()
            .ok()?
            .into_dimensions()
            .ok()
    });
    if let Some((w, h)) = head_dims.or_else(|| image::image_dimensions(file_path).ok()) {
        width = w;
        height = h;
    }

    let exif_opt = head
        .and_then(|h| Reader::new().read_from_container(&mut Cursor::new(h)).ok())
        .or_else(|| {
            let file = File::open(file_path).ok()?;
            Reader::new().read_from_container(&mut BufReader::new(file)).ok()
        });

    {
        if let Some(exif) = exif_opt {
            let mut lat_deg_opt: Option<f64> = None;
            let mut lon_deg_opt: Option<f64> = None;
            let mut is_south = false;
            let mut is_west = false;

            for f in exif.fields() {
                match f.tag {
                    Tag::Orientation => {
                        if orientation == 1 {
                            if let Some(v) = f.value.get_uint(0) {
                                if (1..=8).contains(&v) {
                                    orientation = v;
                                }
                            }
                        }
                    }
                    Tag::PixelXDimension | Tag::ImageWidth => {
                        if width == 0 {
                            width = f.value.get_uint(0).unwrap_or(0);
                        }
                    }
                    Tag::PixelYDimension | Tag::ImageLength => {
                        if height == 0 {
                            height = f.value.get_uint(0).unwrap_or(0);
                        }
                    }
                    Tag::DateTimeOriginal => {
                        let norm = normalize_date_str(&f.display_value().to_string());
                        if !norm.is_empty() {
                            date_str = norm;
                        }
                    }
                    Tag::DateTimeDigitized | Tag::DateTime => {
                        if date_str.is_empty() {
                            let norm = normalize_date_str(&f.display_value().to_string());
                            if !norm.is_empty() {
                                date_str = norm;
                            }
                        }
                    }
                    Tag::Make => {
                        if make_str.is_empty() {
                            make_str = f.display_value().to_string().replace('"', "").trim().to_string();
                        }
                    }
                    Tag::Model => {
                        if camera.is_empty() {
                            camera = f.display_value().to_string().replace('"', "").trim().to_string();
                        }
                    }
                    Tag::GPSLatitude => {
                        if lat_deg_opt.is_none() {
                            lat_deg_opt = parse_gps_rational(&f.value);
                        }
                    }
                    Tag::GPSLatitudeRef => {
                        let s = f.display_value().to_string().to_uppercase();
                        if s.contains('S') {
                            is_south = true;
                        }
                    }
                    Tag::GPSLongitude => {
                        if lon_deg_opt.is_none() {
                            lon_deg_opt = parse_gps_rational(&f.value);
                        }
                    }
                    Tag::GPSLongitudeRef => {
                        let s = f.display_value().to_string().to_uppercase();
                        if s.contains('W') {
                            is_west = true;
                        }
                    }
                    Tag::FocalLength | Tag::FocalLengthIn35mmFilm => {
                        if focal.is_none() {
                            let val = f.display_value().to_string().replace('"', "").trim().to_string();
                            if !val.is_empty() {
                                focal = Some(if val.ends_with("mm") {
                                    val
                                } else {
                                    format!("{}mm", val.split_whitespace().next().unwrap_or(&val))
                                });
                            }
                        }
                    }
                    Tag::FNumber => {
                        if aperture.is_none() {
                            let val = f.display_value().to_string().replace('"', "").trim().to_string();
                            if !val.is_empty() {
                                let clean = val.trim_start_matches("f/").trim_start_matches('F').trim();
                                aperture = Some(format!("f/{}", clean.split_whitespace().next().unwrap_or(clean)));
                            }
                        }
                    }
                    Tag::ExposureTime => {
                        if shutter.is_none() {
                            let val = f.display_value().to_string().replace('"', "").trim().to_string();
                            if !val.is_empty() {
                                let token = val.split_whitespace().next().unwrap_or(&val);
                                shutter = Some(if token.ends_with('s') {
                                    token.to_string()
                                } else {
                                    format!("{}s", token)
                                });
                            }
                        }
                    }
                    Tag::PhotographicSensitivity => {
                        if iso.is_none() {
                            let val = f.display_value().to_string().replace('"', "").trim().to_string();
                            if !val.is_empty() {
                                iso = Some(format!("ISO {}", val.split_whitespace().next().unwrap_or(&val)));
                            }
                        }
                    }
                    Tag::LensModel => {
                        if lens.is_none() {
                            let val = f.display_value().to_string().replace('"', "").trim().to_string();
                            if !val.is_empty() {
                                lens = Some(val);
                            }
                        }
                    }
                    _ => {}
                }
            }

            if camera.is_empty() && !make_str.is_empty() {
                camera = make_str;
            } else if !make_str.is_empty() && !camera.to_lowercase().starts_with(&make_str.to_lowercase()) {
                camera = format!("{} {}", make_str, camera);
            }

            if let (Some(mut lat), Some(mut lon)) = (lat_deg_opt, lon_deg_opt) {
                if is_south && lat > 0.0 {
                    lat = -lat;
                }
                if is_west && lon > 0.0 {
                    lon = -lon;
                }
                if (lat.abs() > 0.0001 || lon.abs() > 0.0001) && lat.abs() <= 90.0 && lon.abs() <= 180.0 {
                    raw_lat = Some(lat);
                    raw_lon = Some(lon);
                    let search_res = GEOCODER.search((lat, lon));
                    location = format!("{}, {}", search_res.record.name, search_res.record.cc);
                }
            }
        }
    }

    if matches!(orientation, 5 | 6 | 7 | 8) && width >= height && width > 0 {
        std::mem::swap(&mut width, &mut height);
    }

    if date_str.is_empty() {
        date_str = fallback_photo_date(file_path, fs::metadata(file_path).ok().as_ref());
    }

    FullExifPass {
        width,
        height,
        captured_at: date_str,
        camera_model: camera,
        location,
        lat: raw_lat,
        lon: raw_lon,
        focal_length: focal,
        aperture,
        shutter_speed: shutter,
        iso,
        lens_model: lens,
        duration_ms: None,
        video_codec: None,
    }
}

pub fn get_relative_subfolder(root: &Path, file_path: &Path) -> String {
    if let Some(parent) = file_path.parent() {
        if let Ok(rel) = parent.strip_prefix(root) {
            let parts: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect();
            if !parts.is_empty() {
                return parts.join(" / ");
            }
        }
    }
    "Root".to_string()
}
