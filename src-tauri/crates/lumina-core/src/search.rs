// The search box's language, for the server: a shared dynamic album (a saved search) is worked out here, so
// whoever it is shared with sees its photos but never its query. A copy of the frontend's src/utils/
// searchQuery.ts, naturalQuery.ts and searchRun.ts, step for step; tests/fixtures/search-cases.json is run by
// both (npm test and the tests at the bottom), so a change to one that the other lacks shows up there.
use crate::types::{FaceInstance, PhotoItem};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

// What a search looks at in a photo
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct SearchPhoto {
    pub hash: String,
    pub name: String,
    pub rating: i32,
    pub flag: Option<String>,
    pub color_label: Option<String>,
    pub people: Vec<String>,
    pub tags: Vec<String>,
    pub camera_model: String,
    pub lens_model: Option<String>,
    pub location: String,
    pub captured_at: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub faces: Vec<SearchFace>,
    pub ocr_text: String,
    pub ai_caption: String,
    pub pair_raw_path: Option<String>,
    pub damaged: bool,
    pub staged_target: Option<String>,
    pub in_basket: bool,
    pub media_type: Option<String>,
    pub width: f64,
    pub height: f64,
    pub live_photo_hash: Option<String>,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct SearchFace {
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub eyes_open: Option<f64>,
    pub face_sharpness: Option<f64>,
    pub confidence: Option<f64>,
}

impl From<&FaceInstance> for SearchFace {
    fn from(f: &FaceInstance) -> Self {
        SearchFace { bbox_w: f.bbox_w, bbox_h: f.bbox_h, eyes_open: f.eyes_open, face_sharpness: f.face_sharpness, confidence: Some(f.confidence) }
    }
}

impl From<&PhotoItem> for SearchPhoto {
    fn from(p: &PhotoItem) -> Self {
        SearchPhoto {
            hash: p.hash.clone(),
            name: p.name.clone(),
            rating: p.rating,
            flag: p.flag.clone(),
            color_label: p.color_label.clone(),
            people: p.people.clone(),
            tags: p.tags.clone(),
            camera_model: p.camera_model.clone(),
            lens_model: p.lens_model.clone(),
            location: p.location.clone(),
            captured_at: p.captured_at.clone(),
            latitude: p.latitude,
            longitude: p.longitude,
            faces: p.faces.iter().map(SearchFace::from).collect(),
            ocr_text: p.ocr_text.clone(),
            ai_caption: p.ai_caption.clone(),
            pair_raw_path: p.pair_raw_path.clone(),
            damaged: p.damaged,
            staged_target: p.staged_target.clone(),
            in_basket: p.in_basket,
            media_type: Some(p.media_type.clone()),
            width: p.width as f64,
            height: p.height as f64,
            live_photo_hash: p.live_photo_hash.clone(),
        }
    }
}

// A calendar day, for "last week", "this summer" and the like
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Day {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

impl Day {
    // "2026-11-04" (or the start of "2026-11-04 10:00:00")
    pub fn parse(s: &str) -> Option<Day> {
        let b = s.as_bytes();
        if b.len() < 10 || !b[..4].iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(Day { year: s.get(0..4)?.parse().ok()?, month: s.get(5..7)?.parse().ok()?, day: s.get(8..10)?.parse().ok()? })
    }

    // Today on this computer's clock (TZ in a container)
    pub fn today() -> Day {
        Day::parse(&crate::exif_meta::system_time_local_iso(std::time::SystemTime::now())).unwrap_or(Day { year: 2000, month: 1, day: 1 })
    }

    fn days(self) -> i64 {
        // Days since 1970-01-01 (Howard Hinnant's days_from_civil)
        let y = self.year as i64 - if self.month <= 2 { 1 } else { 0 };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let m = self.month as i64;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + self.day as i64 - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    }

    fn from_days(z: i64) -> Day {
        let z = z + 719468;
        let era = z.div_euclid(146097);
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let year = (yoe + era * 400 + if month <= 2 { 1 } else { 0 }) as i32;
        Day { year, month, day }
    }

    fn plus(self, days: i64) -> Day {
        Day::from_days(self.days() + days)
    }

    fn iso(self) -> String {
        format!("{}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

fn last_day(year: i32, month: u32) -> u32 {
    let next = if month == 12 { Day { year: year + 1, month: 1, day: 1 } } else { Day { year, month: month + 1, day: 1 } };
    next.plus(-1).day
}

// ---------- key:value terms (searchQuery.ts) ----------

const TERM_KEYS: &[&str] = &["rating", "flag", "label", "person", "tag", "camera", "lens", "place", "date", "has", "is", "album", "name"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Op {
    Eq,
    Ge,
    Le,
    Gt,
    Lt,
}

#[derive(Clone, Debug)]
pub struct Term {
    pub key: &'static str,
    pub op: Op,
    pub value: String,
    pub negate: bool,
    // Still being typed when saved (last in the query, no space after it): person/tag values match as a prefix
    pub partial: bool,
}

pub struct Parsed {
    pub terms: Vec<Term>,
    pub text: String,
}

// One token of the query, as the frontend's TOKEN regular expression finds it:
// (-?)([a-z]+):(>=|<=|>|<|=)?(?:"([^"]*)"?|(\S*))  |  "[^"]*"?  |  \S+
fn next_token(q: &str, from: usize) -> Option<(usize, usize, Option<(bool, String, Op, Option<String>, String)>)> {
    let start = from + q[from..].find(|c: char| !c.is_whitespace())?;
    let rest = &q[start..];
    let b = rest.as_bytes();
    // The key:value form
    let mut i = 0;
    let minus = b.first() == Some(&b'-');
    if minus {
        i = 1;
    }
    let key_start = i;
    while i < b.len() && b[i].is_ascii_alphabetic() {
        i += 1;
    }
    if i > key_start && b.get(i) == Some(&b':') {
        let key = rest[key_start..i].to_string();
        i += 1;
        let op = if rest[i..].starts_with(">=") {
            i += 2;
            Op::Ge
        } else if rest[i..].starts_with("<=") {
            i += 2;
            Op::Le
        } else if rest[i..].starts_with('>') {
            i += 1;
            Op::Gt
        } else if rest[i..].starts_with('<') {
            i += 1;
            Op::Lt
        } else if rest[i..].starts_with('=') {
            i += 1;
            Op::Eq
        } else {
            Op::Eq
        };
        let (quoted, bare, end) = if rest[i..].starts_with('"') {
            let inner = &rest[i + 1..];
            match inner.find('"') {
                Some(close) => (Some(inner[..close].to_string()), String::new(), i + 1 + close + 1),
                None => (Some(inner.to_string()), String::new(), rest.len()),
            }
        } else {
            let len = rest[i..].find(char::is_whitespace).unwrap_or(rest.len() - i);
            (None, rest[i..i + len].to_string(), i + len)
        };
        return Some((start, start + end, Some((minus, key, op, quoted, bare))));
    }
    // A quoted phrase, or any run of non-space
    if rest.starts_with('"') {
        let end = rest[1..].find('"').map(|c| c + 2).unwrap_or(rest.len());
        return Some((start, start + end, None));
    }
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    Some((start, start + end, None))
}

pub fn parse_query(query: &str) -> Parsed {
    let mut terms = Vec::new();
    let mut text: Vec<String> = Vec::new();
    let mut at = 0;
    while let Some((start, end, kv)) = next_token(query, at) {
        at = end;
        let raw = &query[start..end];
        if let Some((minus, key, op, quoted, bare)) = kv {
            let lower = key.to_ascii_lowercase();
            if let Some(key) = TERM_KEYS.iter().find(|k| **k == lower) {
                let value = quoted.clone().unwrap_or(bare).trim().to_string();
                let partial = quoted.is_none() && end == query.len();
                if !value.is_empty() {
                    terms.push(Term { key, op, value, negate: minus, partial });
                }
                continue;
            }
        }
        text.push(if raw.starts_with('"') { raw.replace('"', "") } else { raw.to_string() });
    }
    Parsed { terms, text: text.join(" ").trim().to_string() }
}

fn compare(a: f64, op: Op, b: f64) -> bool {
    match op {
        Op::Ge => a >= b,
        Op::Le => a <= b,
        Op::Gt => a > b,
        Op::Lt => a < b,
        Op::Eq => a == b,
    }
}

// The first n characters (a JavaScript slice on these ASCII dates)
fn head(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

fn tail_from(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[i..],
        None => "",
    }
}

// "2024:06:15 10:00:00" -> "2024-06-15"
fn day_of(captured_at: &str) -> String {
    let b = captured_at.as_bytes();
    let digits = |r: std::ops::Range<usize>| b.get(r).is_some_and(|s| s.iter().all(u8::is_ascii_digit));
    let sep = |i: usize| matches!(b.get(i), Some(b'-') | Some(b':'));
    if digits(0..4) && sep(4) && digits(5..7) && sep(7) && digits(8..10) {
        format!("{}-{}-{}", &captured_at[0..4], &captured_at[5..7], &captured_at[8..10])
    } else {
        String::new()
    }
}

fn match_date(day: &str, op: Op, value: &str) -> bool {
    if day.is_empty() {
        return false;
    }
    let v: String = value.chars().map(|c| if c == '/' || c == ':' { '-' } else { c }).collect();
    let len = |s: &str| s.chars().count();
    // Any year: "*-06" (June), "*-12-24..*-12-26" (Christmas), "*-12-01..*-02-28" (winter, wraps)
    if v.starts_with("*-") {
        let md = tail_from(day, 5);
        if v.contains("..") {
            let mut parts = v.split("..");
            let from = tail_from(parts.next().unwrap_or(""), 2);
            let to = tail_from(parts.next().unwrap_or(""), 2);
            let after = head(md, len(from)) >= from;
            let before = head(md, len(to)) <= to;
            return if from <= to { after && before } else { after || before };
        }
        return head(md, len(&v).saturating_sub(2)) == tail_from(&v, 2);
    }
    if v.contains("..") {
        let mut parts = v.split("..");
        let from = parts.next().unwrap_or("");
        let to = parts.next().unwrap_or("");
        return (from.is_empty() || head(day, len(from)) >= from) && (to.is_empty() || head(day, len(to)) <= to);
    }
    let prefix = head(day, len(&v));
    match op {
        Op::Ge => prefix >= v.as_str(),
        Op::Le => prefix <= v.as_str(),
        Op::Gt => prefix > v.as_str(),
        Op::Lt => prefix < v.as_str(),
        Op::Eq => prefix == v,
    }
}

fn ends_with_any(name: &str, exts: &[&str]) -> bool {
    let lower = name.to_lowercase();
    exts.iter().any(|e| lower.ends_with(&format!(".{e}")))
}
const RAW_EXT: &[&str] = &["cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "pef", "raf"];
const VIDEO_EXT: &[&str] = &["mp4", "mov", "m4v", "3gp", "avi", "mts", "m2ts", "mpg", "mpeg"];

fn is_video(p: &SearchPhoto) -> bool {
    match p.media_type.as_deref() {
        Some("video") => true,
        Some(t) if !t.is_empty() => false,
        _ => ends_with_any(&p.name, VIDEO_EXT),
    }
}

// The eye and focus checks of culling.ts at their default ("normal") sensitivity
const EYES_THRESHOLD: f64 = -0.013;
const FOCUS_THRESHOLD: f64 = 40.0;
const MIN_FACE_FOR_EYES: f64 = 0.03;
const MIN_FACE_FOR_FOCUS: f64 = 0.05;
const MIN_CONFIDENCE: f64 = 0.65;

fn judgeable(f: &SearchFace) -> bool {
    f.confidence.is_none_or(|c| c >= MIN_CONFIDENCE)
}

fn face_size(p: &SearchPhoto, f: &SearchFace) -> f64 {
    let w = if p.width == 0.0 { 1.0 } else { p.width };
    let h = if p.height == 0.0 { 1.0 } else { p.height };
    (f.bbox_w * w).max(f.bbox_h * h) / w.max(h)
}

fn has_closed_eyes(p: &SearchPhoto) -> bool {
    p.faces.iter().any(|f| judgeable(f) && f.eyes_open.is_some_and(|e| e < EYES_THRESHOLD) && face_size(p, f) >= MIN_FACE_FOR_EYES)
}

fn is_soft_focus(p: &SearchPhoto) -> bool {
    let mut best: Option<&SearchFace> = None;
    for f in &p.faces {
        if !judgeable(f) {
            continue;
        }
        if best.is_none_or(|b| f.bbox_w * f.bbox_h > b.bbox_w * b.bbox_h) {
            best = Some(f);
        }
    }
    best.is_some_and(|f| f.face_sharpness.is_some_and(|s| s < FOCUS_THRESHOLD) && face_size(p, f) >= MIN_FACE_FOR_FOCUS)
}

fn filled(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|s| !s.is_empty())
}

// Photos of the album with this name (case-insensitive)
pub type AlbumLookup<'a> = &'a dyn Fn(&str) -> Option<&'a HashSet<String>>;

fn match_one(p: &SearchPhoto, t: &Term, albums: AlbumLookup) -> bool {
    let v = t.value.to_lowercase();
    let has = |s: &str| s.to_lowercase().contains(&v);
    match t.key {
        "rating" => v.parse::<f64>().ok().filter(|n| n.is_finite()).is_some_and(|n| compare(p.rating as f64, t.op, n)),
        "flag" => {
            let flag = p.flag.as_deref().filter(|f| !f.is_empty());
            if v == "none" {
                flag.is_none()
            } else {
                flag == Some(v.as_str()) || (v == "picked" && flag == Some("pick")) || (v == "rejected" && flag == Some("reject"))
            }
        }
        "label" => {
            let label = p.color_label.as_deref().unwrap_or("");
            if v == "none" {
                label.is_empty()
            } else {
                label == v
            }
        }
        "person" => {
            let wanted: Vec<&str> = v.split('|').filter(|w| !w.is_empty()).collect();
            p.people.iter().any(|n| {
                let n = n.to_lowercase();
                wanted.iter().any(|w| if t.partial { n.starts_with(w) } else { n == *w })
            })
        }
        "tag" => p.tags.iter().any(|n| {
            let n = n.to_lowercase();
            if t.partial {
                n.starts_with(&v)
            } else {
                n == v
            }
        }),
        "camera" => has(&p.camera_model),
        "lens" => has(p.lens_model.as_deref().unwrap_or("")),
        "place" => has(&p.location),
        "name" => has(&p.name),
        "date" => match_date(&day_of(&p.captured_at), t.op, &v),
        "album" => albums(&t.value).is_some_and(|set| set.contains(&p.hash)),
        "has" => match v.as_str() {
            "gps" => p.latitude.is_some() && p.longitude.is_some(),
            "faces" => !p.faces.is_empty(),
            "people" => !p.people.is_empty(),
            "ocr" | "text" => !p.ocr_text.is_empty(),
            "caption" => !p.ai_caption.is_empty(),
            "tags" => !p.tags.is_empty(),
            "location" | "place" => !p.location.is_empty(),
            _ => false,
        },
        "is" => match v.as_str() {
            "raw" => ends_with_any(&p.name, RAW_EXT),
            "video" | "movie" => is_video(p),
            "photo" => !is_video(p),
            "paired" => filled(&p.pair_raw_path),
            "screenshot" => p.tags.iter().any(|t| t == "screenshot"),
            "whatsapp" => p.tags.iter().any(|t| t == "whatsapp"),
            "damaged" => p.damaged,
            "staged" => filled(&p.staged_target),
            "basket" | "pinned" => p.in_basket,
            "pick" | "picked" => p.flag.as_deref() == Some("pick"),
            "reject" | "rejected" => p.flag.as_deref() == Some("reject"),
            "blinking" | "closed-eyes" | "eyes-closed" => has_closed_eyes(p),
            "blurry" | "soft" | "out-of-focus" => is_soft_focus(p),
            _ => false,
        },
        _ => true,
    }
}

pub fn matches_terms(p: &SearchPhoto, terms: &[Term], albums: AlbumLookup) -> bool {
    terms.iter().all(|t| match_one(p, t, albums) != t.negate)
}

// ---------- plain words (naturalQuery.ts) ----------

struct Word {
    text: String,
    norm: String,
}

// Lower-case, no accents
fn fold(s: &str) -> String {
    s.to_lowercase().nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).map(|c| if c == '’' { '\'' } else { c }).collect()
}

// Letters and digits, plus ' ’ & - inside a word (/[\p{L}\p{N}][\p{L}\p{N}'’&-]*/u)
fn words(text: &str) -> Vec<Word> {
    let mut out = Vec::new();
    let mut current: Option<usize> = None;
    let push = |out: &mut Vec<Word>, from: usize, to: usize| {
        let w = &text[from..to];
        out.push(Word { text: w.to_string(), norm: fold(w) });
    };
    for (i, c) in text.char_indices() {
        let letter = c.is_alphabetic() || c.is_numeric();
        match current {
            Some(_) if letter || matches!(c, '\'' | '’' | '&' | '-') => {}
            Some(from) => {
                push(&mut out, from, i);
                current = if letter { Some(i) } else { None };
            }
            None if letter => current = Some(i),
            None => {}
        }
    }
    if let Some(from) = current {
        push(&mut out, from, text.len());
    }
    out
}

const MONTHS: &[(&str, u32)] = &[
    ("january", 1), ("jan", 1), ("januari", 1), ("february", 2), ("feb", 2), ("februari", 2), ("march", 3), ("mar", 3),
    ("maart", 3), ("april", 4), ("apr", 4), ("may", 5), ("mei", 5), ("june", 6), ("jun", 6), ("juni", 6), ("july", 7),
    ("jul", 7), ("juli", 7), ("august", 8), ("aug", 8), ("augustus", 8), ("september", 9), ("sep", 9), ("sept", 9),
    ("october", 10), ("oct", 10), ("oktober", 10), ("okt", 10), ("november", 11), ("nov", 11), ("december", 12), ("dec", 12),
];

// Seasons as month ranges (winter wraps into the next year)
const SEASONS: &[(&str, u32, u32, &str)] = &[
    ("spring", 3, 5, "spring"), ("lente", 3, 5, "spring"), ("voorjaar", 3, 5, "spring"),
    ("summer", 6, 8, "summer"), ("zomer", 6, 8, "summer"),
    ("autumn", 9, 11, "autumn"), ("fall", 9, 11, "autumn"), ("herfst", 9, 11, "autumn"), ("najaar", 9, 11, "autumn"),
    ("winter", 12, 2, "winter"),
];

const HOLIDAYS: &[(&[&str], &str, &str)] = &[
    (&["new", "year's", "eve"], "12-31", "12-31"),
    (&["oudejaarsavond"], "12-31", "12-31"),
    (&["oudejaar"], "12-31", "12-31"),
    (&["oudjaar"], "12-31", "12-31"),
    (&["new", "year"], "01-01", "01-01"),
    (&["nieuwjaar"], "01-01", "01-01"),
    (&["christmas"], "12-24", "12-26"),
    (&["xmas"], "12-24", "12-26"),
    (&["kerstmis"], "12-24", "12-26"),
    (&["kerst"], "12-24", "12-26"),
    (&["valentine's", "day"], "02-14", "02-14"),
    (&["valentijn"], "02-14", "02-14"),
    (&["halloween"], "10-31", "10-31"),
];

const FILLERS: &[&str] = &[
    "in", "at", "on", "from", "during", "of", "the", "around", "near", "taken", "op", "van", "tijdens", "uit", "bij", "rond", "de",
    "het", "genomen",
];
const PHOTO_WORDS: &[&str] = &["photo", "photos", "picture", "pictures", "pics", "pic", "foto", "fotos", "foto's", "images"];
const AND: &[&str] = &["and", "with", "en", "met", "&", "plus"];
const OR: &[&str] = &["or", "of"];

fn year_at(w: Option<&Word>) -> Option<i32> {
    let n = &w?.norm;
    let b = n.as_bytes();
    let ok = b.len() == 4
        && b.iter().all(u8::is_ascii_digit)
        && ((b[0] == b'1' && b[1] == b'9' && (b'7'..=b'9').contains(&b[2])) || (b[0] == b'2' && b[1] == b'0'));
    if ok {
        n.parse().ok()
    } else {
        None
    }
}

fn month_range(y: i32, from: u32, to: u32) -> String {
    let y2 = if to < from { y + 1 } else { y };
    format!("{y}-{from:02}-01..{y2}-{to:02}-{:02}", last_day(y2, to))
}

// A date phrase starting at word i: "summer 2024", "june", "last year", "kerst 2023", "2021" -> (words used, date: value)
fn date_at(ws: &[Word], i: usize, today: Day) -> Option<(usize, String)> {
    let w = |k: usize| ws.get(i + k).map(|w| w.norm.as_str());
    let (y, m) = (today.year, today.month);
    let two = format!("{} {}", w(0).unwrap_or(""), w(1).unwrap_or(""));
    match two.as_str() {
        "last year" | "vorig jaar" | "vorige jaar" => return Some((2, (y - 1).to_string())),
        "this year" | "dit jaar" => return Some((2, y.to_string())),
        "last month" | "vorige maand" => {
            let (yy, mm) = if m == 1 { (y - 1, 12) } else { (y, m - 1) };
            return Some((2, format!("{yy}-{mm:02}")));
        }
        "last week" | "vorige week" => return Some((2, format!("{}..{}", today.plus(-7).iso(), today.plus(-1).iso()))),
        _ => {}
    }
    if matches!(w(0), Some("yesterday") | Some("gisteren")) {
        return Some((1, today.plus(-1).iso()));
    }
    // "last summer" / "vorige zomer" / "this summer": the latest one that has started or is over
    if let (Some(first), Some(season)) = (w(0), w(1).and_then(|s| SEASONS.iter().find(|x| x.0 == s))) {
        if ["last", "vorige", "afgelopen", "this", "deze"].contains(&first) {
            let this_one = first == "this" || first == "deze";
            let (from, to) = (season.1, season.2);
            let mut yy = y + 1;
            while yy > y - 3 {
                let start = Day { year: yy, month: from, day: 1 };
                let end_year = if to < from { yy + 1 } else { yy };
                let end = Day { year: end_year, month: to, day: last_day(end_year, to) };
                if if this_one { start <= today } else { end < today } {
                    break;
                }
                yy -= 1;
            }
            return Some((2, month_range(yy, from, to)));
        }
    }
    // Holidays, with an optional year after them
    for (hw, from, to) in HOLIDAYS {
        if hw.iter().enumerate().all(|(k, word)| w(k) == Some(*word)) {
            let n = hw.len();
            return Some(match year_at(ws.get(i + n)) {
                Some(year) => (n + 1, format!("{year}-{from}..{year}-{to}")),
                None => (n, format!("*-{from}..*-{to}")),
            });
        }
    }
    // Season or month, with an optional year after it ("summer 2024", "zomer van 2023")
    let season = w(0).and_then(|s| SEASONS.iter().find(|x| x.0 == s));
    let month = w(0).and_then(|s| MONTHS.iter().find(|x| x.0 == s)).map(|x| x.1);
    if season.is_some() || month.is_some() {
        let via = if matches!(w(1), Some("of") | Some("van")) { 1 } else { 0 };
        let year = year_at(ws.get(i + 1 + via));
        let used = if year.is_some() { 2 + via } else { 1 };
        if let Some(s) = season {
            return Some(match year {
                Some(year) => (used, month_range(year, s.1, s.2)),
                None => (1, format!("*-{:02}-01..*-{:02}-{:02}", s.1, s.2, last_day(2001, s.2))),
            });
        }
        // "may" on its own is too often the verb: only with a year
        if w(0) == Some("may") && year.is_none() {
            return None;
        }
        let month = month.unwrap_or(1);
        return Some(match year {
            Some(year) => (used, format!("{year}-{month:02}")),
            None => (1, format!("*-{month:02}")),
        });
    }
    year_at(ws.get(i)).map(|year| (1, year.to_string()))
}

struct NameIndex {
    map: HashMap<String, String>,
    max_words: usize,
}

fn name_index(list: &[String], with_first_names: bool) -> NameIndex {
    let mut map = HashMap::new();
    let mut first_names: Vec<(String, Vec<String>)> = Vec::new();
    let mut max_words = 1;
    for name in list {
        let key = fold(name).trim().to_string();
        if key.is_empty() {
            continue;
        }
        map.insert(key.clone(), name.clone());
        let parts: Vec<&str> = key.split_whitespace().collect();
        max_words = max_words.max(parts.len());
        let first = parts[0].to_string();
        match first_names.iter_mut().find(|(f, _)| *f == first) {
            Some((_, names)) => names.push(name.clone()),
            None => first_names.push((first, vec![name.clone()])),
        }
    }
    // "anna" finds "Anna Smith" when she is the only Anna
    if with_first_names {
        for (first, names) in first_names {
            if names.len() == 1 && !map.contains_key(&first) {
                map.insert(first, names[0].clone());
            }
        }
    }
    NameIndex { map, max_words }
}

// Longest library name (person or place) starting at word i
fn name_at(ws: &[Word], i: usize, names: &NameIndex) -> Option<(usize, String)> {
    let most = names.max_words.min(ws.len() - i);
    (1..=most).rev().find_map(|n| {
        let key = ws[i..i + n].iter().map(|w| w.norm.as_str()).collect::<Vec<_>>().join(" ");
        names.map.get(&key).map(|name| (n, name.clone()))
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Person,
    Date,
    Place,
}

struct Span {
    kind: Kind,
    from: usize,
    to: usize,
    value: String,
}

// Plain words that mean a person, a date or a place become terms; the rest is left as text
fn interpret_natural(text: &str, people: &[String], places: &[String], today: Day, skip: &HashSet<&str>) -> (Vec<Term>, String) {
    let ws = words(text);
    let people = name_index(people, true);
    let places = name_index(places, false);
    let mut spans: Vec<Span> = Vec::new();
    let mut i = 0;
    while i < ws.len() {
        // The user's own names first (someone may be called June or Summer), then dates, then places
        if !skip.contains("person") {
            if let Some((n, name)) = name_at(&ws, i, &people) {
                spans.push(Span { kind: Kind::Person, from: i, to: i + n, value: name });
                i += n;
                continue;
            }
        }
        if !skip.contains("date") {
            if let Some((n, value)) = date_at(&ws, i, today) {
                spans.push(Span { kind: Kind::Date, from: i, to: i + n, value });
                i += n;
                continue;
            }
        }
        if !skip.contains("place") {
            if let Some((n, name)) = name_at(&ws, i, &places) {
                spans.push(Span { kind: Kind::Place, from: i, to: i + n, value: name });
                i += n;
                continue;
            }
        }
        i += 1;
    }
    if spans.is_empty() {
        return (Vec::new(), text.trim().to_string());
    }

    let mut used = vec![false; ws.len()];
    for s in &spans {
        for u in &mut used[s.from..s.to] {
            *u = true;
        }
    }
    let span_at = |k: usize| spans.iter().any(|s| s.from <= k && k < s.to);
    let is_glue = |w: &Word| FILLERS.contains(&w.norm.as_str()) || AND.contains(&w.norm.as_str());
    // People joined by "or" become one either/or filter; "and" / "with" keep them separate
    let mut groups: Vec<Vec<&Span>> = Vec::new();
    for s in spans.iter().filter(|s| s.kind == Kind::Person) {
        let last = groups.last().and_then(|g| g.last()).map(|l| l.to);
        let between = last.map(|to| &ws[to..s.from]).unwrap_or(&[]);
        match last {
            Some(to) if between.len() == 1 && OR.contains(&between[0].norm.as_str()) => {
                groups.last_mut().unwrap().push(s);
                used[to] = true;
            }
            _ => {
                if let Some(to) = last {
                    if between.len() == 1 && AND.contains(&between[0].norm.as_str()) {
                        used[to] = true;
                    }
                }
                groups.push(vec![s]);
            }
        }
    }
    for k in 0..ws.len() {
        if used[k] || !is_glue(&ws[k]) {
            continue;
        }
        // A filler next to a recognised part (or a run of fillers leading to one): "in 2024", "in de zomer"
        let mut j = k;
        while j < ws.len() && !used[j] && is_glue(&ws[j]) {
            j += 1;
        }
        let mut b = k as isize - 1;
        while b >= 0 && !used[b as usize] && is_glue(&ws[b as usize]) {
            b -= 1;
        }
        if (j < ws.len() && span_at(j)) || (b >= 0 && span_at(b as usize) && j >= ws.len()) {
            for u in &mut used[k..j] {
                *u = true;
            }
        }
    }
    // "photos of ..." at the start
    let mut k = 0;
    while k < ws.len() && (PHOTO_WORDS.contains(&ws[k].norm.as_str()) || (k > 0 && FILLERS.contains(&ws[k].norm.as_str()))) {
        used[k] = true;
        k += 1;
    }

    let term = |key: &'static str, value: String| Term { key, op: Op::Eq, value, negate: false, partial: false };
    let mut terms: Vec<Term> = groups.iter().map(|g| term("person", g.iter().map(|s| s.value.as_str()).collect::<Vec<_>>().join("|"))).collect();
    for s in spans.iter().filter(|s| s.kind != Kind::Person) {
        terms.push(term(if s.kind == Kind::Date { "date" } else { "place" }, s.value.clone()));
    }
    let rest = ws.iter().zip(&used).filter(|(_, u)| !**u).map(|(w, _)| w.text.as_str()).collect::<Vec<_>>().join(" ");
    (terms, rest)
}

// ---------- the whole search (searchRun.ts) ----------

// Names and places the library knows, from its photos, in the order they first appear
pub fn vocabulary(photos: &[SearchPhoto]) -> (Vec<String>, Vec<String>) {
    let (mut people, mut places) = (Vec::new(), Vec::new());
    let (mut seen_people, mut seen_places) = (HashSet::new(), HashSet::new());
    for p in photos {
        for name in &p.people {
            if seen_people.insert(name.clone()) {
                people.push(name.clone());
            }
        }
        let city = p.location.split(',').next().unwrap_or("").trim().to_string();
        if !city.is_empty() && seen_places.insert(city.clone()) {
            places.push(city);
        }
    }
    (people, places)
}

// The typed terms plus what plain words mean; typed terms win over understood ones of the same kind
pub fn understand(query: &str, people: &[String], places: &[String], today: Day) -> (Vec<Term>, String) {
    let parsed = parse_query(query);
    let typed: HashSet<&str> = parsed.terms.iter().map(|t| t.key).collect();
    let (natural, rest) = interpret_natural(&parsed.text, people, places, today, &typed);
    let mut terms = parsed.terms;
    terms.extend(natural);
    (terms, rest)
}

fn search_text(p: &SearchPhoto) -> String {
    let mut parts: Vec<&str> = vec![&p.name, &p.ai_caption, &p.ocr_text, &p.location];
    parts.extend(p.tags.iter().map(String::as_str));
    parts.extend(p.people.iter().map(String::as_str));
    parts.join("\n").to_lowercase()
}

// Smart search's "good enough" line, as in semanticCutoff.ts
const SPREAD_FRACTION: f64 = 0.6;
const ABSOLUTE_FLOOR: f64 = 0.12;
const SEMANTIC_MAX_HITS: usize = 1000;

fn semantic_cutoff(sorted_best_first: &[f64]) -> f64 {
    if sorted_best_first.is_empty() {
        return ABSOLUTE_FLOOR;
    }
    let top = sorted_best_first[0];
    let median = sorted_best_first[sorted_best_first.len() / 2];
    ABSOLUTE_FLOOR.max(median + SPREAD_FRACTION * (top - median))
}

// The free text of a query once its terms and understood words are taken out (what smart search embeds)
pub fn free_text(query: &str, photos: &[SearchPhoto], today: Day) -> String {
    let (people, places) = vocabulary(photos);
    understand(query, &people, &places, today).1
}

// The photos a saved search shows: best match first with smart search scores (hash -> score), else as given
pub fn run_search<'p>(
    photos: &'p [SearchPhoto],
    query: &str,
    today: Day,
    albums: AlbumLookup,
    semantic_scores: Option<&HashMap<String, f64>>,
) -> Vec<&'p SearchPhoto> {
    let (people, places) = vocabulary(photos);
    let (terms, text) = understand(query, &people, &places, today);
    let scores = semantic_scores.filter(|_| !text.is_empty());
    let q = if scores.is_some() { String::new() } else { text.to_lowercase() };
    let mut kept: Vec<&SearchPhoto> = photos
        .iter()
        .filter(|p| {
            // A Live Photo's clip plays from its photo
            if filled(&p.live_photo_hash) {
                return false;
            }
            if !q.is_empty() && !search_text(p).contains(&q) {
                return false;
            }
            if !terms.is_empty() && !matches_terms(p, &terms, albums) {
                return false;
            }
            scores.is_none_or(|s| s.contains_key(&p.hash))
        })
        .collect();
    let Some(scores) = scores else { return kept };
    let score = |p: &SearchPhoto| scores.get(&p.hash).copied().unwrap_or(0.0);
    // A stable sort, best first, as the grid's
    kept.sort_by(|a, b| score(b).partial_cmp(&score(a)).unwrap_or(std::cmp::Ordering::Equal));
    let line = semantic_cutoff(&kept.iter().map(|p| score(p)).collect::<Vec<_>>());
    kept.into_iter().filter(|p| score(p) >= line).take(SEMANTIC_MAX_HITS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/search-cases.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn setup(f: &Value) -> (Vec<SearchPhoto>, HashMap<String, HashSet<String>>, Day) {
        let photos: Vec<SearchPhoto> = serde_json::from_value(f["photos"].clone()).unwrap();
        let albums = f["albums"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, hashes)| (name.to_lowercase(), hashes.as_array().unwrap().iter().map(|h| h.as_str().unwrap().to_string()).collect()))
            .collect();
        (photos, albums, Day::parse(f["today"].as_str().unwrap()).unwrap())
    }

    fn expected(c: &Value) -> Vec<String> {
        c["expect"].as_array().unwrap().iter().map(|h| h.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn the_shared_search_examples_find_the_same_photos_as_the_frontend() {
        let f = fixture();
        let (photos, albums, today) = setup(&f);
        let lookup = |name: &str| albums.get(&name.to_lowercase());
        let mut wrong = Vec::new();
        for c in f["cases"].as_array().unwrap() {
            let query = c["query"].as_str().unwrap();
            let got: Vec<String> = run_search(&photos, query, today, &lookup, None).iter().map(|p| p.hash.clone()).collect();
            if got != expected(c) {
                wrong.push(format!("{query:?}: got {got:?}, expected {:?}", expected(c)));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[test]
    fn smart_search_examples_rank_and_cut_like_the_grid() {
        let f = fixture();
        let (photos, albums, today) = setup(&f);
        let lookup = |name: &str| albums.get(&name.to_lowercase());
        let scores: HashMap<String, f64> =
            f["smart"]["scores"].as_object().unwrap().iter().map(|(h, s)| (h.clone(), s.as_f64().unwrap())).collect();
        for c in f["smart"]["cases"].as_array().unwrap() {
            let query = c["query"].as_str().unwrap();
            let got: Vec<String> = run_search(&photos, query, today, &lookup, Some(&scores)).iter().map(|p| p.hash.clone()).collect();
            assert_eq!(got, expected(c), "query {query:?}");
        }
    }

    #[test]
    fn days_count_across_months_and_years() {
        let d = Day::parse("2026-03-01").unwrap();
        assert_eq!(d.plus(-1).iso(), "2026-02-28");
        assert_eq!(Day::parse("2024-03-01").unwrap().plus(-1).iso(), "2024-02-29");
        assert_eq!(Day::parse("2026-01-03").unwrap().plus(-7).iso(), "2025-12-27");
        assert_eq!((last_day(2025, 12), last_day(2028, 2)), (31, 29));
    }
}
