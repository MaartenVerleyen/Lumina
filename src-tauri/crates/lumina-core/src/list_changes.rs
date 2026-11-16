// A library's photo list brought up to date from what a server says differs (lumina-server's listing.rs):
//   {"changed": [{"after": hash or null, "photo": {...}}, ...], "removed": [hash, ...]}
// A changed photo the list has takes the old one's place. One it doesn't have goes after the photo named by
// `after` (null: first). The lists are tens of megabytes, so photos are moved as the text they came in and
// only read for their id.
use serde::Deserialize;
use serde_json::value::RawValue;
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
struct Differences<'a> {
    #[serde(borrow)]
    changed: Vec<Change<'a>>,
    removed: Vec<String>,
}

#[derive(Deserialize)]
struct Change<'a> {
    after: Option<String>,
    #[serde(borrow)]
    photo: &'a RawValue,
}

#[derive(Deserialize)]
struct Id {
    hash: String,
}

fn id(photo: &RawValue) -> Result<String, String> {
    serde_json::from_str::<Id>(photo.get()).map(|id| id.hash).map_err(|e| format!("A photo without an id: {e}"))
}

// The list (a JSON array of photos) with the differences worked in. Err when they don't fit this list: the
// caller then asks for the whole list.
pub fn apply(list: &str, differences: &str) -> Result<String, String> {
    let old: Vec<&RawValue> = serde_json::from_str(list).map_err(|e| format!("The kept list can't be read: {e}"))?;
    let diff: Differences = serde_json::from_str(differences).map_err(|e| format!("The differences can't be read: {e}"))?;
    let ids = old.iter().map(|p| id(p)).collect::<Result<Vec<_>, _>>()?;
    let removed: HashSet<&str> = diff.removed.iter().map(String::as_str).collect();
    let stays: HashSet<&str> = ids.iter().map(String::as_str).filter(|h| !removed.contains(h)).collect();

    let changed_ids = diff.changed.iter().map(|c| id(c.photo)).collect::<Result<Vec<_>, _>>()?;
    let mut replaced: HashMap<&str, &RawValue> = HashMap::new();
    // New photos by the one they come after, in the list's order
    let mut comes_after: ComesAfter = HashMap::new();
    let mut new = 0;
    for (change, hash) in diff.changed.iter().zip(&changed_ids) {
        if stays.contains(hash.as_str()) {
            replaced.insert(hash, change.photo);
        } else {
            comes_after.entry(change.after.as_deref()).or_default().push((hash, change.photo));
            new += 1;
        }
    }

    let mut out = String::with_capacity(list.len() + differences.len());
    out.push('[');
    let mut placed = 0;
    for (hash, photo) in comes_after.remove(&None).unwrap_or_default() {
        placed += write(&mut out, hash, photo, true, &mut comes_after);
    }
    for (photo, hash) in old.iter().zip(&ids) {
        if stays.contains(hash.as_str()) {
            placed += write(&mut out, hash, replaced.get(hash.as_str()).copied().unwrap_or(photo), false, &mut comes_after);
        }
    }
    out.push(']');
    if placed != new {
        return Err("The differences are from another list than the kept one".to_string());
    }
    Ok(out)
}

type ComesAfter<'a> = HashMap<Option<&'a str>, Vec<(&'a str, &'a RawValue)>>;

// Writes a photo and the new ones that come after it (a new photo may come after another new one); says how
// many new ones that were
fn write<'a>(out: &mut String, hash: &'a str, photo: &'a RawValue, is_new: bool, comes_after: &mut ComesAfter<'a>) -> usize {
    let mut placed = 0;
    let mut next = vec![(hash, photo, is_new)];
    while let Some((hash, photo, is_new)) = next.pop() {
        if out.len() > 1 {
            out.push(',');
        }
        out.push_str(photo.get());
        placed += is_new as usize;
        if let Some(following) = comes_after.remove(&Some(hash)) {
            next.extend(following.into_iter().rev().map(|(h, p)| (h, p, true)));
        }
    }
    placed
}

#[cfg(test)]
mod tests {
    use super::apply;

    #[test]
    fn differences_bring_a_list_up_to_date() {
        let list = r#"[{"hash":"a","v":1},{"hash":"b","v":1},{"hash":"c","v":1}]"#;
        assert_eq!(apply(list, r#"{"changed":[],"removed":[]}"#).unwrap(), list);

        // b changed, c went, d came first, e and f after b (f after e)
        let diff = r#"{"changed":[
            {"after":null,"photo":{"hash":"d","v":1}},
            {"after":"a","photo":{"v":2,"hash":"b"}},
            {"after":"b","photo":{"hash":"e","v":1}},
            {"after":"e","photo":{"hash":"f","v":1}}],"removed":["c"]}"#;
        assert_eq!(apply(list, diff).unwrap(), r#"[{"hash":"d","v":1},{"hash":"a","v":1},{"v":2,"hash":"b"},{"hash":"e","v":1},{"hash":"f","v":1}]"#);

        // A photo that went and came back sits where the differences put it
        let diff = r#"{"changed":[{"after":null,"photo":{"hash":"c","v":3}}],"removed":["c"]}"#;
        assert_eq!(apply(list, diff).unwrap(), r#"[{"hash":"c","v":3},{"hash":"a","v":1},{"hash":"b","v":1}]"#);

        // Everything gone, and an empty list filled
        assert_eq!(apply(list, r#"{"changed":[],"removed":["a","b","c"]}"#).unwrap(), "[]");
        assert_eq!(apply("[]", r#"{"changed":[{"after":null,"photo":{"hash":"x"}}],"removed":[]}"#).unwrap(), r#"[{"hash":"x"}]"#);

        // A new photo after one this list doesn't have: not this list's differences
        assert!(apply(list, r#"{"changed":[{"after":"zz","photo":{"hash":"g"}}],"removed":[]}"#).is_err());
        assert!(apply("not json", r#"{"changed":[],"removed":[]}"#).is_err());
    }

    // How long a large library's list takes to bring up to date (run with --release -- --ignored --nocapture)
    #[test]
    #[ignore]
    fn timing_of_a_large_list() {
        let photo = |i: usize, v: usize| format!(r#"{{"ai_caption":"{}","hash":"{i:016x}","rating":{v},"faces":[{{"face_id":"{i:016x}_1","bbox_x":0.5}}],"tags":["a","b"]}}"#, "words ".repeat(220));
        let list = format!("[{}]", (0..50_000).map(|i| photo(i, 0)).collect::<Vec<_>>().join(","));
        let changed: Vec<String> = (0..200).map(|i| format!(r#"{{"after":null,"photo":{}}}"#, photo(i * 250, 1))).collect();
        let diff = format!(r#"{{"changed":[{}],"removed":["{:016x}"]}}"#, changed.join(","), 7);
        let started = std::time::Instant::now();
        let out = apply(&list, &diff).unwrap();
        println!("{:.0} MB list, 200 changed: {:.0} ms", list.len() as f64 / 1e6, started.elapsed().as_secs_f64() * 1000.0);
        assert!(out.len() < list.len());
    }
}
