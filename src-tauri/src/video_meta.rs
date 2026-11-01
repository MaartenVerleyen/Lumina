// What a video file says about itself, read from its MP4/QuickTime boxes with a few seeks: when it was
// recorded, how long it is, its size and rotation, the codec, the place (iPhone and Android) and the camera.
// MTS, AVI and MPEG files have no such boxes; the frame pass fills in their size and length.
use crate::*;

// Every video type the library indexes (lower-case); Import copies the same types
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "3gp", "avi", "mts", "m2ts", "mpg", "mpeg"];

// Containers built from MP4/QuickTime boxes
const BOX_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "3gp"];

// The `moov` box holds the index of every sample: tens of KB for a phone clip, a few MB for an hour of video
const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;

// Seconds between 1904-01-01 (QuickTime's epoch) and 1970-01-01
const EPOCH_1904_TO_1970: i64 = 2_082_844_800;

pub fn is_video_ext(ext: &str) -> bool {
    VIDEO_EXTENSIONS.contains(&ext)
}

pub fn is_video_path(path: &Path) -> bool {
    path.extension().map(|e| is_video_ext(&e.to_string_lossy().to_lowercase())).unwrap_or(false)
}

#[derive(Default, Debug, Clone, PartialEq)]
pub struct VideoMeta {
    // Recording time as local wall-clock time ("2024-04-05 17:34:38"), when the file states it with its zone
    pub local_created: Option<String>,
    // Recording time in UTC seconds since 1970 (mvhd), when set
    pub created_utc: Option<i64>,
    pub duration_ms: Option<u64>,
    // Displayed size: already swapped for a portrait video recorded on its side
    pub width: u32,
    pub height: u32,
    // Clockwise degrees the player turns the picture (0, 90, 180, 270)
    pub rotation: u32,
    pub codec: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub make: Option<String>,
    pub model: Option<String>,
}

fn be_u16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn be_u32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn be_i32(b: &[u8], at: usize) -> Option<i32> {
    Some(i32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn be_u64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

// The child boxes of `b`: (type, body)
fn boxes(b: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos + 8 <= b.len() {
        let Some(size32) = be_u32(b, pos) else { break };
        let kind: [u8; 4] = b[pos + 4..pos + 8].try_into().unwrap_or_default();
        let (size, header) = match size32 {
            0 => ((b.len() - pos) as u64, 8),
            1 => match be_u64(b, pos + 8) {
                Some(s) => (s, 16),
                None => break,
            },
            s => (s as u64, 8),
        };
        if size < header as u64 || pos as u64 + size > b.len() as u64 {
            break;
        }
        out.push((kind, &b[pos + header..pos + size as usize]));
        pos += size as usize;
    }
    out
}

fn child<'a>(b: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(b).into_iter().find(|(k, _)| k == kind).map(|(_, body)| body)
}

fn path<'a>(b: &'a [u8], kinds: &[&[u8; 4]]) -> Option<&'a [u8]> {
    kinds.iter().try_fold(b, |cur, k| child(cur, k))
}

// "+51.0543+003.7174+012.000/" (ISO 6709: latitude, longitude, optional altitude)
pub fn parse_iso6709(s: &str) -> Option<(f64, f64)> {
    let s = s.trim().trim_end_matches('/');
    let starts: Vec<usize> = s.char_indices().filter(|(_, c)| *c == '+' || *c == '-').map(|(i, _)| i).collect();
    if starts.len() < 2 || starts[0] != 0 {
        return None;
    }
    let lat: f64 = s[starts[0]..starts[1]].parse().ok()?;
    let lon_end = starts.get(2).copied().unwrap_or(s.len());
    let lon: f64 = s[starts[1]..lon_end].parse().ok()?;
    let valid = lat.abs() <= 90.0 && lon.abs() <= 180.0 && (lat.abs() > 0.0001 || lon.abs() > 0.0001);
    valid.then_some((lat, lon))
}

// QuickTime metadata (moov/meta: keys + ilst), as iPhones write it
fn apple_keys(meta: &[u8]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    // In MP4 files `meta` is a full box (4 bytes version/flags before its children); in QuickTime it isn't
    let body = if meta.get(4..8) == Some(b"hdlr".as_slice()) { meta } else { meta.get(4..).unwrap_or_default() };
    let (Some(keys), Some(ilst)) = (child(body, b"keys"), child(body, b"ilst")) else {
        return out;
    };
    let mut names = Vec::new();
    let mut pos = 8usize; // version/flags, entry count
    while let Some(size) = be_u32(keys, pos) {
        let size = size as usize;
        if size < 8 || pos + size > keys.len() {
            break;
        }
        names.push(String::from_utf8_lossy(&keys[pos + 8..pos + size]).to_string());
        pos += size;
    }
    for (kind, item) in boxes(ilst) {
        let index = u32::from_be_bytes(kind) as usize;
        let (Some(name), Some(data)) = (index.checked_sub(1).and_then(|i| names.get(i)), child(item, b"data")) else {
            continue;
        };
        // data: type (4), locale (4), value; type 1 is UTF-8 text
        if be_u32(data, 0) == Some(1) {
            if let Some(v) = data.get(8..) {
                out.insert(name.clone(), String::from_utf8_lossy(v).trim_end_matches('\0').to_string());
            }
        }
    }
    out
}

// `©xyz` in moov/udta (Android, older iPhones): a 16-bit length, a 16-bit language, then the text
fn udta_location(udta: &[u8]) -> Option<(f64, f64)> {
    let xyz = child(udta, &[0xA9, b'x', b'y', b'z'])?;
    let len = be_u16(xyz, 0)? as usize;
    parse_iso6709(&String::from_utf8_lossy(xyz.get(4..4 + len)?))
}

fn video_track_info(trak: &[u8], meta: &mut VideoMeta) -> bool {
    let handler = path(trak, &[b"mdia", b"hdlr"]).and_then(|h| h.get(8..12));
    if handler != Some(b"vide".as_slice()) {
        return false;
    }
    if let Some(tkhd) = child(trak, b"tkhd") {
        let matrix_at = if tkhd.first() == Some(&1) { 52 } else { 40 };
        let a = be_i32(tkhd, matrix_at).unwrap_or(0x10000);
        let b = be_i32(tkhd, matrix_at + 4).unwrap_or(0);
        meta.rotation = match (a, b) {
            (0, b) if b > 0 => 90,
            (0, b) if b < 0 => 270,
            (a, 0) if a < 0 => 180,
            _ => 0,
        };
        meta.width = be_u32(tkhd, matrix_at + 36).unwrap_or(0) >> 16;
        meta.height = be_u32(tkhd, matrix_at + 40).unwrap_or(0) >> 16;
    }
    if let Some(stsd) = path(trak, &[b"mdia", b"minf", b"stbl", b"stsd"]) {
        // full box (4), entry count (4), then the first sample entry: size (4), format (4)
        if let Some(fourcc) = stsd.get(12..16) {
            meta.codec = Some(String::from_utf8_lossy(fourcc).trim().to_string());
        }
        if meta.width == 0 || meta.height == 0 {
            // A visual sample entry has its width and height 24 bytes into its fields
            meta.width = be_u16(stsd, 8 + 32).unwrap_or(0) as u32;
            meta.height = be_u16(stsd, 8 + 34).unwrap_or(0) as u32;
        }
    }
    if meta.rotation == 90 || meta.rotation == 270 {
        std::mem::swap(&mut meta.width, &mut meta.height);
    }
    true
}

// Everything above from the body of a `moov` box
pub fn parse_moov(moov: &[u8]) -> VideoMeta {
    let mut meta = VideoMeta::default();
    if let Some(mvhd) = child(moov, b"mvhd") {
        let (created, timescale, duration) = if mvhd.first() == Some(&1) {
            (be_u64(mvhd, 4).map(|v| v as i64), be_u32(mvhd, 20), be_u64(mvhd, 24))
        } else {
            (be_u32(mvhd, 4).map(i64::from), be_u32(mvhd, 12), be_u32(mvhd, 16).map(u64::from))
        };
        meta.created_utc = created.filter(|&c| c > 0).map(|c| c - EPOCH_1904_TO_1970);
        if let (Some(ts), Some(d)) = (timescale.filter(|&t| t > 0), duration) {
            meta.duration_ms = Some(d.saturating_mul(1000) / ts as u64);
        }
    }
    for (kind, body) in boxes(moov) {
        if &kind == b"trak" && video_track_info(body, &mut meta) {
            break;
        }
    }
    let keys = child(moov, b"meta").map(apple_keys).unwrap_or_default();
    if let Some((lat, lon)) = keys
        .get("com.apple.quicktime.location.ISO6709")
        .and_then(|s| parse_iso6709(s))
        .or_else(|| child(moov, b"udta").and_then(udta_location))
    {
        meta.lat = Some(lat);
        meta.lon = Some(lon);
    }
    meta.make = keys.get("com.apple.quicktime.make").filter(|s| !s.is_empty()).cloned();
    meta.model = keys.get("com.apple.quicktime.model").filter(|s| !s.is_empty()).cloned();
    meta.local_created = keys
        .get("com.apple.quicktime.creationdate")
        .map(|s| normalize_date_str(s))
        .filter(|s| !s.is_empty());
    meta
}

// Finds the top-level `moov` box with seeks (it may follow gigabytes of media data) and parses it
pub fn read_video_meta(file_path: &Path) -> VideoMeta {
    let ext = file_path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !BOX_EXTENSIONS.contains(&ext.as_str()) {
        return VideoMeta::default();
    }
    let read = || -> Option<VideoMeta> {
        let mut f = File::open(file_path).ok()?;
        let end = f.metadata().ok()?.len();
        let mut pos = 0u64;
        while pos + 8 <= end {
            f.seek(SeekFrom::Start(pos)).ok()?;
            let mut head = [0u8; 16];
            f.read_exact(&mut head[..8]).ok()?;
            let size32 = u32::from_be_bytes(head[..4].try_into().ok()?);
            let (size, header) = match size32 {
                0 => (end - pos, 8),
                1 => {
                    f.read_exact(&mut head[8..16]).ok()?;
                    (u64::from_be_bytes(head[8..16].try_into().ok()?), 16)
                }
                s => (s as u64, 8),
            };
            if size < header || pos + size > end {
                return None;
            }
            if &head[4..8] == b"moov" {
                let len = size - header;
                if len > MAX_MOOV_BYTES {
                    return None;
                }
                let mut body = vec![0u8; len as usize];
                f.read_exact(&mut body).ok()?;
                return Some(parse_moov(&body));
            }
            pos += size;
        }
        None
    };
    read().unwrap_or_default()
}

// When a recording year can't be right: unset (1904/1970) or in the future
fn plausible(date: &str) -> bool {
    let year: i32 = date.get(..4).and_then(|y| y.parse().ok()).unwrap_or(0);
    (1990..=2100).contains(&year) && date <= format_system_time_iso(std::time::SystemTime::now()).as_str()
}

// The library's view of a video: the same fields a photo's EXIF pass gives, plus its length and codec
pub fn extract_video_pass(file_path: &Path) -> FullExifPass {
    let meta = read_video_meta(file_path);
    let captured_at = meta
        .local_created
        .clone()
        .filter(|d| plausible(d))
        .or_else(|| {
            let utc = std::time::UNIX_EPOCH + std::time::Duration::from_secs(u64::try_from(meta.created_utc?).ok()?);
            Some(system_time_local_iso(utc)).filter(|d| plausible(d))
        })
        .unwrap_or_else(|| fallback_photo_date(file_path, fs::metadata(file_path).ok().as_ref()));
    let camera_model = match (&meta.make, &meta.model) {
        (Some(make), Some(model)) if !model.to_lowercase().starts_with(&make.to_lowercase()) => format!("{make} {model}"),
        (_, Some(model)) => model.clone(),
        (Some(make), None) => make.clone(),
        (None, None) => String::new(),
    };
    let location = match (meta.lat, meta.lon) {
        (Some(lat), Some(lon)) => {
            let r = GEOCODER.search((lat, lon));
            format!("{}, {}", r.record.name, r.record.cc)
        }
        _ => String::new(),
    };
    FullExifPass {
        width: meta.width,
        height: meta.height,
        captured_at,
        camera_model,
        location,
        lat: meta.lat,
        lon: meta.lon,
        focal_length: None,
        aperture: None,
        shutter_speed: None,
        iso: None,
        lens_model: None,
        duration_ms: meta.duration_ms,
        video_codec: meta.codec,
    }
}
