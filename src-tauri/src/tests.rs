use crate::ai::parse_resilient_ai_json;
use crate::*;
use image::{GrayImage, Luma};

// ----------------- EXIF DATE NORMALIZATION -----------------

#[test]
fn normalize_date_converts_exif_colons_and_strips_quotes() {
    assert_eq!(normalize_date_str("2023:05:12 14:03:22"), "2023-05-12 14:03:22");
    assert_eq!(normalize_date_str("\"2023:05:12 14:03:22\""), "2023-05-12 14:03:22");
}

#[test]
fn normalize_date_without_time_defaults_to_midnight() {
    assert_eq!(normalize_date_str("2023:05:12"), "2023-05-12 00:00:00");
}

#[test]
fn normalize_date_rejects_garbage() {
    assert_eq!(normalize_date_str(""), "");
    assert_eq!(normalize_date_str("not a date at all"), "");
}

// ----------------- CLOCK SHIFT -----------------

#[test]
fn shift_rolls_into_leap_day() {
    assert_eq!(
        shift_exif_datetime_str("2024-02-28 23:30:00", 60).as_deref(),
        Some("2024-02-29 00:30:00")
    );
}

#[test]
fn shift_rolls_over_year_end() {
    assert_eq!(
        shift_exif_datetime_str("2023-12-31 23:00:00", 120).as_deref(),
        Some("2024-01-01 01:00:00")
    );
}

#[test]
fn shift_backwards_across_month_start() {
    assert_eq!(
        shift_exif_datetime_str("2024-03-01 00:10:00", -20).as_deref(),
        Some("2024-02-29 23:50:00")
    );
}

#[test]
fn shift_preserves_seconds_and_rejects_short_input() {
    assert_eq!(
        shift_exif_datetime_str("2023-06-15 08:00:45", 90).as_deref(),
        Some("2023-06-15 09:30:45")
    );
    assert_eq!(shift_exif_datetime_str("2023-06-15", 60), None);
}

// ----------------- AI JSON REPAIR -----------------

#[test]
fn ai_json_parses_plain_object() {
    let res = parse_resilient_ai_json(
        r#"{"caption": "A dog on grass", "objects": ["dog", "grass"], "scene": "outdoor", "is_screenshot": false, "ocr_text": ""}"#,
    )
    .unwrap();
    assert_eq!(res.caption, "A dog on grass");
    assert_eq!(res.objects, vec!["dog", "grass"]);
    assert_eq!(res.scene, "outdoor");
    assert!(!res.is_screenshot);
}

#[test]
fn ai_json_strips_think_block_and_code_fence() {
    let raw = "<think>\nreasoning\n</think>\n```json\n{\"caption\": \"A cat\", \"objects\": [\"cat\"]}\n```";
    let res = parse_resilient_ai_json(raw).unwrap();
    assert_eq!(res.caption, "A cat");
    assert_eq!(res.objects, vec!["cat"]);
}

#[test]
fn ai_json_repairs_truncated_array() {
    let res = parse_resilient_ai_json(r#"{"caption": "A dog", "objects": ["dog", "grass""#).unwrap();
    assert_eq!(res.caption, "A dog");
    assert_eq!(res.objects, vec!["dog", "grass"]);
}

#[test]
fn ai_json_repairs_truncated_string() {
    let res = parse_resilient_ai_json(r#"{"caption": "A dog on gr"#).unwrap();
    assert_eq!(res.caption, "A dog on gr");
}

#[test]
fn ai_json_accepts_alternate_keys() {
    let res = parse_resilient_ai_json(r#"{"description": "Sunset", "tags": "sky, sun; sea"}"#).unwrap();
    assert_eq!(res.caption, "Sunset");
    assert_eq!(res.objects, vec!["sky", "sun", "sea"]);
}

#[test]
fn ai_json_rejects_empty_result() {
    assert!(parse_resilient_ai_json("{}").is_err());
    assert!(parse_resilient_ai_json("no json here").is_err());
}

// ----------------- DHASH -----------------

fn gradient(width: u32, height: u32, f: impl Fn(u32, u32) -> u8) -> DynamicImage {
    DynamicImage::ImageLuma8(GrayImage::from_fn(width, height, |x, y| Luma([f(x, y)])))
}

#[test]
fn dhash_is_16_hex_chars_and_zero_for_flat_image() {
    let flat = gradient(64, 64, |_, _| 128);
    let h = compute_dhash(&flat);
    assert_eq!(h.len(), 16);
    assert_eq!(h, "0000000000000000");
}

#[test]
fn dhash_sets_horizontal_bits_for_left_bright_image() {
    // Brighter on the left: every horizontal comparison (left > right) is true, vertical ones are equal.
    let img = gradient(90, 90, |x, _| 255 - (x * 2) as u8);
    assert_eq!(compute_dhash(&img), "00000000ffffffff");
}

#[test]
fn dhash_is_stable_across_scale() {
    let big = gradient(400, 300, |x, y| ((x * 7 + y * 3) % 256) as u8);
    let small = big.resize_exact(200, 150, FilterType::Triangle);
    let a = u64::from_str_radix(&compute_dhash(&big), 16).unwrap();
    let b = u64::from_str_radix(&compute_dhash(&small), 16).unwrap();
    assert!((a ^ b).count_ones() <= 8, "dHash drifted too far across a 2x downscale");
}

// ----------------- FOLDER SCOPE (documents current behaviour; Phase 1 fixes it) -----------------

#[test]
fn folder_prefix_current_behaviour() {
    assert_eq!(make_folder_prefix(None), "%");
    assert_eq!(make_folder_prefix(Some("  ")), "%");
    // Known bug (Phase 1, item 1): no trailing separator, so this also matches C:\Photos2\...
    assert_eq!(make_folder_prefix(Some(r"C:\Photos")), r"C:\Photos%");
}
