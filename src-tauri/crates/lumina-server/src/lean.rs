// The lean form of a photo in a library's list, for the phone layout (scan_folder with `lean: true`: the phone
// app, and the web client on a phone; docs/plans/lean-photo-list.md). It leaves out what that layout needs only
// for an opened photo, or not at all (`DETAILS`), which comes per photo through get_photo_details.
//
// Every other field is sent as the full list has it, empty or not: a browser keeps photos that all have the same
// fields far more compactly than photos it has to add fields to (measured on cachy's large library: 73 MB, against
// 134 MB for a list without empty values put back, and 140 MB for the full list), and the phone's code reads them
// as it always has. A photo of the lean list has no `faces` (and no other detail) until they are fetched.
// tests/fixtures/lean-cases.json holds the cases the server and the app are both checked against.
use serde_json::{Map, Value};

// What the phone layout shows only for one photo, or not at all (agreed 18 November): faces, camera and exposure,
// focus, the near-duplicate fingerprint and groups, the desktop's marks (damaged, basket, moves waiting), the
// folder (for "Show in its folder"), a Live Photo's clip file
pub const DETAILS: &[&str] = &[
    "faces",
    "camera_model",
    "lens_model",
    "focal_length",
    "aperture",
    "shutter_speed",
    "iso",
    "sharpness",
    "dhash",
    "duplicate_group",
    "damaged",
    "in_basket",
    "staged_target",
    "subfolder",
    "live_video_path",
];

// What the phone layout reads for every photo: the timeline, the viewer, search (also by rating, flag and colour
// label), people, RAW + JPG shown as one, videos, Live Photos. The lean form keeps whatever isn't a detail; this
// list is what the tests hold every field of a photo against, so a new field is put on one side on purpose.
#[cfg_attr(not(test), allow(dead_code))]
pub const KEPT: &[&str] = &[
    "hash",
    "name",
    "path",
    "thumb_path",
    "size_kb",
    "width",
    "height",
    "thumb_ready",
    "rating",
    "flag",
    "color_label",
    "rotation",
    "tags",
    "people",
    "ai_caption",
    "ocr_text",
    "captured_at",
    "location",
    "latitude",
    "longitude",
    "pair_raw_path",
    "media_type",
    "duration_ms",
    // Whether a video plays as it is or needs the server's converted copy (media.ts)
    "video_codec",
    "live_video_hash",
    "live_photo_hash",
];

// A photo's full JSON object in its lean form. Fields this file doesn't know are kept as they are.
pub fn lean_photo(photo: &Value) -> Value {
    let Some(fields) = photo.as_object() else { return photo.clone() };
    let out: Map<String, Value> = fields.iter().filter(|(key, _)| !DETAILS.contains(&key.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    Value::Object(out)
}

// What get_photo_details answers for one photo: the fields the lean form leaves out
pub fn details_of(photo: &Value) -> Value {
    let mut out = Map::new();
    if let Some(fields) = photo.as_object() {
        for key in DETAILS {
            out.insert(key.to_string(), fields.get(*key).cloned().unwrap_or(Value::Null));
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The cases the app is checked against too
    #[test]
    fn lean_photos_match_the_shared_cases() {
        let cases: Value = serde_json::from_str(include_str!("../../../../tests/fixtures/lean-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(lean_photo(&case["full"]), case["lean"], "{}", case["what"]);
            let details = details_of(&case["full"]);
            assert_eq!(details["faces"], case["full"]["faces"], "{}", case["what"]);
        }
    }

    // Every field a listed photo has is either kept or a detail: a new field must be put in one of the two
    #[test]
    fn every_field_of_a_photo_is_known() {
        let photo = serde_json::to_value(lumina_core::types::PhotoItem::default()).unwrap();
        let keys: Vec<&String> = photo.as_object().unwrap().keys().collect();
        for key in &keys {
            assert!(DETAILS.contains(&key.as_str()) != KEPT.contains(&key.as_str()), "{key}: in lean.rs's KEPT or DETAILS, once");
        }
        assert_eq!(keys.len(), DETAILS.len() + KEPT.len());
    }
}
