// Trips and big days ("moments"), made by the engine from when and where photos were taken, and kept in the
// database (`moments`, `moment_photos`) so every window, phone and web client shows the same ones without
// working them out over the whole list itself.
//
// 1. Days: photos in time order, split where there is a gap of 12+ hours, a jump of 100+ km, or where the
//    photos cross the line 50 km around home (a morning at home and an afternoon at the coast are two parts).
// 2. Each day is away (its GPS photos 50+ km from home, the densest GPS area of every library), at home, or
//    unknown (no GPS). A trip is the days away that follow each other with less than two days between them;
//    days without GPS between two days away belong to it (a camera without GPS on the same journey).
// 3. Days at home with many photos (a birthday, a party) are big days. Other days at home aren't listed.
// Only photos someone took make or join one: with a camera or a GPS position, and not WhatsApp or a screenshot.
// Received, downloaded and edited images carry the date they arrived, and a screen is no place. Copies of a
// photo (the same name and time, in two libraries) count once.
//
// Made over every library of the database together, so a trip with phone photos in one library and camera
// photos in another is one trip; a window asks for the moments of its folder (`get_moments`).
use crate::db::{make_folder_prefix, open_global_db};
use crate::host::SharedHost;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const HOUR: i64 = 3_600_000;
const DAY_GAP: i64 = 12 * HOUR;
const TRIP_GAP: i64 = 48 * HOUR;
const JUMP_KM: f64 = 100.0;
const AWAY_KM: f64 = 50.0;
const MIN_TRIP_PHOTOS: usize = 5;
const BIG_DAY_PHOTOS: usize = 50;
const COVER: usize = 4;
const DAY: i64 = 24 * HOUR;
// Trips in the same country abroad this close together are one journey (a night or two somewhere without photos)
const ABROAD_GAP: i64 = 4 * DAY;
// Days of a long stay somewhere (a hospital) that follow each other this closely are one stay
const STAY_GAP: i64 = 9 * DAY;
// A day with fewer photos than a big day, but a birthday or a party in its captions
const OCCASION_PHOTOS: usize = 10;
// A day elsewhere near home is a day out from this far (the next town over is just home)
const DAY_OUT_KM: f64 = 15.0;
// Goes up when the rule changes, so moments made by the old one are made again
const RULE: i64 = 3;

#[derive(Debug, Clone, Default)]
pub struct MomentPhoto {
    pub hash: String,
    pub name: String,
    pub captured_at: String,
    pub location: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub camera_model: String,
    // A WhatsApp photo or a screenshot
    pub received: bool,
    // Ollama's caption, empty when there is none yet
    pub caption: String,
    // The names of the people in it
    pub people: Vec<String>,
}

// What a caption says, as bits worked out once per photo
const CAPTIONED: u32 = 1;
const BIRTHDAY: u32 = 1 << 1;
const WEDDING: u32 = 1 << 2;
const CHRISTMAS: u32 = 1 << 3;
const FIREWORKS: u32 = 1 << 4;
const PARTY: u32 = 1 << 5;
const BEACH: u32 = 1 << 6;
const SNOW: u32 = 1 << 7;
const SKI: u32 = 1 << 8;
const WALK: u32 = 1 << 9;
const HOSPITAL: u32 = 1 << 10;
const DOG: u32 = 1 << 11;
const CAT: u32 = 1 << 12;
const FESTIVAL: u32 = 1 << 13;
const CONCERT: u32 = 1 << 14;
const EXHIBITION: u32 = 1 << 15;
const RACE: u32 = 1 << 16;
const THEMES: usize = 17;

fn themes_of(caption: &str) -> u32 {
    if caption.trim().is_empty() {
        return 0;
    }
    let lower = caption.to_lowercase();
    let (mut bits, mut cake, mut candle) = (CAPTIONED, false, false);
    for word in lower.split(|c: char| !c.is_alphabetic()) {
        bits |= match word {
            "birthday" | "birthdays" => BIRTHDAY,
            "wedding" | "bride" | "groom" => WEDDING,
            "christmas" | "santa" => CHRISTMAS,
            "firework" | "fireworks" => FIREWORKS,
            "party" | "balloon" | "balloons" | "confetti" => PARTY,
            "beach" => BEACH,
            "snow" | "snowy" | "snowman" => SNOW,
            "ski" | "skis" | "skiing" | "skier" | "skiers" | "snowboard" | "snowboarding" => SKI,
            "walk" | "walks" | "walking" | "hike" | "hiking" | "forest" | "trail" => WALK,
            "hospital" => HOSPITAL,
            "dog" | "dogs" | "puppy" | "puppies" => DOG,
            "cat" | "cats" | "kitten" | "kittens" => CAT,
            "festival" | "festivals" => FESTIVAL,
            "concert" | "concerts" => CONCERT,
            "exhibition" | "exhibit" | "exhibits" | "museum" => EXHIBITION,
            "race" | "racing" | "racetrack" | "circuit" => RACE,
            _ => 0,
        };
        cake |= word == "cake" || word == "cakes";
        candle |= word == "candle" || word == "candles";
    }
    if cake && candle {
        bits |= BIRTHDAY;
    }
    bits
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Trip,
    BigDay,
}

impl Kind {
    // As the apps have named them since trips were found in the frontend
    fn as_str(self) -> &'static str {
        match self {
            Kind::Trip => "trip",
            Kind::BigDay => "event",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Made {
    pub kind: Kind,
    pub place: String,
    // What it was, as far as the captions and people tell ("Beach trip with Toniq", "Visit from John & Sabine")
    pub title: String,
    pub start: i64,
    pub end: i64,
    // Every photo of it in time order, copies too
    pub hashes: Vec<String>,
    // How many photos, a copy counted once
    pub count: usize,
}

// A moment as a window lists it: its photos are asked for when it is opened (`get_moment_photos`)
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MomentItem {
    pub id: String,
    pub kind: String,
    pub place: String,
    // The name the engine gave it; a name someone gave (trip_names) wins over it
    pub title: String,
    pub start: i64,
    pub end: i64,
    pub count: usize,
    // Up to four photos spread over it
    pub cover: Vec<String>,
}

// "2024:06:15 18:30:00" -> ms (as UTC: only differences matter). Out-of-range parts carry over, as Date.UTC does.
pub fn time_of(captured_at: &str) -> Option<i64> {
    let b = captured_at.as_bytes();
    let digits = |from: usize, n: usize| -> Option<i64> {
        let s = b.get(from..from + n)?;
        s.iter().all(u8::is_ascii_digit).then(|| s.iter().fold(0i64, |v, d| v * 10 + (d - b'0') as i64))
    };
    let sep = |at: usize, ok: &[u8]| b.get(at).is_some_and(|c| ok.contains(c));
    let year = digits(0, 4)?;
    if !sep(4, b"-:") || !sep(7, b"-:") || !sep(10, b" T") || !sep(13, b":") {
        return None;
    }
    let (month, day, hour, minute) = (digits(5, 2)?, digits(8, 2)?, digits(11, 2)?, digits(14, 2)?);
    // Seconds are optional, with or without their colon
    let second = if sep(16, b":") { digits(17, 2) } else { digits(16, 2) }.unwrap_or(0);
    if year <= 1971 {
        return None;
    }
    let months = year * 12 + month - 1;
    let days = days_from_civil(months.div_euclid(12), months.rem_euclid(12) + 1, 1) + day - 1;
    Some(days * 86_400_000 + hour * HOUR + minute * 60_000 + second * 1000)
}

// Days since 1970-01-01 (Howard Hinnant's algorithm)
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// (year, month 1-12, day)
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

// A clock that was never set (a camera starts at 1 Jan 2000 or 1980, in its first hour) or a date still to come
fn impossible(t: i64, now: i64) -> bool {
    let (year, month, day) = civil_from_days(t.div_euclid(86_400_000));
    let first_hour = month == 1 && day == 1 && t.rem_euclid(86_400_000) < HOUR;
    (first_hour && (year == 2000 || year == 1980)) || t > now + 24 * HOUR
}

fn gps_of(p: &MomentPhoto) -> Option<(f64, f64)> {
    Some((p.latitude?, p.longitude?))
}

// Photos that tell where someone was: taken with a camera or with a position, not received and not of a screen
fn tells_where(p: &MomentPhoto) -> bool {
    (!p.camera_model.trim().is_empty() || gps_of(p).is_some()) && !p.received
}

pub fn distance_km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let rad = std::f64::consts::PI / 180.0;
    let d_lat = (b.0 - a.0) * rad;
    let d_lon = (b.1 - a.1) * rad;
    let h = (d_lat / 2.0).sin().powi(2) + (a.0 * rad).cos() * (b.0 * rad).cos() * (d_lon / 2.0).sin().powi(2);
    12_742.0 * h.sqrt().min(1.0).asin()
}

// Rounds .5 up, as JavaScript's Math.round (the frontend's rule found the same home)
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

// Home = the centre of the densest ~50 km grid cell of all GPS photos
pub fn home_of<'a>(photos: impl Iterator<Item = &'a MomentPhoto>) -> Option<(f64, f64)> {
    let mut cells: Vec<((i64, i64), usize, f64, f64)> = Vec::new();
    let mut index: HashMap<(i64, i64), usize> = HashMap::new();
    for p in photos {
        let Some(g) = gps_of(p) else { continue };
        let key = (js_round(g.0 * 2.0), js_round(g.1 * 2.0));
        let i = *index.entry(key).or_insert_with(|| {
            cells.push((key, 0, 0.0, 0.0));
            cells.len() - 1
        });
        cells[i].1 += 1;
        cells[i].2 += g.0;
        cells[i].3 += g.1;
    }
    let mut best: Option<&((i64, i64), usize, f64, f64)> = None;
    for c in &cells {
        if best.is_none_or(|b| c.1 > b.1) {
            best = Some(c);
        }
    }
    best.map(|c| (c.2 / c.1 as f64, c.3 / c.1 as f64))
}

struct Timed<'a> {
    p: &'a MomentPhoto,
    t: i64,
    themes: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum Where {
    Away,
    Home,
    Unknown,
}

fn centroid(photos: &[&Timed]) -> Option<(f64, f64)> {
    let (mut n, mut lat, mut lon) = (0usize, 0.0, 0.0);
    for x in photos {
        if let Some(g) = gps_of(x.p) {
            n += 1;
            lat += g.0;
            lon += g.1;
        }
    }
    (n > 0).then(|| (lat / n as f64, lon / n as f64))
}

fn country_name(code: &str) -> String {
    let upper = code.to_uppercase();
    COUNTRIES.iter().find(|(c, _)| *c == upper).map(|(_, n)| n.to_string()).unwrap_or_else(|| code.to_string())
}

// Counts in the order first seen, most common first (a stable sort keeps that order between equal counts)
fn ranked(names: impl Iterator<Item = String>) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    for name in names {
        match out.iter_mut().find(|(n, _)| *n == name) {
            Some(entry) => entry.1 += 1,
            None => out.push((name, 1)),
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

// The most common place ("Paris, FR" -> "Paris"), with a second when it is common too. A journey through more
// than three places is named after its country, or its two countries.
fn place_name(photos: &[&Timed]) -> String {
    let parts = |p: &MomentPhoto| -> (String, String) { (town_of(p), p.location.split(',').nth(1).unwrap_or_default().trim().to_string()) };
    let cities = ranked(photos.iter().map(|x| parts(x.p).0).filter(|c| !c.is_empty()));
    let countries = ranked(photos.iter().map(|x| parts(x.p).1).filter(|c| !c.is_empty()));
    if cities.is_empty() {
        return String::new();
    }
    if cities.len() > 3 && !countries.is_empty() {
        let first = &countries[0];
        return match countries.get(1) {
            Some(second) if second.1 as f64 >= first.1 as f64 * 0.25 => {
                format!("{} & {}", country_name(&first.0), country_name(&second.0))
            }
            _ => country_name(&first.0),
        };
    }
    if cities.len() == 1 {
        return cities[0].0.clone();
    }
    let (first, second) = (&cities[0], &cities[1]);
    if second.1 as f64 >= first.1 as f64 * 0.25 {
        format!("{} & {}", first.0, second.0)
    } else {
        first.0.clone()
    }
}

// "Paris" in "Paris, FR"; a district ("Zagreb - Centar") is its town
fn town_of(p: &MomentPhoto) -> String {
    let town = p.location.split(',').next().unwrap_or_default();
    town.split(" - ").next().unwrap_or_default().trim().to_string()
}

// How many photos, a copy in another library (the same name and time) counted once
fn distinct(photos: &[&Timed]) -> usize {
    photos
        .iter()
        .map(|x| if x.p.name.is_empty() { x.p.hash.clone() } else { format!("{}|{}", x.p.name, x.p.captured_at) })
        .collect::<HashSet<_>>()
        .len()
}

// What the whole library says about people: who lives there (the few people in far more photos than anyone
// else), which "people" are pets (their photos' captions name a dog or a cat), and when each was first seen
struct Known {
    household: HashSet<String>,
    // A pet and the caption word for its kind; the first of a kind is the one in most photos
    pets: Vec<(String, u32)>,
    home_country: String,
    // The towns of home (more than one when someone moved house): a day elsewhere near home is a day out
    home_towns: HashSet<String>,
    home: Option<(f64, f64)>,
    first_seen: HashMap<String, i64>,
}

fn known(timed: &[Timed], home: Option<(f64, f64)>) -> Known {
    // (photos, captioned, dog, cat)
    let mut per: HashMap<&str, (usize, usize, usize, usize)> = HashMap::new();
    let mut first_seen: HashMap<String, i64> = HashMap::new();
    for x in timed {
        for name in &x.p.people {
            let e = per.entry(name.as_str()).or_default();
            e.0 += 1;
            if x.themes & CAPTIONED != 0 {
                e.1 += 1;
            }
            if x.themes & DOG != 0 {
                e.2 += 1;
            }
            if x.themes & CAT != 0 {
                e.3 += 1;
            }
            first_seen.entry(name.clone()).or_insert(x.t);
        }
    }
    let mut pets: Vec<(String, u32, usize)> = Vec::new();
    for (name, e) in &per {
        if e.1 >= 10 && e.2 as f64 >= e.1 as f64 * 0.6 {
            pets.push((name.to_string(), DOG, e.0));
        } else if e.1 >= 10 && e.3 as f64 >= e.1 as f64 * 0.6 {
            pets.push((name.to_string(), CAT, e.0));
        }
    }
    pets.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    let is_pet = |n: &str| pets.iter().any(|p| p.0 == n);
    let top = per.iter().filter(|(n, _)| !is_pet(n)).map(|(_, e)| e.0).max().unwrap_or(0);
    let household = per.iter().filter(|(n, e)| !is_pet(n) && e.0 as f64 >= top as f64 * 0.4).map(|(n, _)| n.to_string()).collect();
    let home_country = ranked(
        timed
            .iter()
            .filter(|x| gps_of(x.p).zip(home).is_some_and(|(g, h)| distance_km(g, h) <= AWAY_KM))
            .filter_map(|x| x.p.location.split(',').nth(1).map(|c| c.trim().to_string()))
            .filter(|c| !c.is_empty()),
    )
    .into_iter()
    .next()
    .map(|c| c.0)
    .unwrap_or_default();
    let at_home: Vec<String> = timed
        .iter()
        .filter(|x| gps_of(x.p).zip(home).is_some_and(|(g, h)| distance_km(g, h) <= AWAY_KM))
        .map(|x| town_of(x.p))
        .filter(|t| !t.is_empty())
        .collect();
    let home_towns = ranked(at_home.iter().cloned()).into_iter().filter(|t| t.1 * 5 >= at_home.len()).map(|t| t.0).collect();
    Known { household, pets: pets.into_iter().map(|p| (p.0, p.1)).collect(), home_country, home_towns, home, first_seen }
}

// What a group of photos shows: how many captions name each thing, and who is in how many photos
struct Look {
    n: usize,
    themes: [usize; THEMES],
    people: Vec<(String, usize)>,
}

fn look(group: &[&Timed]) -> Look {
    let mut themes = [0usize; THEMES];
    for x in group {
        for (i, t) in themes.iter_mut().enumerate() {
            if x.themes & (1 << i) != 0 {
                *t += 1;
            }
        }
    }
    let people = ranked(group.iter().flat_map(|x| x.p.people.iter().collect::<std::collections::BTreeSet<_>>()).cloned());
    Look { n: group.len(), themes, people }
}

impl Look {
    fn captioned(&self) -> usize {
        self.themes[0]
    }
    // The share of the captioned photos whose caption names it
    fn share(&self, bit: u32) -> f64 {
        self.themes[bit.trailing_zeros() as usize] as f64 / self.captioned().max(1) as f64
    }
    fn hits(&self, bit: u32) -> usize {
        self.themes[bit.trailing_zeros() as usize]
    }
    // People who don't live there and aren't pets, with the share of the photos they are in
    fn guests(&self, known: &Known) -> Vec<(&str, f64)> {
        self.people
            .iter()
            .filter(|(n, _)| !known.household.contains(n) && !known.pets.iter().any(|p| p.0 == *n))
            .map(|(n, c)| (n.as_str(), *c as f64 / self.n.max(1) as f64))
            .collect()
    }
    // The pet that was there: its face in a few photos, or its kind in many captions
    fn pet<'k>(&self, known: &'k Known) -> Option<&'k str> {
        known
            .pets
            .iter()
            .enumerate()
            .find(|(i, (name, kind))| {
                let seen = self.people.iter().find(|(n, _)| n == name).map_or(0, |p| p.1);
                let first_of_kind = !known.pets[..*i].iter().any(|p| p.1 == *kind);
                seen as f64 >= self.n as f64 * 0.05 || (first_of_kind && self.share(*kind) >= 0.4)
            })
            .map(|(_, (name, _))| name.as_str())
    }
}

fn first_name(name: &str) -> &str {
    name.split_whitespace().next().unwrap_or(name)
}

// "John", "John & Sabine": one in at least that share of the photos, a second in a third of it (guests come
// most first)
fn names_of(guests: &[(&str, f64)], at_least: f64) -> Option<String> {
    if guests.first().is_none_or(|g| g.1 < at_least) {
        return None;
    }
    // In the order of the alphabet, so days of one visit get the same name
    let mut names: Vec<&str> = guests.iter().filter(|g| g.1 >= at_least / 3.0).map(|g| first_name(g.0)).collect();
    if names.len() > 2 {
        // More people: only the ones clearly there
        names = guests.iter().filter(|g| g.1 >= at_least).map(|g| first_name(g.0)).collect();
    }
    names.sort();
    match names.len() {
        1 => Some(names[0].to_string()),
        2 => Some(format!("{} & {}", names[0], names[1])),
        _ => None,
    }
}

fn civil_of(t: i64) -> (i64, i64, i64) {
    civil_from_days(t.div_euclid(DAY))
}

// "Beach trip to Koksijde", or "Beach trip" when the place isn't known
fn with_place(label: &str, prep: &str, place: &str) -> String {
    if place.is_empty() {
        label.to_string()
    } else {
        format!("{label} {prep} {place}")
    }
}

// What a trip was: an occasion first (New Year, a wedding), then a long summer abroad, what was done, and how long
// Guests aren't named: a trip is remembered by where it went. A trip named after a country isn't a "weekend".
fn trip_title(l: &Look, known: &Known, abroad: bool, start: i64, end: i64, place: &str, a_country: bool) -> String {
    let (y1, m1, _) = civil_of(start);
    let (y2, _, _) = civil_of(end);
    let days = end.div_euclid(DAY) - start.div_euclid(DAY) + 1;
    let pet = l.pet(known);
    if y1 != y2 {
        return with_place("New year's trip", "to", place);
    }
    if l.share(WEDDING) >= 0.3 {
        return with_place("Wedding", "in", place);
    }
    if l.share(SKI) >= 0.2 {
        return with_place("Ski trip", "to", place);
    }
    for (bit, label) in [(FESTIVAL, "Festival"), (CONCERT, "Concert"), (RACE, "Race day"), (EXHIBITION, "Exhibition")] {
        if l.share(bit) >= 0.2 && l.hits(bit) >= 3 {
            return with_place(label, "in", place);
        }
    }
    if abroad && days >= 5 && (6..=8).contains(&m1) {
        return if place.is_empty() { format!("Summer of {y1}") } else { format!("{place} - Summer of {y1}") };
    }
    // A walk is in many days' photos: only a trip that was mostly walking is a walking trip
    for (bit, label, at_least) in [(BEACH, "Beach trip", 0.3), (SNOW, "Snow trip", 0.3), (WALK, "Walking trip", 0.5)] {
        if l.share(bit) >= at_least {
            return match pet {
                Some(pet) => format!("{label} with {}", first_name(pet)),
                None => with_place(label, "to", place),
            };
        }
    }
    let weekday = |t: i64| (t.div_euclid(DAY) + 4).rem_euclid(7); // 0 = Sunday
    let weekend = days <= 3 && (0..days).any(|d| matches!(weekday(start + d * DAY), 0 | 6));
    if a_country {
        String::new()
    } else if days == 1 {
        with_place("Day trip", "to", place)
    } else if weekend {
        with_place("Weekend", "in", place)
    } else {
        String::new()
    }
}

struct DayTitle {
    title: String,
    // An occasion makes a smaller day a big day too
    occasion: bool,
    // A day out in another town near home: a day trip
    trip: bool,
}

fn titled(title: impl Into<String>, occasion: bool) -> Option<DayTitle> {
    Some(DayTitle { title: title.into(), occasion, trip: false })
}

// What a day near home was. Occasions first, then events and what was done, then a day out elsewhere, then who
// came.
fn day_title(l: &Look, known: &Known, at_home: bool, start: i64, group: &[&Timed]) -> Option<DayTitle> {
    let (_, month, day) = civil_of(start);
    let guests = l.guests(known);
    let pet = l.pet(known).map(first_name);
    let with_pet = |label: &str| match pet {
        Some(pet) => format!("{label} with {pet}"),
        None => label.to_string(),
    };
    if l.share(WEDDING) >= 0.15 {
        return titled("Wedding", true);
    }
    if l.share(BIRTHDAY) >= 0.15 {
        // Whose: only someone clearly in it; the household is in most photos of every day
        return titled(
            match guests.first().filter(|g| g.1 >= 0.4) {
                Some(g) => format!("Birthday of {}", first_name(g.0)),
                None => "Birthday".into(),
            },
            true,
        );
    }
    if l.share(CHRISTMAS) >= 0.15 && month == 12 && day <= 26 {
        return titled(if at_home { "Christmas at home" } else { "Christmas" }, true);
    }
    if l.share(FIREWORKS) >= 0.15 && ((month == 12 && day == 31) || (month == 1 && day == 1)) {
        return titled("New Year's Eve", true);
    }
    for (bit, label) in [(EXHIBITION, "Exhibition"), (RACE, "Race day"), (FESTIVAL, "Festival"), (CONCERT, "Concert")] {
        if l.share(bit) >= 0.2 && l.hits(bit) >= 3 {
            return titled(label, true);
        }
    }
    for (bit, label) in [(SKI, "Skiing"), (SNOW, "Snow"), (BEACH, "Beach"), (WALK, "Walk")] {
        if l.share(bit) >= 0.3 {
            return titled(with_pet(label), false);
        }
    }
    // Many guests, each in a few photos, are a gathering; one or two in many photos are a visit
    if guests.iter().filter(|g| g.1 * l.n as f64 >= 3.0 - 1e-9 && g.1 >= 0.01).count() >= 4 {
        return titled("Family gathering", false);
    }
    // Most of the day in a town that isn't home and not next to it: a day out there, whoever was met
    let towns = ranked(group.iter().map(|x| town_of(x.p)).filter(|t| !t.is_empty()));
    let located: usize = towns.iter().map(|t| t.1).sum();
    let far = centroid(group).zip(known.home).is_some_and(|(c, h)| distance_km(c, h) >= DAY_OUT_KM);
    if let Some((town, n)) = towns.first() {
        if far && !known.home_towns.contains(town) && *n * 2 >= located && located * 10 >= group.len() * 3 {
            return Some(DayTitle { title: format!("Day trip to {town}"), occasion: false, trip: true });
        }
    }
    if let Some(who) = names_of(&guests, 0.15) {
        return titled(format!("Visit from {who}"), false);
    }
    if l.share(PARTY) >= 0.15 && l.hits(PARTY) >= 3 {
        return titled(with_pet("Party"), true);
    }
    None
}

// The main country of a group of photos ("FR" in "Paris, FR")
fn country_of(group: &[&Timed]) -> String {
    ranked(group.iter().filter_map(|x| x.p.location.split(',').nth(1).map(|c| c.trim().to_string())).filter(|c| !c.is_empty()))
        .into_iter()
        .next()
        .map(|c| c.0)
        .unwrap_or_default()
}

pub fn compute(photos: &[MomentPhoto], now: i64) -> Vec<Made> {
    let mut timed: Vec<Timed> = photos
        .iter()
        .filter(|p| tells_where(p))
        .filter_map(|p| time_of(&p.captured_at).filter(|t| !impossible(*t, now)).map(|t| Timed { p, t, themes: themes_of(&p.caption) }))
        .collect();
    timed.sort_by_key(|x| x.t);
    if timed.is_empty() {
        return Vec::new();
    }
    let home = home_of(timed.iter().map(|x| x.p));
    let is_away = |g: (f64, f64)| home.is_some_and(|h| distance_km(h, g) > AWAY_KM);
    let known = known(&timed, home);
    // Cameras that record where they are in most photos: one of their photos without a position is no sign of
    // being on a trip (the phone of someone who stayed at home, while the other phone is away)
    let mut cameras: HashMap<&str, (usize, usize)> = HashMap::new();
    for x in &timed {
        let e = cameras.entry(x.p.camera_model.trim()).or_default();
        e.0 += 1;
        e.1 += gps_of(x.p).is_some() as usize;
    }
    // A phone (it records its position at times); a camera without GPS never does
    let records_gps = |model: &str| !model.is_empty() && cameras.get(model).is_some_and(|(n, gps)| *n >= 20 && *gps * 20 >= *n);

    // 1. Days
    let mut days: Vec<(Vec<&Timed>, Where)> = Vec::new();
    let mut current: Vec<&Timed> = Vec::new();
    let mut last_gps: Option<(f64, f64)> = None;
    let mut last_t = i64::MIN;
    for x in &timed {
        let g = gps_of(x.p);
        let jumped = match (g, last_gps) {
            (Some(g), Some(l)) => distance_km(g, l) >= JUMP_KM || is_away(g) != is_away(l),
            _ => false,
        };
        if !current.is_empty() && (x.t - last_t >= DAY_GAP || jumped) {
            days.push((std::mem::take(&mut current), Where::Unknown));
            last_gps = None;
        }
        current.push(x);
        if g.is_some() {
            last_gps = g;
        }
        last_t = x.t;
    }
    days.push((current, Where::Unknown));
    for d in &mut days {
        d.1 = match (centroid(&d.0), home) {
            (Some(c), Some(h)) => {
                if distance_km(h, c) > AWAY_KM {
                    Where::Away
                } else {
                    Where::Home
                }
            }
            _ => Where::Unknown,
        };
    }

    // 2. Trips: days away less than two days apart, and the days without GPS between them. The other days are
    // looked at for big days below.
    let mut trips: Vec<Vec<&Timed>> = Vec::new();
    let mut others: Vec<(Vec<&Timed>, Where)> = Vec::new();
    let mut trip: Option<Vec<&Timed>> = None;
    // Days without GPS after the trip's last day away: the trip's when another day away follows soon enough
    let mut pending: Vec<Vec<&Timed>> = Vec::new();
    type Days<'t, 'a> = Vec<Vec<&'t Timed<'a>>>;
    fn end_trip<'t, 'a>(
        trips: &mut Days<'t, 'a>,
        others: &mut Vec<(Vec<&'t Timed<'a>>, Where)>,
        trip: &mut Option<Vec<&'t Timed<'a>>>,
        pending: &mut Days<'t, 'a>,
    ) {
        if let Some(t) = trip.take() {
            trips.push(t);
        }
        others.extend(pending.drain(..).map(|d| (d, Where::Unknown)));
    }
    for (photos, place) in days {
        let last = match &trip {
            Some(t) => pending.last().unwrap_or(t).last().map(|x| x.t).unwrap_or(i64::MIN),
            None => i64::MIN,
        };
        let near = last != i64::MIN && photos[0].t - last < TRIP_GAP;
        match place {
            Where::Away if trip.is_some() && near => {
                let t = trip.as_mut().unwrap();
                for p in pending.drain(..) {
                    t.extend(p);
                }
                t.extend(photos);
            }
            Where::Away => {
                end_trip(&mut trips, &mut others, &mut trip, &mut pending);
                trip = Some(photos);
            }
            Where::Unknown if trip.is_some() && near => pending.push(photos),
            _ => {
                end_trip(&mut trips, &mut others, &mut trip, &mut pending);
                others.push((photos, place));
            }
        }
    }
    end_trip(&mut trips, &mut others, &mut trip, &mut pending);
    let trips: Vec<Vec<&Timed>> = trips
        .into_iter()
        .filter_map(|t| {
            // A phone's photo without a position is the trip's when that phone has photos with one on it
            let on_trip: HashSet<&str> = t.iter().filter(|x| gps_of(x.p).is_some()).map(|x| x.p.camera_model.trim()).collect();
            let (kept, strays): (Vec<&Timed>, Vec<&Timed>) = t.into_iter().partition(|x| {
                let model = x.p.camera_model.trim();
                gps_of(x.p).is_some() || !records_gps(model) || on_trip.contains(model)
            });
            if !strays.is_empty() {
                others.push((strays, Where::Unknown));
            }
            (!kept.is_empty()).then_some(kept)
        })
        .collect();
    others.sort_by_key(|d| d.0[0].t);

    // A journey abroad split by a few days without photos away (a night in a place without GPS) is one trip
    let mut joined: Vec<Vec<&Timed>> = Vec::new();
    for t in trips {
        if let Some(prev) = joined.last_mut() {
            let country = country_of(&t);
            let gap = t[0].t - prev[prev.len() - 1].t;
            if gap < ABROAD_GAP && !country.is_empty() && country != known.home_country && country == country_of(prev) {
                prev.extend(t);
                continue;
            }
        }
        joined.push(t);
    }

    let mut out: Vec<Made> = Vec::new();
    let made = |kind: Kind, group: &[&Timed], title: String| Made {
        kind,
        place: place_name(group),
        title,
        start: group[0].t,
        end: group[group.len() - 1].t,
        hashes: group.iter().map(|x| x.p.hash.clone()).collect(),
        count: distinct(group),
    };
    for t in &joined {
        if distinct(t) < MIN_TRIP_PHOTOS {
            continue;
        }
        let country = country_of(t);
        let abroad = !country.is_empty() && !known.home_country.is_empty() && country != known.home_country;
        let place = place_name(t);
        let a_country = !country.is_empty() && place.starts_with(&country_name(&country));
        let title = trip_title(&look(t), &known, abroad, t[0].t, t[t.len() - 1].t, &place, a_country);
        out.push(made(Kind::Trip, t, title));
    }

    // 3. Long stays: days at or near home whose captions keep naming a hospital, a few days apart at most, are one
    // stay. A newborn first seen at its start makes its first days a birth; the day after it, a homecoming.
    let stay_day = |l: &Look| l.hits(HOSPITAL) >= 3 && l.share(HOSPITAL) >= 0.25;
    let looks: Vec<Look> = others.iter().map(|d| look(&d.0)).collect();
    let mut used = vec![false; others.len()];
    let mut i = 0;
    while i < others.len() {
        if !stay_day(&looks[i]) {
            i += 1;
            continue;
        }
        let mut stay_days = 1;
        let mut j = i;
        let mut k = i + 1;
        while k < others.len() && others[k].0[0].t - others[j].0.last().unwrap().t < STAY_GAP {
            if stay_day(&looks[k]) {
                stay_days += 1;
                j = k;
            }
            k += 1;
        }
        if stay_days < 3 {
            i += 1;
            continue;
        }
        let start = others[i].0[0].t;
        let born = known
            .household
            .iter()
            .filter_map(|n| known.first_seen.get(n).map(|t| (n, *t)))
            .filter(|(_, t)| *t >= start - DAY_GAP && *t <= start + 3 * DAY)
            .min_by_key(|(n, t)| (*t, n.to_string()));
        let mut birth: Vec<&Timed> = Vec::new();
        let mut stay: Vec<&Timed> = Vec::new();
        for d in i..=j {
            let first_day = |t: i64| born.is_some_and(|(_, b)| t.div_euclid(DAY) <= b.div_euclid(DAY) + 1);
            (if first_day(others[d].0[0].t) { &mut birth } else { &mut stay }).extend(others[d].0.iter().copied());
            used[d] = true;
        }
        if let Some((name, _)) = born.filter(|_| distinct(&birth) >= OCCASION_PHOTOS) {
            out.push(made(Kind::BigDay, &birth, format!("Birth of {}", first_name(name))));
        } else {
            stay.splice(0..0, birth);
        }
        if distinct(&stay) >= OCCASION_PHOTOS {
            // One place, not the country of the trips to and from it
            let mut m = made(Kind::BigDay, &stay, "Hospital stay".into());
            let towns = ranked(stay.iter().filter_map(|x| x.p.location.split(',').next().map(|c| c.trim().to_string())).filter(|c| !c.is_empty()));
            m.place = towns.first().map(|t| t.0.clone()).unwrap_or_default();
            out.push(m);
        }
        let end = others[j].0.last().unwrap().t;
        if let Some(next) = others.get(j + 1).filter(|d| d.0[0].t - end < 3 * DAY && distinct(&d.0) >= OCCASION_PHOTOS * 2) {
            let title = match born {
                Some((name, _)) => format!("Homecoming of {}", first_name(name)),
                None => "Homecoming".into(),
            };
            out.push(made(Kind::BigDay, &next.0, title));
            used[j + 1] = true;
        }
        i = j + 2;
    }

    // 4. Big days: a day at home needs something that made it one: an occasion, guests, something done. A day
    // whose photos mostly have no caption yet can't be told apart, so many photos are enough there. Days in a row
    // with the same name (a visit of a few days) are one.
    let mut big: Vec<(Vec<&Timed>, String, Kind)> = Vec::new();
    for (d, (group, place)) in others.iter().enumerate() {
        if used[d] {
            continue;
        }
        let l = &looks[d];
        let n = distinct(group);
        let title = day_title(l, &known, *place == Where::Home, group[0].t, group);
        let unknown = l.captioned() * 2 < l.n;
        let keep = match &title {
            Some(t) => n >= BIG_DAY_PHOTOS || (t.occasion && n >= OCCASION_PHOTOS),
            None => unknown && n >= BIG_DAY_PHOTOS,
        };
        if !keep {
            continue;
        }
        let kind = if title.as_ref().is_some_and(|t| t.trip) { Kind::Trip } else { Kind::BigDay };
        let title = title.map(|t| t.title).unwrap_or_default();
        match big.last_mut() {
            Some((prev, name, k)) if !title.is_empty() && *name == title && *k == kind && group[0].t - prev[prev.len() - 1].t < TRIP_GAP => {
                prev.extend(group.iter().copied())
            }
            _ => big.push((group.clone(), title, kind)),
        }
    }
    for (group, title, kind) in big {
        out.push(made(kind, &group, title));
    }
    out.sort_by_key(|m| m.start);
    out
}

// Up to four photos spread over the moment
pub fn cover_of(hashes: &[String]) -> Vec<String> {
    let n = hashes.len();
    let mut out: Vec<String> = Vec::new();
    for i in 0..COVER {
        if let Some(h) = hashes.get(((2 * i + 1) * n) / (2 * COVER)) {
            if !out.contains(h) {
                out.push(h.clone());
            }
        }
    }
    out
}

pub fn ensure_tables(conn: &Connection) {
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS moments (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            place TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            count INTEGER NOT NULL DEFAULT 0,
            cover TEXT NOT NULL DEFAULT '[]'
         );
         CREATE TABLE IF NOT EXISTS moment_photos (
            moment_id TEXT NOT NULL,
            hash TEXT NOT NULL,
            PRIMARY KEY (moment_id, hash)
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS idx_moment_photos_hash ON moment_photos(hash);
         CREATE TABLE IF NOT EXISTS moments_made (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            revision INTEGER NOT NULL,
            photos INTEGER NOT NULL,
            rule INTEGER NOT NULL
         );",
    );
}

// What moments come from has changed when a photo's revision went up (dates, places, files moved, new photos)
// or a photo is gone. A caption also moves the revision: making them again then finds the same and writes nothing.
fn mark(conn: &Connection) -> Result<(i64, i64), String> {
    let revision: i64 = conn.query_row("SELECT n FROM revision", [], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or(0);
    let photos: i64 = conn.query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok((revision, photos))
}

// The photos with what moments come from. `path` is the column holding the file's path or name (current_path
// in a library, rel_path in an extract).
fn load_from(conn: &Connection, path: &str) -> Result<Vec<MomentPhoto>, String> {
    let mut people: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT hash, person_name FROM photo_people WHERE person_name IS NOT NULL").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
        for row in rows {
            let (hash, name) = row.map_err(|e| e.to_string())?;
            people.entry(hash).or_default().push(name);
        }
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT p.hash, COALESCE(p.{path}, ''), COALESCE(p.captured_at, ''), COALESCE(p.location, ''),
                    p.latitude, p.longitude, COALESCE(p.camera_model, ''),
                    EXISTS (SELECT 1 FROM photo_tags t WHERE t.hash = p.hash AND t.tag IN ('whatsapp', 'screenshot')),
                    COALESCE(p.ai_caption, '')
             FROM photos p"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let path: String = r.get(1)?;
            let hash: String = r.get(0)?;
            Ok(MomentPhoto {
                people: people.remove(&hash).unwrap_or_default(),
                hash,
                name: path.rsplit(['/', '\\']).next().unwrap_or_default().to_string(),
                captured_at: r.get(2)?,
                location: r.get(3)?,
                latitude: r.get(4)?,
                longitude: r.get(5)?,
                camera_model: r.get(6)?,
                received: r.get(7)?,
                caption: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn load(conn: &Connection) -> Result<Vec<MomentPhoto>, String> {
    load_from(conn, "current_path")
}

struct Stored {
    id: String,
    made: Made,
}

// A moment made again keeps its id when most of its photos are the same (or it holds most of an old one's), so a
// name given to it stays. A new one is named after its first photo, as trips were in the frontend: names given
// to those carry over.
fn keep_ids(made: Vec<Made>, old_of: &HashMap<String, String>, old_size: &HashMap<String, usize>) -> Vec<Stored> {
    let mut order: Vec<usize> = (0..made.len()).collect();
    order.sort_by(|a, b| made[*b].hashes.len().cmp(&made[*a].hashes.len()).then(a.cmp(b)));
    let mut ids: Vec<Option<String>> = vec![None; made.len()];
    let mut taken: HashSet<String> = HashSet::new();
    for &i in &order {
        let mut overlap: HashMap<&str, usize> = HashMap::new();
        for h in &made[i].hashes {
            if let Some(old) = old_of.get(h) {
                *overlap.entry(old.as_str()).or_default() += 1;
            }
        }
        let best = overlap
            .iter()
            .filter(|(id, _)| !taken.contains(**id))
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            .filter(|(id, n)| **n * 2 > made[i].hashes.len() || **n * 2 > old_size.get(**id).copied().unwrap_or(usize::MAX));
        let id = match best {
            Some((id, _)) => id.to_string(),
            None => {
                let first = made[i].hashes[0].clone();
                let mut id = first.clone();
                let mut n = 2;
                while taken.contains(&id) {
                    id = format!("{first}-{n}");
                    n += 1;
                }
                id
            }
        };
        taken.insert(id.clone());
        ids[i] = Some(id);
    }
    made.into_iter().zip(ids).map(|(made, id)| Stored { id: id.unwrap(), made }).collect()
}

static MAKING: Mutex<()> = Mutex::new(());

// Makes the moments again when what they come from changed since they were last made. True when they changed.
pub fn refresh(conn: &mut Connection) -> Result<bool, String> {
    refresh_at(conn, now_ms())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn refresh_at(conn: &mut Connection, now: i64) -> Result<bool, String> {
    let _making = MAKING.lock().unwrap_or_else(|e| e.into_inner());
    ensure_tables(conn);
    let (revision, photos) = mark(conn)?;
    let made_at: Option<(i64, i64, i64)> = conn
        .query_row("SELECT revision, photos, rule FROM moments_made WHERE id = 1", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    if made_at == Some((revision, photos, RULE)) {
        return Ok(false);
    }
    let made = compute(&load(conn)?, now);

    let mut old_of: HashMap<String, String> = HashMap::new();
    let mut old_size: HashMap<String, usize> = HashMap::new();
    let mut old_photos: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT moment_id, hash FROM moment_photos").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
        for row in rows {
            let (id, hash) = row.map_err(|e| e.to_string())?;
            *old_size.entry(id.clone()).or_default() += 1;
            old_photos.entry(id.clone()).or_default().push(hash.clone());
            old_of.insert(hash, id);
        }
    }
    let stored = keep_ids(made, &old_of, &old_size);

    // The same moments as before: nothing to write but the mark
    let old_items: HashMap<String, MomentItem> = listed(conn, None)?.into_iter().map(|m| (m.id.clone(), m)).collect();
    let same = stored.len() == old_items.len()
        && stored.iter().all(|s| {
            let mut hashes = s.made.hashes.clone();
            hashes.sort();
            let mut before = old_photos.get(&s.id).cloned().unwrap_or_default();
            before.sort();
            old_items.get(&s.id).is_some_and(|o| *o == item_of(s)) && hashes == before
        });
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if !same {
        tx.execute_batch("DELETE FROM moments; DELETE FROM moment_photos;").map_err(|e| e.to_string())?;
        {
            let mut moment = tx
                .prepare("INSERT INTO moments (id, kind, start_ms, end_ms, place, title, count, cover) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
                .map_err(|e| e.to_string())?;
            let mut photo = tx.prepare("INSERT OR IGNORE INTO moment_photos (moment_id, hash) VALUES (?1, ?2)").map_err(|e| e.to_string())?;
            for s in &stored {
                let item = item_of(s);
                let cover = serde_json::to_string(&item.cover).map_err(|e| e.to_string())?;
                moment
                    .execute(params![item.id, item.kind, item.start, item.end, item.place, item.title, item.count as i64, cover])
                    .map_err(|e| e.to_string())?;
                for h in &s.made.hashes {
                    photo.execute(params![s.id, h]).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO moments_made (id, revision, photos, rule) VALUES (1, ?1, ?2, ?3)",
        params![revision, photos, RULE],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(!same)
}

fn item_of(s: &Stored) -> MomentItem {
    MomentItem {
        id: s.id.clone(),
        kind: s.made.kind.as_str().to_string(),
        place: s.made.place.clone(),
        title: s.made.title.clone(),
        start: s.made.start,
        end: s.made.end,
        count: s.made.count,
        cover: cover_of(&s.made.hashes),
    }
}

// The moments with photos in this folder (every library when None), oldest first. A moment only partly in the
// folder counts and shows the photos it has there.
pub fn listed(conn: &Connection, root_folder: Option<&str>) -> Result<Vec<MomentItem>, String> {
    let prefix = make_folder_prefix(root_folder);
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.kind, m.start_ms, m.end_ms, m.place, m.title, m.count, m.cover, COUNT(p.hash),
                    (SELECT COUNT(*) FROM moment_photos x WHERE x.moment_id = m.id)
             FROM moments m
             JOIN moment_photos mp ON mp.moment_id = m.id
             JOIN photos p ON p.hash = mp.hash
             WHERE p.current_path LIKE ?1 ESCAPE '!'
             GROUP BY m.id
             ORDER BY m.start_ms",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&prefix], |r| {
            let cover: String = r.get(7)?;
            let item = MomentItem {
                id: r.get(0)?,
                kind: r.get(1)?,
                start: r.get(2)?,
                end: r.get(3)?,
                place: r.get(4)?,
                title: r.get(5)?,
                count: r.get::<_, i64>(6)? as usize,
                cover: serde_json::from_str(&cover).unwrap_or_default(),
            };
            Ok((item, r.get::<_, i64>(8)?, r.get::<_, i64>(9)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (mut item, here, all) = row.map_err(|e| e.to_string())?;
        if here < all {
            let hashes = photos_of(conn, &item.id, root_folder)?;
            item.count = hashes.len();
            item.cover = cover_of(&hashes);
        }
        out.push(item);
    }
    Ok(out)
}

// A moment's photos in this folder (every library when None), in time order
pub fn photos_of(conn: &Connection, id: &str, root_folder: Option<&str>) -> Result<Vec<String>, String> {
    let prefix = make_folder_prefix(root_folder);
    let mut stmt = conn
        .prepare(
            "SELECT p.hash FROM moment_photos mp JOIN photos p ON p.hash = mp.hash
             WHERE mp.moment_id = ?1 AND p.current_path LIKE ?2 ESCAPE '!'
             ORDER BY p.captured_at, p.hash",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![id, prefix], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

// The moments of a folder, made again first when what they come from changed
pub async fn get_moments(app: SharedHost, root_folder: Option<String>) -> Result<Vec<MomentItem>, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_global_db(&app)?;
        if refresh(&mut conn)? {
            app.emit_value("moments-changed", serde_json::json!({}));
        }
        listed(&conn, root_folder.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn get_moment_photos(app: SharedHost, id: String, root_folder: Option<String>) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || photos_of(&open_global_db(&app)?, &id, root_folder.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

static KEEPING: AtomicBool = AtomicBool::new(false);

// Keeps the moments up to date in the background, so windows hear of a new trip without asking (moments-changed):
// a look every half minute, which costs two small queries when nothing changed
pub fn keep_ready(app: SharedHost) {
    if KEEPING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        let started = std::time::Instant::now();
        match open_global_db(&app).and_then(|mut conn| refresh(&mut conn)) {
            Ok(true) => {
                eprintln!("[moments] made again in {:.1} s", started.elapsed().as_secs_f64());
                app.emit_value("moments-changed", serde_json::json!({}));
            }
            Ok(false) => {}
            Err(e) => eprintln!("[moments] couldn't make the trips and big days: {e}"),
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}

// ISO 3166 codes to English names, as the frontend's Intl.DisplayNames gave them
const COUNTRIES: &[(&str, &str)] = &[
    ("AC", "Ascension Island"),
    ("AD", "Andorra"),
    ("AE", "United Arab Emirates"),
    ("AF", "Afghanistan"),
    ("AG", "Antigua & Barbuda"),
    ("AI", "Anguilla"),
    ("AL", "Albania"),
    ("AM", "Armenia"),
    ("AN", "Curaçao"),
    ("AO", "Angola"),
    ("AQ", "Antarctica"),
    ("AR", "Argentina"),
    ("AS", "American Samoa"),
    ("AT", "Austria"),
    ("AU", "Australia"),
    ("AW", "Aruba"),
    ("AX", "Åland Islands"),
    ("AZ", "Azerbaijan"),
    ("BA", "Bosnia & Herzegovina"),
    ("BB", "Barbados"),
    ("BD", "Bangladesh"),
    ("BE", "Belgium"),
    ("BF", "Burkina Faso"),
    ("BG", "Bulgaria"),
    ("BH", "Bahrain"),
    ("BI", "Burundi"),
    ("BJ", "Benin"),
    ("BL", "St. Barthélemy"),
    ("BM", "Bermuda"),
    ("BN", "Brunei"),
    ("BO", "Bolivia"),
    ("BQ", "Caribbean Netherlands"),
    ("BR", "Brazil"),
    ("BS", "Bahamas"),
    ("BT", "Bhutan"),
    ("BU", "Myanmar (Burma)"),
    ("BV", "Bouvet Island"),
    ("BW", "Botswana"),
    ("BY", "Belarus"),
    ("BZ", "Belize"),
    ("CA", "Canada"),
    ("CC", "Cocos (Keeling) Islands"),
    ("CD", "Congo - Kinshasa"),
    ("CF", "Central African Republic"),
    ("CG", "Congo - Brazzaville"),
    ("CH", "Switzerland"),
    ("CI", "Côte d’Ivoire"),
    ("CK", "Cook Islands"),
    ("CL", "Chile"),
    ("CM", "Cameroon"),
    ("CN", "China"),
    ("CO", "Colombia"),
    ("CP", "Clipperton Island"),
    ("CQ", "Sark"),
    ("CR", "Costa Rica"),
    ("CS", "Serbia"),
    ("CU", "Cuba"),
    ("CV", "Cape Verde"),
    ("CW", "Curaçao"),
    ("CX", "Christmas Island"),
    ("CY", "Cyprus"),
    ("CZ", "Czechia"),
    ("DD", "Germany"),
    ("DE", "Germany"),
    ("DG", "Diego Garcia"),
    ("DJ", "Djibouti"),
    ("DK", "Denmark"),
    ("DM", "Dominica"),
    ("DO", "Dominican Republic"),
    ("DY", "Benin"),
    ("DZ", "Algeria"),
    ("EA", "Ceuta & Melilla"),
    ("EC", "Ecuador"),
    ("EE", "Estonia"),
    ("EG", "Egypt"),
    ("EH", "Western Sahara"),
    ("ER", "Eritrea"),
    ("ES", "Spain"),
    ("ET", "Ethiopia"),
    ("EU", "European Union"),
    ("EZ", "Eurozone"),
    ("FI", "Finland"),
    ("FJ", "Fiji"),
    ("FK", "Falkland Islands"),
    ("FM", "Micronesia"),
    ("FO", "Faroe Islands"),
    ("FR", "France"),
    ("FX", "France"),
    ("GA", "Gabon"),
    ("GB", "United Kingdom"),
    ("GD", "Grenada"),
    ("GE", "Georgia"),
    ("GF", "French Guiana"),
    ("GG", "Guernsey"),
    ("GH", "Ghana"),
    ("GI", "Gibraltar"),
    ("GL", "Greenland"),
    ("GM", "Gambia"),
    ("GN", "Guinea"),
    ("GP", "Guadeloupe"),
    ("GQ", "Equatorial Guinea"),
    ("GR", "Greece"),
    ("GS", "South Georgia & South Sandwich Islands"),
    ("GT", "Guatemala"),
    ("GU", "Guam"),
    ("GW", "Guinea-Bissau"),
    ("GY", "Guyana"),
    ("HK", "Hong Kong SAR China"),
    ("HM", "Heard & McDonald Islands"),
    ("HN", "Honduras"),
    ("HR", "Croatia"),
    ("HT", "Haiti"),
    ("HU", "Hungary"),
    ("HV", "Burkina Faso"),
    ("IC", "Canary Islands"),
    ("ID", "Indonesia"),
    ("IE", "Ireland"),
    ("IL", "Israel"),
    ("IM", "Isle of Man"),
    ("IN", "India"),
    ("IO", "British Indian Ocean Territory"),
    ("IQ", "Iraq"),
    ("IR", "Iran"),
    ("IS", "Iceland"),
    ("IT", "Italy"),
    ("JE", "Jersey"),
    ("JM", "Jamaica"),
    ("JO", "Jordan"),
    ("JP", "Japan"),
    ("KE", "Kenya"),
    ("KG", "Kyrgyzstan"),
    ("KH", "Cambodia"),
    ("KI", "Kiribati"),
    ("KM", "Comoros"),
    ("KN", "St. Kitts & Nevis"),
    ("KP", "North Korea"),
    ("KR", "South Korea"),
    ("KW", "Kuwait"),
    ("KY", "Cayman Islands"),
    ("KZ", "Kazakhstan"),
    ("LA", "Laos"),
    ("LB", "Lebanon"),
    ("LC", "St. Lucia"),
    ("LI", "Liechtenstein"),
    ("LK", "Sri Lanka"),
    ("LR", "Liberia"),
    ("LS", "Lesotho"),
    ("LT", "Lithuania"),
    ("LU", "Luxembourg"),
    ("LV", "Latvia"),
    ("LY", "Libya"),
    ("MA", "Morocco"),
    ("MC", "Monaco"),
    ("MD", "Moldova"),
    ("ME", "Montenegro"),
    ("MF", "St. Martin"),
    ("MG", "Madagascar"),
    ("MH", "Marshall Islands"),
    ("MK", "North Macedonia"),
    ("ML", "Mali"),
    ("MM", "Myanmar (Burma)"),
    ("MN", "Mongolia"),
    ("MO", "Macao SAR China"),
    ("MP", "Northern Mariana Islands"),
    ("MQ", "Martinique"),
    ("MR", "Mauritania"),
    ("MS", "Montserrat"),
    ("MT", "Malta"),
    ("MU", "Mauritius"),
    ("MV", "Maldives"),
    ("MW", "Malawi"),
    ("MX", "Mexico"),
    ("MY", "Malaysia"),
    ("MZ", "Mozambique"),
    ("NA", "Namibia"),
    ("NC", "New Caledonia"),
    ("NE", "Niger"),
    ("NF", "Norfolk Island"),
    ("NG", "Nigeria"),
    ("NH", "Vanuatu"),
    ("NI", "Nicaragua"),
    ("NL", "Netherlands"),
    ("NO", "Norway"),
    ("NP", "Nepal"),
    ("NR", "Nauru"),
    ("NU", "Niue"),
    ("NZ", "New Zealand"),
    ("OM", "Oman"),
    ("PA", "Panama"),
    ("PE", "Peru"),
    ("PF", "French Polynesia"),
    ("PG", "Papua New Guinea"),
    ("PH", "Philippines"),
    ("PK", "Pakistan"),
    ("PL", "Poland"),
    ("PM", "St. Pierre & Miquelon"),
    ("PN", "Pitcairn Islands"),
    ("PR", "Puerto Rico"),
    ("PS", "Palestinian Territories"),
    ("PT", "Portugal"),
    ("PW", "Palau"),
    ("PY", "Paraguay"),
    ("QA", "Qatar"),
    ("QO", "Outlying Oceania"),
    ("RE", "Réunion"),
    ("RH", "Zimbabwe"),
    ("RO", "Romania"),
    ("RS", "Serbia"),
    ("RU", "Russia"),
    ("RW", "Rwanda"),
    ("SA", "Saudi Arabia"),
    ("SB", "Solomon Islands"),
    ("SC", "Seychelles"),
    ("SD", "Sudan"),
    ("SE", "Sweden"),
    ("SG", "Singapore"),
    ("SH", "St. Helena"),
    ("SI", "Slovenia"),
    ("SJ", "Svalbard & Jan Mayen"),
    ("SK", "Slovakia"),
    ("SL", "Sierra Leone"),
    ("SM", "San Marino"),
    ("SN", "Senegal"),
    ("SO", "Somalia"),
    ("SR", "Suriname"),
    ("SS", "South Sudan"),
    ("ST", "São Tomé & Príncipe"),
    ("SU", "Russia"),
    ("SV", "El Salvador"),
    ("SX", "Sint Maarten"),
    ("SY", "Syria"),
    ("SZ", "Eswatini"),
    ("TA", "Tristan da Cunha"),
    ("TC", "Turks & Caicos Islands"),
    ("TD", "Chad"),
    ("TF", "French Southern Territories"),
    ("TG", "Togo"),
    ("TH", "Thailand"),
    ("TJ", "Tajikistan"),
    ("TK", "Tokelau"),
    ("TL", "Timor-Leste"),
    ("TM", "Turkmenistan"),
    ("TN", "Tunisia"),
    ("TO", "Tonga"),
    ("TP", "Timor-Leste"),
    ("TR", "Türkiye"),
    ("TT", "Trinidad & Tobago"),
    ("TV", "Tuvalu"),
    ("TW", "Taiwan"),
    ("TZ", "Tanzania"),
    ("UA", "Ukraine"),
    ("UG", "Uganda"),
    ("UK", "United Kingdom"),
    ("UM", "U.S. Outlying Islands"),
    ("UN", "United Nations"),
    ("US", "United States"),
    ("UY", "Uruguay"),
    ("UZ", "Uzbekistan"),
    ("VA", "Vatican City"),
    ("VC", "St. Vincent & Grenadines"),
    ("VD", "Vietnam"),
    ("VE", "Venezuela"),
    ("VG", "British Virgin Islands"),
    ("VI", "U.S. Virgin Islands"),
    ("VN", "Vietnam"),
    ("VU", "Vanuatu"),
    ("WF", "Wallis & Futuna"),
    ("WS", "Samoa"),
    ("XA", "Pseudo-Accents"),
    ("XB", "Pseudo-Bidi"),
    ("XK", "Kosovo"),
    ("YD", "Yemen"),
    ("YE", "Yemen"),
    ("YT", "Mayotte"),
    ("YU", "Serbia"),
    ("ZA", "South Africa"),
    ("ZM", "Zambia"),
    ("ZR", "Congo - Kinshasa"),
    ("ZW", "Zimbabwe"),
];

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: (f64, f64) = (50.93, 4.33); // Meise
    const PARIS: (f64, f64) = (48.86, 2.35);
    const LYON: (f64, f64) = (45.76, 4.84);

    fn now() -> i64 {
        days_from_civil(2026, 11, 17) * 86_400_000
    }

    struct Maker(usize);
    impl Maker {
        fn burst(&mut self, day: &str, hour: u32, count: usize, gps: Option<(f64, f64)>, location: &str) -> Vec<MomentPhoto> {
            (0..count)
                .map(|i| {
                    self.0 += 1;
                    MomentPhoto {
                        hash: format!("p{}", self.0),
                        name: format!("IMG_{}.jpg", self.0),
                        captured_at: if day.is_empty() { String::new() } else { format!("{day} {hour:02}:{i:02}:00") },
                        location: location.to_string(),
                        latitude: gps.map(|g| g.0),
                        longitude: gps.map(|g| g.1),
                        camera_model: "Pixel 7".into(),
                        ..Default::default()
                    }
                })
                .collect()
        }
        fn home_bulk(&mut self) -> Vec<MomentPhoto> {
            self.burst("2024:05:01", 10, 30, Some(HOME), "Meise, BE")
        }
    }

    fn with(mut photos: Vec<MomentPhoto>, f: impl Fn(&mut MomentPhoto)) -> Vec<MomentPhoto> {
        photos.iter_mut().for_each(f);
        photos
    }

    #[test]
    fn time_parsing_and_distance() {
        assert_eq!(time_of("2024:06:15 18:30:00"), Some(days_from_civil(2024, 6, 15) * 86_400_000 + 18 * HOUR + 30 * 60_000));
        assert_eq!(time_of("2024-06-15T18:30"), Some(days_from_civil(2024, 6, 15) * 86_400_000 + 18 * HOUR + 30 * 60_000));
        assert_eq!(time_of(""), None);
        assert_eq!(time_of("1970:01:01 00:00:00"), None);
        assert!((distance_km(HOME, PARIS) - 264.0).abs() < 10.0);
        assert_eq!(civil_from_days(days_from_civil(2023, 12, 31)), (2023, 12, 31));
    }

    #[test]
    fn days_at_home_arent_listed_unless_they_are_big_days() {
        let mut m = Maker(0);
        let photos = [m.home_bulk(), m.burst("2024:05:04", 14, 6, Some(HOME), "Meise, BE"), m.burst("2024:05:10", 12, 55, Some(HOME), "Meise, BE")].concat();
        let made = compute(&photos, now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].kind, Kind::BigDay);
        assert_eq!(made[0].count, 55);
        assert_eq!(made[0].place, "Meise");
    }

    #[test]
    fn days_away_close_together_are_one_trip_named_after_the_place() {
        let mut m = Maker(0);
        let photos = [
            m.home_bulk(),
            m.burst("2024:06:12", 9, 8, Some(PARIS), "Paris, FR"),
            m.burst("2024:06:13", 9, 8, Some(PARIS), "Paris, FR"),
            m.burst("2024:06:15", 9, 8, Some(PARIS), "Versailles, FR"),
            m.burst("2024:06:20", 9, 8, Some(HOME), "Meise, BE"),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].kind, Kind::Trip);
        assert_eq!(made[0].count, 24);
        assert_eq!(made[0].place, "Paris & Versailles");
    }

    #[test]
    fn a_day_without_gps_between_two_days_away_belongs_to_the_trip() {
        let mut m = Maker(0);
        let photos = [
            m.home_bulk(),
            m.burst("2024:06:12", 9, 8, Some(PARIS), "Paris, FR"),
            // A camera without GPS on the same journey
            with(m.burst("2024:06:13", 9, 7, None, ""), |p| p.camera_model = "Canon EOS 250D".into()),
            m.burst("2024:06:14", 9, 8, Some(PARIS), "Paris, FR"),
            // after the last day away, and no day away follows: not the trip's (and too small for a big day)
            m.burst("2024:06:15", 9, 6, None, ""),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].count, 23);
    }

    #[test]
    fn whatsapp_photos_and_screenshots_make_no_trip_and_join_none() {
        let mut m = Maker(0);
        let received = |p: &mut MomentPhoto| p.received = true;
        let photos = [
            m.home_bulk(),
            with(m.burst("2024:07:01", 9, 10, None, ""), received),
            m.burst("2024:07:02", 9, 6, Some(PARIS), "Paris, FR"),
            with(m.burst("2024:07:02", 15, 5, None, ""), received),
            with(m.burst("2024:08:01", 9, 60, Some(LYON), "Lyon, FR"), received),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].count, 6);
    }

    #[test]
    fn a_copy_of_a_photo_in_another_library_counts_once() {
        let mut m = Maker(0);
        let day = m.burst("2024:06:12", 9, 6, Some(PARIS), "Paris, FR");
        let copies = with(day.clone(), |p| p.hash = format!("{}-copy", p.hash));
        let made = compute(&[m.home_bulk(), day, copies].concat(), now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].count, 6);
        assert_eq!(made[0].hashes.len(), 12);
    }

    #[test]
    fn a_journey_through_many_places_is_named_after_its_country() {
        let mut m = Maker(0);
        let photos = [
            m.home_bulk(),
            m.burst("2024:06:12", 9, 6, Some(PARIS), "Paris, FR"),
            m.burst("2024:06:13", 9, 6, Some(PARIS), "Versailles, FR"),
            m.burst("2024:06:14", 9, 6, Some(LYON), "Lyon, FR"),
            m.burst("2024:06:15", 9, 6, Some(LYON), "Annecy, FR"),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].place, "France");
    }

    #[test]
    fn received_and_downloaded_images_make_no_trip_and_join_none() {
        let mut m = Maker(0);
        let no_camera = |p: &mut MomentPhoto| p.camera_model = String::new();
        let photos = [
            m.home_bulk(),
            with(m.burst("2024:04:30", 9, 60, None, ""), no_camera),
            m.burst("2024:06:12", 9, 6, Some(PARIS), "Paris, FR"),
            with(m.burst("2024:06:12", 15, 9, None, ""), no_camera),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].count, 6);
    }

    #[test]
    fn a_day_that_starts_at_home_and_ends_away_is_split_at_the_line_around_home() {
        let mut m = Maker(0);
        let near = (50.95, 4.36);
        let photos = [m.home_bulk(), m.burst("2024:08:29", 8, 20, Some(near), "Meise, BE"), m.burst("2024:08:29", 12, 6, Some(PARIS), "Paris, FR")].concat();
        let made = compute(&photos, now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].count, 6);
        assert_eq!(made[0].place, "Paris");
    }

    #[test]
    fn a_100_km_jump_splits_a_day_only_the_part_away_is_a_trip() {
        let mut m = Maker(0);
        let photos = [m.home_bulk(), m.burst("2024:07:01", 8, 6, Some(HOME), ""), m.burst("2024:07:01", 9, 6, Some(PARIS), "")].concat();
        let made = compute(&photos, now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].count, 6);
    }

    #[test]
    fn photos_without_a_date_an_unset_clock_or_a_date_to_come_make_no_trip() {
        let mut m = Maker(0);
        let photos = [
            m.home_bulk(),
            m.burst("", 0, 10, Some(PARIS), ""),
            m.burst("2000:01:01", 0, 60, None, ""),
            m.burst("2027:03:01", 9, 8, Some(PARIS), "Paris, FR"),
        ]
        .concat();
        assert!(compute(&photos, now()).is_empty());
    }

    fn captioned(photos: Vec<MomentPhoto>, caption: &str) -> Vec<MomentPhoto> {
        with(photos, |p| p.caption = caption.to_string())
    }

    fn people(photos: Vec<MomentPhoto>, names: &[&str]) -> Vec<MomentPhoto> {
        with(photos, |p| p.people = names.iter().map(|n| n.to_string()).collect())
    }

    // A household of two in many photos at home, and a dog the captions name
    fn household(m: &mut Maker) -> Vec<MomentPhoto> {
        [
            people(captioned(m.burst("2024:01:05", 10, 50, Some(HOME), "Meise, BE"), "Two people on a sofa."), &["Ann", "Bert"]),
            people(captioned(m.burst("2024:01:06", 10, 50, Some(HOME), "Meise, BE"), "Two people at a table."), &["Ann", "Bert"]),
            people(captioned(m.burst("2024:01:07", 10, 50, Some(HOME), "Meise, BE"), "Two people in a kitchen."), &["Ann", "Bert"]),
            people(captioned(m.burst("2024:01:08", 10, 50, Some(HOME), "Meise, BE"), "Two people on a bench."), &["Ann", "Bert"]),
            people(captioned(m.burst("2024:01:09", 10, 50, Some(HOME), "Meise, BE"), "Two people by a fire."), &["Ann", "Bert"]),
            people(captioned(m.burst("2024:01:12", 10, 20, Some(HOME), "Meise, BE"), "A dog asleep on a rug."), &["Rex"]),
        ]
        .concat()
    }

    fn titles(made: &[Made]) -> Vec<String> {
        made.iter().map(|m| m.title.clone()).collect()
    }

    #[test]
    fn a_pet_names_trips_and_days_and_an_ordinary_day_isnt_a_big_day() {
        let mut m = Maker(0);
        let photos = [
            household(&mut m),
            // Many photos of an ordinary day: no occasion, no guests, nothing done
            people(captioned(m.burst("2024:03:02", 9, 60, Some(HOME), "Meise, BE"), "A woman reading by a window."), &["Ann"]),
            // The dog's face isn't found, but the captions say a dog on a beach
            captioned(m.burst("2024:06:15", 9, 30, Some((51.14, 2.70)), "Koksijde, BE"), "A dog running on the beach."),
            captioned(m.burst("2024:09:08", 9, 60, Some(HOME), "Meise, BE"), "A dog walking on a forest trail."),
        ]
        .concat();
        assert_eq!(titles(&compute(&photos, now())), ["Beach trip with Rex", "Walk with Rex"]);
    }

    #[test]
    fn a_birthday_in_the_captions_makes_a_small_day_a_big_day() {
        let mut m = Maker(0);
        let photos = [
            household(&mut m),
            captioned(m.burst("2024:04:20", 15, 12, Some(HOME), "Meise, BE"), "A cake with candles on a table."),
            // A Christmas tree after the holidays is no Christmas
            captioned(m.burst("2025:01:03", 15, 14, Some(HOME), "Meise, BE"), "A Christmas tree in a living room."),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(titles(&made), ["Birthday"]);
        assert_eq!(made[0].count, 12);
    }

    #[test]
    fn guests_make_a_visit_or_a_gathering_and_days_in_a_row_are_one() {
        let mut m = Maker(0);
        let mut gathering = Vec::new();
        for (i, name) in ["Cas", "Dirk", "Eva", "Fien", "Gust"].iter().enumerate() {
            gathering.push(people(captioned(m.burst("2024:08:25", 10 + i as u32, 12, Some(HOME), "Meise, BE"), "People at a garden table."), &[name]));
        }
        let photos = [
            household(&mut m),
            people(captioned(m.burst("2024:05:02", 10, 30, Some(HOME), "Meise, BE"), "An older couple holding a baby."), &["John", "Sabine"]),
            captioned(m.burst("2024:05:02", 14, 30, Some(HOME), "Meise, BE"), "Balloons in a living room."),
            people(captioned(m.burst("2024:05:03", 10, 50, Some(HOME), "Meise, BE"), "An older couple in a garden."), &["John", "Sabine"]),
            gathering.concat(),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(titles(&made), ["Visit from John & Sabine", "Family gathering"]);
        assert_eq!(made[0].count, 110);
    }

    #[test]
    fn a_hospital_stay_starts_with_a_birth_and_ends_with_a_homecoming() {
        let mut m = Maker(0);
        let mut stay = Vec::new();
        for day in ["2024:03:19", "2024:03:20"] {
            stay.push(people(captioned(m.burst(day, 10, 30, Some(HOME), "Kraainem, BE"), "A newborn in a hospital cot."), &["Zoe", "Ann"]));
        }
        for day in ["2024:03:24", "2024:03:28", "2024:04:03", "2024:04:10"] {
            stay.push(captioned(m.burst(day, 10, 15, Some(HOME), "Kraainem, BE"), "A baby asleep in a hospital room."));
        }
        let photos = [
            household(&mut m),
            // The baby in many photos from then on: part of the household
            people(captioned(m.burst("2024:05:20", 10, 50, Some(HOME), "Meise, BE"), "A baby in a crib."), &["Zoe"]),
            people(captioned(m.burst("2024:05:21", 10, 50, Some(HOME), "Meise, BE"), "A baby on a play mat."), &["Zoe"]),
            stay.concat(),
            captioned(m.burst("2024:04:11", 12, 40, Some(HOME), "Meise, BE"), "A baby in a car seat at a front door."),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(titles(&made), ["Birth of Zoe", "Hospital stay", "Homecoming of Zoe"]);
        assert_eq!(made[0].count, 60);
        assert_eq!(made[1].count, 60);
        assert_eq!(made[1].place, "Kraainem");
    }

    #[test]
    fn a_journey_abroad_split_by_a_few_days_is_one_trip() {
        let mut m = Maker(0);
        let photos = [
            household(&mut m),
            m.burst("2024:07:30", 9, 20, Some(PARIS), "Paris, FR"),
            m.burst("2024:08:02", 9, 20, Some(LYON), "Lyon, FR"),
            m.burst("2024:08:03", 9, 20, Some(LYON), "Lyon, FR"),
            // Home in between, then away again in the same country: still one journey
            m.burst("2024:08:05", 9, 6, Some(HOME), "Meise, BE"),
            m.burst("2024:08:06", 9, 20, Some((46.85, -2.15)), "Barbatre, FR"),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].count, 80);
        assert_eq!(made[0].title, "Lyon & Paris - Summer of 2024");
    }

    #[test]
    fn a_phone_without_its_position_on_a_trip_day_was_at_home() {
        let mut m = Maker(0);
        let other_phone = |p: &mut MomentPhoto| p.camera_model = "iPhone 15".into();
        let photos = [
            household(&mut m),
            // The other phone records its position in most photos
            with(m.burst("2024:02:01", 9, 30, Some(HOME), "Meise, BE"), other_phone),
            m.burst("2024:06:12", 9, 8, Some(PARIS), "Paris, FR"),
            with(m.burst("2024:06:12", 18, 3, None, ""), other_phone),
            m.burst("2024:06:13", 9, 8, Some(PARIS), "Paris, FR"),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].count, 16);
        assert_eq!(made[0].title, "", "12-13 Jun 2024 is a Wednesday and Thursday: no weekend, no day trip");
    }

    #[test]
    fn a_day_out_in_another_town_is_a_day_trip_and_trips_dont_name_guests() {
        let mut m = Maker(0);
        let near = (51.10, 3.88); // Lochristi, 40 km away
        let photos = [
            household(&mut m),
            people(captioned(m.burst("2025:09:21", 10, 54, Some(near), "Lochristi, BE"), "A woman in a flower garden."), &["Annie"]),
            people(m.burst("2021:06:19", 10, 20, Some((50.16, 5.22)), "Rochefort, BE"), &["Michiel", "Wim"]),
            m.burst("2022:10:29", 10, 20, Some((45.81, 15.98)), "Zagreb - Centar, HR"),
            m.burst("2022:10:30", 10, 20, Some((45.81, 15.98)), "Zagreb, HR"),
        ]
        .concat();
        let made = compute(&photos, now());
        assert_eq!(titles(&made), ["Day trip to Rochefort", "Weekend in Zagreb", "Day trip to Lochristi"]);
        assert_eq!(made[2].kind, Kind::Trip);
    }

    // Diagnostic: the moments of a real library's extract (LUMINA_MOMENTS_DB: photos with rel_path, photo_tags),
    // one line each, to compare with the frontend's rule over the same photos
    #[test]
    #[ignore]
    fn moments_of_an_extract() {
        let path = std::env::var("LUMINA_MOMENTS_DB").expect("LUMINA_MOMENTS_DB");
        let conn = Connection::open(path).unwrap();
        let photos = load_from(&conn, "rel_path").unwrap();
        let started = std::time::Instant::now();
        let made = compute(&photos, now_ms());
        eprintln!("{} photos, {} moments in {:?}", photos.len(), made.len(), started.elapsed());
        for m in &made {
            println!("{}|{}|{}|{}|{}|{}|{}|{}", m.hashes[0], m.kind.as_str(), m.start, m.end, m.count, m.place, m.title, m.hashes.join(","));
        }
    }

    // The stored moments: made once, the same when nothing changed, ids kept when a photo joins
    #[test]
    fn moments_are_stored_and_keep_their_ids() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE photos (hash TEXT PRIMARY KEY, current_path TEXT, captured_at TEXT, location TEXT, latitude REAL,
                                  longitude REAL, camera_model TEXT, ai_caption TEXT);
             CREATE TABLE photo_tags (hash TEXT, tag TEXT);
             CREATE TABLE photo_people (hash TEXT, person_name TEXT);
             CREATE TABLE revision (id INTEGER PRIMARY KEY, n INTEGER); INSERT INTO revision VALUES (1, 1);",
        )
        .unwrap();
        let root = if cfg!(windows) { "C:\\Lib" } else { "/lib" };
        let sep = std::path::MAIN_SEPARATOR;
        let insert = |conn: &Connection, photos: &[MomentPhoto]| {
            for p in photos {
                conn.execute(
                    "INSERT INTO photos VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![p.hash, format!("{root}{sep}{}", p.name), p.captured_at, p.location, p.latitude, p.longitude, p.camera_model, p.caption],
                )
                .unwrap();
            }
            conn.execute("UPDATE revision SET n = n + 1", []).unwrap();
        };
        let mut m = Maker(0);
        insert(&conn, &[m.home_bulk(), m.burst("2024:06:12", 9, 8, Some(PARIS), "Paris, FR")].concat());
        assert!(refresh_at(&mut conn, now()).unwrap());
        let first = listed(&conn, Some(root)).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].id, "p31", "named after its first photo, as the frontend named trips");
        assert_eq!(first[0].cover.len(), 4);
        assert_eq!(photos_of(&conn, &first[0].id, None).unwrap().len(), 8);
        // Nothing changed: nothing made
        assert!(!refresh_at(&mut conn, now()).unwrap());
        // A caption moved the revision: made again, the same, nothing written
        conn.execute("UPDATE revision SET n = n + 1", []).unwrap();
        assert!(!refresh_at(&mut conn, now()).unwrap());
        // An earlier photo of the same morning joins: the trip keeps its id (and a name given to it)
        insert(&conn, &m.burst("2024:06:12", 8, 1, Some(PARIS), "Paris, FR"));
        assert!(refresh_at(&mut conn, now()).unwrap());
        let again = listed(&conn, None).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].id, "p31");
        assert_eq!(again[0].count, 9);
        // Another folder has none of its photos
        assert!(listed(&conn, Some(if cfg!(windows) { "C:\\Other" } else { "/other" })).unwrap().is_empty());
    }
}
