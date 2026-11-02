use crate::ai::parse_resilient_ai_json;
use crate::*;
use crate::face_scan::carry_over_rejections;
use image::{GrayImage, Luma};
use std::io::{Seek, SeekFrom};

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

#[test]
fn file_names_with_a_date_and_time() {
    let dt = |n: &str| date_from_filename(n).and_then(|d| d.1);
    assert_eq!(dt("IMG_20230615_183000.jpg").as_deref(), Some("2023-06-15 18:30:00"));
    assert_eq!(dt("PXL_20230615_183000123.jpg").as_deref(), Some("2023-06-15 18:30:00"));
    assert_eq!(dt("Screenshot_2023-06-15-18-30-00.png").as_deref(), Some("2023-06-15 18:30:00"));
    assert_eq!(dt("2023-06-15 18.30.00.jpg").as_deref(), Some("2023-06-15 18:30:00"));
    assert_eq!(dt("20230615183000.jpg").as_deref(), Some("2023-06-15 18:30:00"));
}

#[test]
fn file_names_with_only_a_date() {
    assert_eq!(date_from_filename("IMG-20230615-WA0001.jpg"), Some(("2023-06-15".into(), None)));
    assert_eq!(date_from_filename("Holiday 2023-06-15.jpg"), Some(("2023-06-15".into(), None)));
}

#[test]
fn copied_photo_without_exif_gets_its_modification_time() {
    // A copy is created now but keeps the original's modification time (2020-06-15 12:00 UTC)
    let dir = std::env::temp_dir().join(format!("lumina-date-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pasted.jpg");
    let file = std::fs::File::create(&path).unwrap();
    file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_592_222_400)).unwrap();
    drop(file);
    let meta = std::fs::metadata(&path).unwrap();
    let date = fallback_photo_date(&path, Some(&meta));
    // Local time: 12:00 UTC is still 15 June in every time zone between UTC-12 and UTC+11
    assert!(date.starts_with("2020-06-15 "), "{date}");
    let old = format_system_time_iso(meta.created().unwrap());
    assert!(is_old_creation_time_date(&path, &old, &meta));
    assert!(!is_old_creation_time_date(&path, &date, &meta));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn near_duplicates_need_a_close_fingerprint_and_agreeing_clip_vectors() {
    use crate::scan::{group_near_duplicates, DupCandidate};
    let unit = |angle: f32| vec![angle.cos(), angle.sin()];
    let (same_scene, also_same, other_scene) = (unit(0.0), unit(0.3), unit(1.2));
    fn item(dhash: u64, clip: Option<&Vec<f32>>) -> DupCandidate<'_> {
        DupCandidate { dhash: Some(dhash), loose: false, clip: clip.map(|v| v.as_slice()) }
    }
    let groups = group_near_duplicates(&[
        item(0xff00, Some(&same_scene)),
        // 2 bits apart and CLIP agrees (cos 0.3 = 0.955): same group
        item(0xff03, Some(&also_same)),
        // 2 bits apart, but CLIP sees another scene (cos 1.2 = 0.36): not grouped
        item(0xff0c, Some(&other_scene)),
        // Without a CLIP vector the fingerprint decides
        item(0xff30, None),
        // Fingerprint too far (16 bits)
        item(0x00ff, Some(&same_scene)),
    ]);
    assert_eq!(groups, vec![Some(1), Some(1), None, Some(1), None]);

    // Saved images (no camera) 10 bits apart: grouped only when CLIP confirms
    fn loose(dhash: u64, clip: Option<&Vec<f32>>) -> DupCandidate<'_> {
        DupCandidate { loose: true, ..item(dhash, clip) }
    }
    let confirmed = group_near_duplicates(&[loose(0, Some(&same_scene)), loose(0x3ff, Some(&also_same))]);
    assert_eq!(confirmed, vec![Some(1), Some(1)]);
    let unconfirmed = group_near_duplicates(&[loose(0, None), loose(0x3ff, None)]);
    assert_eq!(unconfirmed, vec![None, None]);
}

#[test]
fn file_names_without_a_date() {
    for name in ["DSC01234.jpg", "1698412345678.jpg", "IMG_1234.HEIC", "photo 2023.jpg", "20231399.jpg", "2023-06_15.jpg"] {
        assert_eq!(date_from_filename(name), None, "{name}");
    }
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
fn ai_json_v2_derives_screenshot_from_scene() {
    let res = parse_resilient_ai_json(
        r#"{"caption": "A settings screen", "objects": ["phone", "menu"], "scene": "screenshot", "ocr_text": "Wi-Fi"}"#,
    )
    .unwrap();
    assert!(res.is_screenshot);
    let res = parse_resilient_ai_json(r#"{"caption": "A dog", "objects": ["dog"], "scene": "outdoor", "ocr_text": ""}"#).unwrap();
    assert!(!res.is_screenshot);
}

#[test]
fn ocr_that_repeats_the_caption_is_detected() {
    use crate::ai::ocr_repeats_caption;
    // Real outputs from the 2026-10-25 benchmark: the model "transcribed" the caption on photos without text
    let caption = "A baby in a brown patterned outfit sits in a high chair, holding a partially eaten slice of bread.";
    assert!(ocr_repeats_caption("A baby in a brown patterned outfit sits in a high chair, holding a partially eaten slice", caption));
    assert!(ocr_repeats_caption("Children observe sheep and geese in a sunny field.", "Children observe sheep and geese in a sunny field. Trees frame it."));
    // Genuine text stays
    assert!(!ocr_repeats_caption("HYUNDAI Run to progress OLIVERO 3152", "Two men pose with large letters at a Hyundai event."));
    assert!(!ocr_repeats_caption("", caption));
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

// ----------------- IDENTICAL-COPY HASH COLLISIONS -----------------

fn collision_db(rows: &[(&str, &str)]) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute("CREATE TABLE photos (hash TEXT PRIMARY KEY, current_path TEXT)", []).unwrap();
    for (h, p) in rows {
        conn.execute("INSERT INTO photos VALUES (?1, ?2)", params![h, p]).unwrap();
    }
    conn
}

fn temp_file(name: &str) -> String {
    let dir = std::env::temp_dir().join("lumina_collision_tests");
    fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    fs::write(&p, b"x").unwrap();
    p.to_string_lossy().to_string()
}

#[test]
fn copy_of_existing_photo_gets_its_own_hash() {
    let original = temp_file("original.jpg");
    let conn = collision_db(&[("abc", &original)]);
    let copy = r"D:\Performance Test\original.jpg".to_string();
    let salted = resolve_hash_collisions(&conn, &[("abc".into(), copy.clone(), true)]);
    assert_eq!(salted.get(&0), Some(&salt_hash_with_path("abc", &copy)));
}

#[test]
fn row_owner_keeps_its_hash() {
    let original = temp_file("owner.jpg");
    let conn = collision_db(&[("abc", &original)]);
    let salted = resolve_hash_collisions(
        &conn,
        &[("abc".into(), original.clone(), false), ("abc".into(), r"D:\copy\owner.jpg".into(), true)],
    );
    assert!(!salted.contains_key(&0), "the row owner must keep the original hash");
    assert!(salted.contains_key(&1));
}

#[test]
fn moved_file_inherits_row_when_old_path_is_gone() {
    let conn = collision_db(&[("abc", r"Z:\definitely\missing\old.jpg")]);
    let salted = resolve_hash_collisions(&conn, &[("abc".into(), r"C:\new\old.jpg".into(), true)]);
    assert!(salted.is_empty(), "a moved file keeps its hash so ratings and tags follow it");
}

#[test]
fn copies_within_one_scan_get_distinct_hashes() {
    let conn = collision_db(&[]);
    let entries = [
        ("abc".to_string(), r"C:\Photos\b\img.jpg".to_string(), true),
        ("abc".to_string(), r"C:\Photos\a\img.jpg".to_string(), true),
    ];
    let salted = resolve_hash_collisions(&conn, &entries);
    assert_eq!(salted.len(), 1);
    assert!(salted.contains_key(&0), "the lexicographically first path owns the hash");
    assert_ne!(salted[&0], "abc");
}

#[test]
fn salted_hash_is_stable_and_case_insensitive() {
    assert_eq!(salt_hash_with_path("abc", r"C:\X\a.jpg"), salt_hash_with_path("abc", r"c:\x\A.JPG"));
    assert_eq!(salt_hash_with_path("abc", r"C:\X\a.jpg").len(), 16);
}

// ----------------- XMP SIDECARS -----------------

use crate::files::{build_xmp_packet, is_lumina_owned_sidecar, xmp_gps_coordinate, XmpData};

fn sample_xmp<'a>() -> XmpData<'a> {
    XmpData {
        rating: 4,
        rejected: false,
        color_label: "red",
        caption: "Kids at \"the\" beach & <dunes>",
        captured_at: "2024-07-14 16:05:09",
        lat: Some(51.2194),
        lon: Some(-4.4025),
        subjects: vec!["beach", "Anna"],
    }
}

#[test]
fn xmp_gps_uses_degrees_decimal_minutes() {
    assert_eq!(xmp_gps_coordinate(51.2194, 'N', 'S'), "51,13.164000N");
    assert_eq!(xmp_gps_coordinate(-4.4025, 'E', 'W'), "4,24.150000W");
}

#[test]
fn xmp_packet_uses_lightroom_formats() {
    let xmp = build_xmp_packet(&sample_xmp());
    assert!(xmp.contains("xmp:Rating=\"4\""));
    assert!(xmp.contains("xmp:Label=\"Red\""));
    assert!(xmp.contains("xmp:CreateDate=\"2024-07-14T16:05:09\""));
    assert!(xmp.contains("exif:GPSLatitude=\"51,13.164000N\""));
    assert!(xmp.contains("exif:GPSLongitude=\"4,24.150000W\""));
    assert!(xmp.contains("Kids at &quot;the&quot; beach &amp; &lt;dunes&gt;"));
    assert!(xmp.contains("<rdf:li>Anna</rdf:li>"));
}

#[test]
fn xmp_rejected_photo_gets_rating_minus_one() {
    let xmp = build_xmp_packet(&XmpData { rejected: true, ..sample_xmp() });
    assert!(xmp.contains("xmp:Rating=\"-1\""));
}

#[test]
fn xmp_omits_empty_label_date_and_gps() {
    let xmp = build_xmp_packet(&XmpData { color_label: "", captured_at: "", lat: None, lon: None, ..sample_xmp() });
    assert!(!xmp.contains("xmp:Label"));
    assert!(!xmp.contains("xmp:CreateDate"));
    assert!(!xmp.contains("GPSLatitude"));
}

#[test]
fn foreign_sidecars_are_never_overwritten() {
    let dir = std::env::temp_dir().join("lumina_xmp_tests");
    fs::create_dir_all(&dir).unwrap();
    let lightroom = dir.join("lr.xmp");
    fs::write(&lightroom, "<x:xmpmeta xmp:CreatorTool=\"Adobe Photoshop Lightroom Classic 13.0\"/>").unwrap();
    let ours_old = dir.join("ours.xmp");
    fs::write(&ours_old, "<x:xmpmeta xmp:CreatorTool=\"Lumina v3.6\"/>").unwrap();
    let missing = dir.join("missing.xmp");
    let _ = fs::remove_file(&missing);

    assert!(!is_lumina_owned_sidecar(&lightroom));
    assert!(is_lumina_owned_sidecar(&ours_old), "sidecars from older Lumina versions stay updatable");
    assert!(is_lumina_owned_sidecar(&missing));
}

// ----------------- COMMIT: FILE MOVES & SIDECARS -----------------

use crate::files::{move_file, sidecars_for};

fn fresh_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("lumina_move_tests").join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn move_file_moves_content_and_removes_source() {
    let dir = fresh_dir("basic");
    let src = dir.join("a.jpg");
    fs::write(&src, b"photo bytes").unwrap();
    fs::create_dir_all(dir.join("sub")).unwrap();
    let dest = dir.join("sub").join("a.jpg");
    move_file(&src, &dest).unwrap();
    assert!(!src.exists());
    assert_eq!(fs::read(&dest).unwrap(), b"photo bytes");
}

#[test]
fn move_file_reports_missing_source() {
    let dir = fresh_dir("missing");
    assert!(move_file(&dir.join("nope.jpg"), &dir.join("x.jpg")).is_err());
}

#[test]
fn sidecars_travel_with_a_lone_photo() {
    let dir = fresh_dir("lone");
    let img = dir.join("IMG_1.CR3");
    fs::write(&img, b"raw").unwrap();
    fs::write(dir.join("IMG_1.xmp"), b"x").unwrap();
    fs::write(dir.join("IMG_1.CR3.xmp"), b"x").unwrap();
    let mut found: Vec<String> = sidecars_for(&img)
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
        .collect();
    found.sort();
    assert_eq!(found, vec!["IMG_1.CR3.xmp", "IMG_1.xmp"]);
}

#[test]
fn shared_sidecar_stays_while_pair_partner_remains() {
    let dir = fresh_dir("pair");
    let jpg = dir.join("IMG_2.JPG");
    fs::write(&jpg, b"jpg").unwrap();
    fs::write(dir.join("IMG_2.CR3"), b"raw").unwrap();
    fs::write(dir.join("IMG_2.xmp"), b"x").unwrap();
    assert!(sidecars_for(&jpg).is_empty(), "the RAW still needs IMG_2.xmp");
}

// ----------------- FACE MODEL FILE VALIDATION -----------------

#[test]
fn sha256_matches_known_vector_and_handles_missing_files() {
    use crate::face_ort::sha256_hex;
    let dir = fresh_dir("models");
    let file = dir.join("abc.bin");
    fs::write(&file, b"abc").unwrap();
    // FIPS 180-2 test vector for "abc"
    assert_eq!(
        sha256_hex(&file).as_deref(),
        Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    );
    assert_eq!(sha256_hex(&dir.join("missing.onnx")), None);
}

#[test]
fn embedding_blob_round_trips() {
    use crate::face_ort::{blob_to_embedding, embedding_to_blob};
    let v: Vec<f32> = (0..512).map(|i| (i as f32 * 0.37).sin()).collect();
    let blob = embedding_to_blob(&v);
    assert_eq!(blob.len(), 512 * 4);
    assert_eq!(blob_to_embedding(&blob), v);
}

// ----------------- FACE REJECTIONS SURVIVE RE-DETECTION -----------------

#[test]
fn bbox_iou_basics() {
    let a = (0.1, 0.1, 0.2, 0.2);
    assert!((bbox_iou(a, a) - 1.0).abs() < 1e-9);
    assert_eq!(bbox_iou(a, (0.5, 0.5, 0.2, 0.2)), 0.0);
    let half = bbox_iou(a, (0.2, 0.1, 0.2, 0.2)); // shifted by half a width
    assert!((half - 1.0 / 3.0).abs() < 1e-9);
}

fn rejections_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE face_rejections (face_id TEXT NOT NULL, person_name TEXT NOT NULL, PRIMARY KEY (face_id, person_name));
         INSERT INTO face_rejections VALUES ('h_10_10', 'Anna'), ('h_10_10', 'Ben'), ('h_70_20', 'Anna');",
    )
    .unwrap();
    conn
}

fn rejections(conn: &Connection) -> Vec<(String, String)> {
    let mut stmt = conn.prepare("SELECT face_id, person_name FROM face_rejections ORDER BY 1, 2").unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().flatten().collect()
}

#[test]
fn rejections_follow_the_redetected_face() {
    let conn = rejections_db();
    let old = vec![("h_10_10".to_string(), (0.10, 0.10, 0.2, 0.2))];
    // Re-detection found the same face, slightly shifted, under a new id
    let new = vec![("h_11_10".to_string(), (0.11, 0.10, 0.2, 0.2)), ("h_60_60".to_string(), (0.6, 0.6, 0.1, 0.1))];
    carry_over_rejections(&conn, &old, &new);
    assert_eq!(
        rejections(&conn),
        vec![
            ("h_11_10".into(), "Anna".into()),
            ("h_11_10".into(), "Ben".into()),
            ("h_70_20".into(), "Anna".into())
        ]
    );
}

#[test]
fn rejections_of_vanished_faces_are_removed() {
    let conn = rejections_db();
    let old = vec![("h_70_20".to_string(), (0.70, 0.20, 0.1, 0.1))];
    carry_over_rejections(&conn, &old, &[]);
    assert!(rejections(&conn).iter().all(|(id, _)| id != "h_70_20"));
}

// ----------------- CONTENT HASH COMPATIBILITY -----------------

// The hash every existing DB row is keyed by (pre-Phase-2 implementation). hash_and_read_head must
// produce exactly the same value, or every photo would look new and lose its ratings/tags/faces.
fn legacy_fast_hash(path: &Path, file_size: u64) -> String {
    let mut file = File::open(path).unwrap();
    let mut hasher = blake3::Hasher::new();
    hasher.update(&file_size.to_le_bytes());
    let mut buffer = vec![0u8; 65536];
    let bytes_read = file.read(&mut buffer).unwrap();
    hasher.update(&buffer[..bytes_read]);
    if file_size > 65536 * 2 {
        file.seek(SeekFrom::End(-65536)).unwrap();
        let bytes_read_end = file.read(&mut buffer).unwrap();
        hasher.update(&buffer[..bytes_read_end]);
    }
    hasher.finalize().to_hex()[..16].to_string()
}

#[test]
fn new_hash_matches_legacy_hash_for_all_size_classes() {
    let dir = fresh_dir("hash_compat");
    // Below 64 KB, between 64 KB and 128 KB (no tail read), just above 128 KB, and larger than the head
    for size in [1_000usize, 100_000, 131_073, 500_000] {
        let path = dir.join(format!("f{size}.bin"));
        let bytes: Vec<u8> = (0..size).map(|i| (i * 7 % 251) as u8).collect();
        fs::write(&path, &bytes).unwrap();
        let (hash, head) = hash_and_read_head(&path, size as u64).unwrap();
        assert_eq!(hash, legacy_fast_hash(&path, size as u64), "size {size}");
        assert_eq!(head.len(), size.min(FILE_HEAD_BYTES), "head length for size {size}");
        assert_eq!(&head[..], &bytes[..head.len()]);
    }
}

// Manual: parsing EXIF/dimensions from the head buffer must give the same result as reading the file.
// PowerShell: $env:LUMINA_DIAG_DIR="D:\Performance Test"; cargo test --release --lib head_exif_matches_file_exif -- --ignored --nocapture
#[test]
#[ignore]
fn head_exif_matches_file_exif() {
    let Ok(dir) = std::env::var("LUMINA_DIAG_DIR") else {
        eprintln!("Set LUMINA_DIAG_DIR");
        return;
    };
    let files: Vec<PathBuf> = WalkDir::new(&dir).into_iter().flatten().map(|e| e.into_path()).filter(|p| p.is_file()).collect();
    let describe = |x: &FullExifPass| {
        format!(
            "{}x{} | {} | {} | {} | {:?},{:?} | {:?} {:?} {:?} {:?} {:?}",
            x.width, x.height, x.captured_at, x.camera_model, x.location, x.lat, x.lon,
            x.focal_length, x.aperture, x.shutter_speed, x.iso, x.lens_model
        )
    };
    let mismatches: Vec<(PathBuf, String, String)> = files
        .par_iter()
        .filter_map(|p| {
            let size = fs::metadata(p).ok()?.len();
            let (_, head) = hash_and_read_head(p, size).ok()?;
            let from_head = describe(&extract_all_exif_with_head(p, Some(&head)));
            let from_file = describe(&extract_all_exif_single_pass(p));
            (from_head != from_file).then(|| (p.clone(), from_head, from_file))
        })
        .collect();
    eprintln!("checked {} files, {} mismatches", files.len(), mismatches.len());
    for (p, a, b) in mismatches.iter().take(20) {
        eprintln!("  {}\n    head: {a}\n    file: {b}", p.display());
    }
    assert!(mismatches.is_empty());
}

// Manual benchmark of the thumbnail decoders on real files (run twice: the 1st run warms the OS file cache).
// PowerShell: $env:LUMINA_DIAG_DIR="D:\Performance Test"; $env:LUMINA_DIAG_OUT="<folder>";
//             cargo test --release --lib bench_thumbnail_decoders -- --ignored --nocapture
#[test]
#[ignore]
fn bench_thumbnail_decoders() {
    let Ok(dir) = std::env::var("LUMINA_DIAG_DIR") else {
        eprintln!("Set LUMINA_DIAG_DIR");
        return;
    };
    let out_dir = std::env::var("LUMINA_DIAG_OUT").ok().map(PathBuf::from);
    let files: Vec<PathBuf> = WalkDir::new(&dir).into_iter().flatten().map(|e| e.into_path()).filter(|p| p.is_file()).collect();
    let ext_of = |p: &Path| p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    // The largest JPEGs (camera originals) are where decoding time actually goes
    let mut jpegs: Vec<&PathBuf> = files.iter().filter(|p| is_jpeg_ext(&ext_of(p))).collect();
    jpegs.sort_by_key(|p| std::cmp::Reverse(fs::metadata(p).map(|m| m.len()).unwrap_or(0)));
    jpegs.truncate(100);
    let heics: Vec<&PathBuf> = files.iter().filter(|p| ext_of(p) == "heic").collect();

    // JPEG: full decode (current path) vs DCT-scaled decode, single thread for a clean per-file number
    let mut full_ms = 0u128;
    let mut scaled_ms = 0u128;
    let mut scaled_fail = 0;
    for p in &jpegs {
        let bytes = fs::read(p).unwrap();
        let t = Instant::now();
        let full = image::load_from_memory(&bytes).ok().map(|i| i.thumbnail(360, 360));
        full_ms += t.elapsed().as_millis();
        let t = Instant::now();
        let scaled = decode_jpeg_scaled(&bytes, 360).map(|i| i.thumbnail(360, 360));
        scaled_ms += t.elapsed().as_millis();
        if scaled.is_none() {
            scaled_fail += 1;
            let mut d = jpeg_decoder::Decoder::new(Cursor::new(&bytes));
            let reason = match d.read_info() {
                Err(e) => format!("read_info: {e}"),
                Ok(()) => match d.scale(360, 360) {
                    Err(e) => format!("scale: {e}"),
                    Ok(_) => match d.decode() {
                        Err(e) => format!("decode: {e}"),
                        Ok(_) => format!("pixel format {:?}", d.info().map(|i| i.pixel_format)),
                    },
                },
            };
            eprintln!("  scaled decode failed: {} (full decode ok: {}) -> {reason}", p.display(), full.is_some());
        }
    }
    eprintln!(
        "JPEG x{}: full decode+thumb {:.1} ms/file, scaled decode+thumb {:.1} ms/file, scaled failures {}",
        jpegs.len(),
        full_ms as f64 / jpegs.len().max(1) as f64,
        scaled_ms as f64 / jpegs.len().max(1) as f64,
        scaled_fail
    );

    // HEIC through in-process WIC
    eprintln!("WIC factory available: {}", wic_available());
    let mut thumb_ms = 0u128;
    let mut prev_ms = 0u128;
    let mut heic_fail = 0;
    for (i, p) in heics.iter().enumerate() {
        let t = Instant::now();
        let thumb = wic_decode(p, 360, true);
        thumb_ms += t.elapsed().as_millis();
        let t = Instant::now();
        let preview = wic_decode(p, 1920, false);
        prev_ms += t.elapsed().as_millis();
        match (&thumb, &preview) {
            (Some(th), Some(pv)) => {
                if i < 3 {
                    eprintln!("  {} thumb {:?} preview {:?}", p.display(), th.dimensions(), pv.dimensions());
                    if let Some(out) = &out_dir {
                        let _ = th.to_rgb8().save(out.join(format!("heic_thumb_{i}.jpg")));
                        let _ = pv.thumbnail(800, 800).to_rgb8().save(out.join(format!("heic_preview_{i}.jpg")));
                    }
                }
            }
            _ => heic_fail += 1,
        }
    }
    eprintln!(
        "HEIC x{} via WIC: thumb {:.1} ms/file, 1920 preview {:.1} ms/file, failures {}",
        heics.len(),
        thumb_ms as f64 / heics.len().max(1) as f64,
        prev_ms as f64 / heics.len().max(1) as f64,
        heic_fail
    );
}

// Manual end-to-end benchmark of the thumbnail pipeline (readers + decoders), regenerating every thumbnail.
// PowerShell: $env:LUMINA_DIAG_DIR="D:\Performance Test"; $env:LUMINA_DIAG_OUT="<scratch folder>";
//             cargo test --release --lib bench_thumbnail_pipeline -- --ignored --nocapture
#[test]
#[ignore]
fn bench_thumbnail_pipeline() {
    let (Ok(dir), Ok(out)) = (std::env::var("LUMINA_DIAG_DIR"), std::env::var("LUMINA_DIAG_OUT")) else {
        eprintln!("Set LUMINA_DIAG_DIR and LUMINA_DIAG_OUT");
        return;
    };
    let thumbs_dir = PathBuf::from(out).join("thumbs_bench");
    let exts = ["jpg", "jpeg", "png", "heic", "heif", "cr2", "cr3", "nef", "arw", "dng"];
    let items: Vec<PhotoItem> = WalkDir::new(&dir)
        .into_iter()
        .flatten()
        .map(|e| e.into_path())
        .filter(|p| p.extension().map(|e| exts.contains(&e.to_string_lossy().to_lowercase().as_str())).unwrap_or(false))
        .enumerate()
        .map(|(i, p)| {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            let ext = p.extension().unwrap().to_string_lossy().to_lowercase();
            let thumb = thumbs_dir.join(format!("{i}.jpg")).to_string_lossy().to_string();
            // Mirror scan_folder: RAW/HEIC show their thumb and keep the original in pair_raw_path
            let (path, pair) = if is_raw_or_heic_ext(&ext) {
                (thumb.clone(), Some(p.to_string_lossy().to_string()))
            } else {
                (p.to_string_lossy().to_string(), None)
            };
            PhotoItem { hash: i.to_string(), name, path, pair_raw_path: pair, thumb_path: thumb, ..Default::default() }
        })
        .collect();

    for io_threads in [2usize, 16] {
        let _ = fs::remove_dir_all(&thumbs_dir);
        fs::create_dir_all(&thumbs_dir).unwrap();
        let started = Instant::now();
        let (mut ok, mut failed, mut damaged) = (0, 0, 0);
        let (_, heic) = run_decode_pipeline(&items, io_threads, true, &HashSet::new(), || false, |e| {
            if let PipelineEvent::Item(item) = e {
                if item.thumb_ok { ok += 1 } else { failed += 1 }
                if item.damaged { damaged += 1 }
            }
        });
        let ms = started.elapsed().as_millis();
        eprintln!(
            "{} files with {io_threads} readers + {} decoders: {ms} ms ({:.1}/s) · ok {ok} · failed {failed} · damaged {damaged} · HEIC {heic}",
            items.len(),
            BG_POOL.current_num_threads(),
            items.len() as f64 * 1000.0 / ms.max(1) as f64
        );
    }
}

// Manual: exports AI-input JPEGs (384/640/896 px, q90) of a sample of photos for the Ollama benchmark script
// PowerShell: $env:LUMINA_DIAG_DIR="D:\Performance Test"; $env:LUMINA_DIAG_OUT="<folder>";
//             cargo test --release --lib export_ai_samples -- --ignored --nocapture
#[test]
#[ignore]
fn export_ai_samples() {
    let (Ok(dir), Ok(out)) = (std::env::var("LUMINA_DIAG_DIR"), std::env::var("LUMINA_DIAG_OUT")) else {
        eprintln!("Set LUMINA_DIAG_DIR and LUMINA_DIAG_OUT");
        return;
    };
    let out = PathBuf::from(out).join("ai_samples");
    fs::create_dir_all(&out).unwrap();
    let mut files: Vec<PathBuf> = WalkDir::new(&dir)
        .into_iter()
        .flatten()
        .map(|e| e.into_path())
        .filter(|p| p.extension().map(|e| matches!(e.to_string_lossy().to_lowercase().as_str(), "jpg" | "heic")).unwrap_or(false))
        .collect();
    files.sort();
    // Every 70th file: a spread of camera photos, phone photos, HEIC and messaging images
    let sample: Vec<&PathBuf> = files.iter().step_by(70).take(24).collect();
    for (i, p) in sample.iter().enumerate() {
        let Ok(img) = open_and_orient_image(p) else { continue };
        for edge in [384u32, 640, 896, 1280, 1600] {
            let small = img.thumbnail(edge, edge).to_rgb8();
            let mut buf = Cursor::new(Vec::new());
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 90).encode_image(&small).unwrap();
            fs::write(out.join(format!("{i:02}_{edge}.jpg")), buf.into_inner()).unwrap();
        }
    }
    eprintln!("exported {} samples to {}", sample.len(), out.display());
}

#[test]
#[ignore]
fn diagnose_drive_types() {
    for drive in ["C:\\", "D:\\", "E:\\"] {
        let p = Path::new(drive);
        if p.exists() {
            eprintln!("{drive} seek penalty: {:?} -> index readers {:?}", drive_has_seek_penalty(p), index_io_threads(p));
        }
    }
}

// ----------------- THUMBNAIL DECODE DIAGNOSTIC (manual) -----------------
// Runs the real thumbnail decoder over a folder and lists every failure with its error.
// PowerShell: $env:LUMINA_DIAG_DIR="D:\Performance Test"; cargo test --lib diagnose_thumbnail_failures -- --ignored --nocapture

#[test]
#[ignore]
fn diagnose_thumbnail_failures() {
    let Ok(dir) = std::env::var("LUMINA_DIAG_DIR") else {
        eprintln!("Set LUMINA_DIAG_DIR to the folder to diagnose");
        return;
    };
    let exts = ["jpg", "jpeg", "png", "webp", "bmp", "gif", "tiff", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "pef", "raf"];
    let files: Vec<PathBuf> = WalkDir::new(&dir)
        .into_iter()
        .flatten()
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .map(|e| exts.contains(&e.to_string_lossy().to_lowercase().as_str()))
                .unwrap_or(false)
        })
        .collect();
    let results: Vec<(PathBuf, Result<bool, String>)> = files
        .par_iter()
        .map(|p| (p.clone(), open_and_orient_image_for_thumb(p).map(|(_, recovered)| recovered)))
        .collect();
    let recovered: Vec<&PathBuf> = results.iter().filter(|(_, r)| matches!(r, Ok(true))).map(|(p, _)| p).collect();
    let failed: Vec<(&PathBuf, &String)> = results.iter().filter_map(|(p, r)| r.as_ref().err().map(|e| (p, e))).collect();
    eprintln!(
        "checked {} files (HEIC excluded): {} recovered from damaged data, {} unreadable",
        files.len(),
        recovered.len(),
        failed.len()
    );
    for p in &recovered {
        eprintln!("  recovered  {}", p.display());
    }
    for (p, e) in &failed {
        eprintln!("  FAILED     {}  ->  {}", p.display(), e);
    }
}

// ----------------- FOLDER SCOPE -----------------

fn paths_in_scope(root: Option<&str>, paths: &[&str]) -> Vec<String> {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute("CREATE TABLE photos (current_path TEXT)", []).unwrap();
    for p in paths {
        conn.execute("INSERT INTO photos VALUES (?1)", params![p]).unwrap();
    }
    let mut stmt = conn
        .prepare("SELECT current_path FROM photos WHERE current_path LIKE ?1 ESCAPE '!' ORDER BY current_path")
        .unwrap();
    stmt.query_map(params![make_folder_prefix(root)], |r| r.get(0))
        .unwrap()
        .flatten()
        .collect()
}

#[test]
fn folder_scope_excludes_sibling_folders() {
    let found = paths_in_scope(
        Some(r"C:\Photos"),
        &[r"C:\Photos\a.jpg", r"C:\Photos\sub\b.jpg", r"C:\Photos2\c.jpg", r"C:\PhotosOld\d.jpg"],
    );
    assert_eq!(found, vec![r"C:\Photos\a.jpg", r"C:\Photos\sub\b.jpg"]);
}

#[test]
fn folder_scope_treats_wildcards_in_names_literally() {
    let found = paths_in_scope(
        Some(r"D:\100%_Trip!"),
        &[r"D:\100%_Trip!\a.jpg", r"D:\100X-Trip!\b.jpg", r"D:\100%xTrip!\c.jpg"],
    );
    assert_eq!(found, vec![r"D:\100%_Trip!\a.jpg"]);
}

#[test]
fn folder_scope_handles_trailing_separator_and_drive_root() {
    assert_eq!(paths_in_scope(Some(r"C:\Photos\"), &[r"C:\Photos\a.jpg"]), vec![r"C:\Photos\a.jpg"]);
    assert_eq!(paths_in_scope(Some(r"D:\"), &[r"D:\a.jpg", r"E:\b.jpg"]), vec![r"D:\a.jpg"]);
}

#[test]
fn folder_scope_is_case_insensitive_like_windows() {
    assert_eq!(paths_in_scope(Some(r"c:\photos"), &[r"C:\Photos\a.jpg"]), vec![r"C:\Photos\a.jpg"]);
}

#[test]
fn folder_scope_without_root_matches_everything() {
    assert_eq!(make_folder_prefix(None), "%");
    assert_eq!(make_folder_prefix(Some("  ")), "%");
    assert_eq!(paths_in_scope(None, &[r"C:\a.jpg", r"D:\b.jpg"]).len(), 2);
}

// ----------------- FACE ALIGNMENT (engine v2) -----------------

#[test]
fn similarity_transform_recovers_a_known_transform() {
    use crate::face_ort::similarity_transform;
    let src = [(10.0, 20.0), (50.0, 18.0), (30.0, 40.0), (14.0, 60.0), (48.0, 62.0)];
    // Known transform: scale 1.5, rotation 20 degrees, translation (7, -3)
    let (s, r) = (1.5f32, 20f32.to_radians());
    let (a, b) = (s * r.cos(), s * r.sin());
    let dst = src.map(|(x, y)| (a * x - b * y + 7.0, b * x + a * y - 3.0));
    let (fa, fb, tx, ty) = similarity_transform(&src, &dst);
    assert!((fa - a).abs() < 1e-4 && (fb - b).abs() < 1e-4, "rotation/scale: {fa} {fb}");
    assert!((tx - 7.0).abs() < 1e-3 && (ty + 3.0).abs() < 1e-3, "translation: {tx} {ty}");
}

#[test]
fn align_face_maps_landmarks_onto_the_arcface_template() {
    use crate::face_ort::align_face;
    // A synthetic image with a bright dot at each "landmark"; after alignment each dot must land on the template
    let mut img = image::RgbImage::new(400, 300);
    let landmarks = [(150.0f32, 120.0), (230.0, 116.0), (190.0, 165.0), (158.0, 210.0), (226.0, 207.0)];
    for (x, y) in landmarks {
        for dy in -2i32..=2 {
            for dx in -2i32..=2 {
                img.put_pixel((x as i32 + dx) as u32, (y as i32 + dy) as u32, image::Rgb([255, 255, 255]));
            }
        }
    }
    let aligned = align_face(&img, &landmarks);
    let template = [(38.2946f32, 51.6963f32), (73.5318, 51.5014), (56.0252, 71.7366), (41.5493, 92.3655), (70.7299, 92.2041)];
    // Landmarks were chosen close to (but not exactly) a similarity of the template: allow a few pixels
    for (tx, ty) in template {
        let found = (-3i32..=3).any(|dy| {
            (-3i32..=3).any(|dx| aligned.get_pixel((tx as i32 + dx) as u32, (ty as i32 + dy) as u32)[0] > 100)
        });
        assert!(found, "no landmark near template point ({tx}, {ty})");
    }
}

#[test]
fn album_names_are_unique_ignoring_case_and_members_are_not_duplicated() {
    let conn = Connection::open_in_memory().unwrap();
    albums::ensure_album_tables(&conn);
    conn.execute("INSERT INTO albums (name) VALUES ('Holiday')", []).unwrap();
    assert!(conn.execute("INSERT INTO albums (name) VALUES ('holiday')", []).is_err());
    let id = conn.last_insert_rowid();
    let insert = "INSERT OR IGNORE INTO album_photos (album_id, hash) VALUES (?1, ?2)";
    assert_eq!(conn.execute(insert, params![id, "h1"]).unwrap(), 1);
    assert_eq!(conn.execute(insert, params![id, "h1"]).unwrap(), 0);
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM album_photos", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn renaming_a_person_onto_an_existing_name_merges_them() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, cover_face_thumb TEXT DEFAULT '', hidden INTEGER DEFAULT 0, starred INTEGER DEFAULT 0);
         CREATE TABLE photo_people (hash TEXT, person_name TEXT, PRIMARY KEY (hash, person_name));
         CREATE TABLE photo_faces (face_id TEXT PRIMARY KEY, hash TEXT, person_name TEXT);
         CREATE TABLE face_rejections (face_id TEXT NOT NULL, person_name TEXT NOT NULL, PRIMARY KEY (face_id, person_name));
         INSERT INTO people (name, cover_face_thumb, starred) VALUES ('anna', 'a.jpg', 1), ('Anna Smith', '', 0);
         INSERT INTO photo_people VALUES ('h1', 'anna'), ('h2', 'anna'), ('h2', 'Anna Smith');
         INSERT INTO photo_faces VALUES ('f1', 'h1', 'anna'), ('f2', 'h2', 'Anna Smith');
         INSERT INTO face_rejections VALUES ('f9', 'anna');",
    )
    .unwrap();

    people::rename_person_in_db(&mut conn, "anna", "Anna Smith").unwrap();

    let people: Vec<(String, String)> = conn
        .prepare("SELECT name, cover_face_thumb FROM people")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(people, vec![("Anna Smith".to_string(), "a.jpg".to_string())]);
    let tagged: i64 = conn.query_row("SELECT COUNT(*) FROM photo_people WHERE person_name = 'Anna Smith'", [], |r| r.get(0)).unwrap();
    assert_eq!(tagged, 2);
    let leftovers: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM photo_people WHERE person_name = 'anna')
                  + (SELECT COUNT(*) FROM photo_faces WHERE person_name = 'anna')
                  + (SELECT COUNT(*) FROM face_rejections WHERE person_name = 'anna')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leftovers, 0);
    // The star of the merged-away person carries over
    let starred: i64 = conn.query_row("SELECT starred FROM people", [], |r| r.get(0)).unwrap();
    assert_eq!(starred, 1);

    // A capitalisation-only rename is a rename, not a merge
    people::rename_person_in_db(&mut conn, "Anna Smith", "ANNA SMITH").unwrap();
    let name: String = conn.query_row("SELECT name FROM people", [], |r| r.get(0)).unwrap();
    assert_eq!(name, "ANNA SMITH");
}

#[test]
fn an_edited_file_keeps_its_tags_people_faces_and_albums() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE photos (hash TEXT PRIMARY KEY, current_path TEXT);
         CREATE TABLE photo_tags (hash TEXT, tag TEXT, PRIMARY KEY (hash, tag));
         CREATE TABLE photo_people (hash TEXT, person_name TEXT, PRIMARY KEY (hash, person_name));
         CREATE TABLE photo_faces (face_id TEXT PRIMARY KEY, hash TEXT, person_name TEXT);
         CREATE TABLE album_photos (album_id INTEGER, hash TEXT, PRIMARY KEY (album_id, hash));
         CREATE TABLE photo_clip (hash TEXT PRIMARY KEY, embedding BLOB, model TEXT);
         INSERT INTO photos VALUES ('old', '/lib/a.jpg'), ('new', '/lib/a.jpg'), ('other', '/lib/b.jpg');
         INSERT INTO photo_tags VALUES ('old', 'beach'), ('old', 'sunset'), ('new', 'sunset');
         INSERT INTO photo_people VALUES ('old', 'Anna');
         INSERT INTO photo_faces VALUES ('f1', 'old', 'Anna');
         INSERT INTO album_photos VALUES (1, 'old');
         INSERT INTO photo_clip VALUES ('old', x'00', 'clip');",
    )
    .unwrap();

    assert_eq!(scan::paths_claimed_twice(&conn, "/lib/%"), vec!["/lib/a.jpg".to_string()]);
    scan::retire_replaced_row(&conn, "old", "new").unwrap();

    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(count("SELECT COUNT(*) FROM photos WHERE current_path = '/lib/a.jpg'"), 1);
    assert_eq!(count("SELECT COUNT(*) FROM photo_tags WHERE hash = 'new'"), 2);
    assert_eq!(count("SELECT COUNT(*) FROM photo_people WHERE hash = 'new'"), 1);
    assert_eq!(count("SELECT COUNT(*) FROM photo_faces WHERE hash = 'new'"), 1);
    assert_eq!(count("SELECT COUNT(*) FROM album_photos WHERE hash = 'new'"), 1);
    assert_eq!(
        count("SELECT (SELECT COUNT(*) FROM photo_tags WHERE hash = 'old') + (SELECT COUNT(*) FROM photo_clip)"),
        0
    );
    assert!(scan::paths_claimed_twice(&conn, "/lib/%").is_empty());
}

#[test]
fn prepare_models_uses_the_configured_app_identifier() {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(conf["identifier"].as_str(), Some(prepare::APP_IDENTIFIER));
}

#[test]
fn import_dates_folders_and_names() {
    use crate::import::*;
    assert_eq!(day_of("2024:06:15 18:30:00").as_deref(), Some("2024-06-15"));
    assert_eq!(day_of("2024-06-15").as_deref(), Some("2024-06-15"));
    assert_eq!(day_of("0000:00:00 00:00:00"), None);
    assert_eq!(day_of(""), None);
    assert_eq!(day_from_unix(0), "1970-01-01");
    assert_eq!(day_from_unix(1_718_476_200), "2024-06-15");
    assert_eq!(day_from_unix(951_782_400), "2000-02-29");

    let p = |pattern: &str, day: Option<&str>| date_folder(pattern, day).to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
    assert_eq!(p("year-month", Some("2024-06-15")), "2024/2024-06");
    assert_eq!(p("year-month-day", Some("2024-06-15")), "2024/2024-06-15");
    assert_eq!(p("flat", Some("2024-06-15")), "");
    assert_eq!(p("year-month", None), "Unknown date");

    assert_eq!(with_suffix("IMG_1.CR3", "_2"), "IMG_1_2.CR3");
    assert_eq!(with_suffix("README", "_2"), "README_2");
    // The pair moves to _3 together when either name is taken under _2
    let taken = ["IMG_1.CR3", "IMG_1_2.JPG"];
    let names = vec!["IMG_1.CR3".to_string(), "IMG_1.JPG".to_string()];
    let suffix = free_suffix(Path::new(""), &names, |path| taken.iter().any(|t| Path::new(t) == path));
    assert_eq!(suffix, "_3");

    assert_eq!(file_kind(Path::new("a/IMG_1.CR3")), Some(FileKind::Photo));
    assert_eq!(file_kind(Path::new("a/clip.MOV")), Some(FileKind::Video));
    assert_eq!(file_kind(Path::new("a/IMG_1.xmp")), Some(FileKind::Sidecar));
    assert_eq!(file_kind(Path::new("a/notes.txt")), None);
    assert!(crate::watch::is_library_photo(Path::new("C:/Photos/a.heic")));
    assert!(!crate::watch::is_library_photo(Path::new("C:/Photos/a.jpg.part")));
}

#[test]
fn import_groups_pairs_and_finds_duplicates() {
    let card = std::env::temp_dir().join("lumina_import_tests").join("DCIM");
    let _ = fs::remove_dir_all(card.parent().unwrap());
    fs::create_dir_all(card.join("100CANON")).unwrap();
    fs::create_dir_all(card.join("101CANON")).unwrap();
    let write = |rel: &str, bytes: &[u8]| fs::write(card.join(rel), bytes).unwrap();
    write("100CANON/IMG_1.CR3", b"raw one");
    write("100CANON/IMG_1.JPG", b"jpeg one");
    write("100CANON/IMG_1.xmp", b"<x/>");
    write("100CANON/IMG_2.JPG", b"jpeg two");
    write("101CANON/IMG_2.JPG", b"jpeg two"); // the same photo twice on the card
    write("100CANON/orphan.xmp", b"<x/>"); // a sidecar without a photo stays behind

    let conn = Connection::open_in_memory().unwrap();
    conn.execute("CREATE TABLE photos (hash TEXT PRIMARY KEY, current_path TEXT)", []).unwrap();
    let groups = crate::import::plan_summary(&conn, card.parent().unwrap());
    let names: Vec<Vec<&str>> = groups.iter().map(|(_, files)| files.iter().map(|(n, _)| n.as_str()).collect()).collect();
    assert_eq!(names, vec![vec!["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"], vec!["IMG_2.JPG"], vec!["IMG_2.JPG"]]);
    assert!(groups.iter().all(|(day, _)| day.is_some()), "file dates stand in when there is no EXIF date");
    assert!(!groups[1].1[0].1 && groups[2].1[0].1, "the second copy is a duplicate");

    // A photo already in the library (and still on disk) is a duplicate too
    let (hash, _) = hash_and_read_head(&card.join("100CANON/IMG_1.JPG"), 8).unwrap();
    let in_library = card.join("100CANON/IMG_1.JPG").to_string_lossy().into_owned();
    conn.execute("INSERT INTO photos VALUES (?1, ?2)", params![hash, in_library]).unwrap();
    let groups = crate::import::plan_summary(&conn, card.parent().unwrap());
    assert!(groups[0].1[1].1, "IMG_1.JPG is already in the library");
    assert!(!groups[0].1[0].1, "its RAW is not");
    let _ = fs::remove_dir_all(card.parent().unwrap());
}

// Closed-eye and face-focus calibration (manual), through the app's own face pipeline (FaceModels::analyze).
// Folders: open eyes, closed eyes (only each photo's largest face counts there: others may be looking on),
// and optionally sharp and blurred copies of the same photos for face focus.
// PowerShell: $env:LUMINA_EYES_OPEN="..."; $env:LUMINA_EYES_CLOSED="..."; [$env:LUMINA_SHARP="..."; $env:LUMINA_SOFT="..."]
//             cargo test --lib eye_calibration -- --ignored --nocapture
#[test]
#[ignore]
fn eye_calibration() {
    let models_dir = std::env::var("LUMINA_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("LOCALAPPDATA").unwrap()).join(prepare::APP_IDENTIFIER).join("models"));
    let models = FaceModels::load(&models_dir).expect("face models");
    assert!(models.can_judge_eyes(), "the closed-eye check needs the smart search models");
    let faces_in = |dir: &str, largest_only: bool| -> Vec<FaceQuality> {
        let mut out = Vec::new();
        for path in WalkDir::new(dir).into_iter().flatten().map(|e| e.into_path()) {
            if !path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("jpg")) {
                continue;
            }
            let Ok(img) = open_and_orient_image(&path) else { continue };
            let Ok(mut faces) = models.analyze(&img) else { continue };
            faces.retain(|f| (f.detection.bbox.2 * img.width() as f64).max(f.detection.bbox.3 * img.height() as f64) >= 60.0);
            if largest_only {
                faces.sort_by(|a, b| (b.detection.bbox.2 * b.detection.bbox.3).partial_cmp(&(a.detection.bbox.2 * a.detection.bbox.3)).unwrap());
                faces.truncate(1);
            }
            out.extend(faces.into_iter().map(|f| f.quality));
        }
        out
    };
    let report = |name: &str, good: Vec<f32>, bad: Vec<f32>| {
        let auc = good.iter().map(|g| bad.iter().map(|b| if g > b { 1.0 } else if g == b { 0.5 } else { 0.0 }).sum::<f64>()).sum::<f64>()
            / (good.len() * bad.len()).max(1) as f64;
        let q = |v: &[f32], p: f64| {
            let mut v = v.to_vec();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v.get(((v.len() as f64 - 1.0) * p).round() as usize).copied().unwrap_or(f32::NAN)
        };
        println!("{name}: AUC {auc:.3}");
        for (label, v) in [("good", &good), ("bad", &bad)] {
            println!(
                "  {label} n={} p05 {:.4} p25 {:.4} median {:.4} p75 {:.4} p95 {:.4}",
                v.len(),
                q(v, 0.05),
                q(v, 0.25),
                q(v, 0.5),
                q(v, 0.75),
                q(v, 0.95)
            );
        }
    };
    if let (Ok(open), Ok(closed)) = (std::env::var("LUMINA_EYES_OPEN"), std::env::var("LUMINA_EYES_CLOSED")) {
        let o: Vec<f32> = faces_in(&open, false).iter().filter_map(|q| q.eyes_open).collect();
        let c: Vec<f32> = faces_in(&closed, true).iter().filter_map(|q| q.eyes_open).collect();
        for t in [-0.009f32, -0.011, -0.013, -0.015] {
            println!(
                "eyes threshold {t}: {:.1}% of open faces flagged, {:.1}% of closed faces caught",
                o.iter().filter(|v| **v < t).count() as f64 * 100.0 / o.len().max(1) as f64,
                c.iter().filter(|v| **v < t).count() as f64 * 100.0 / c.len().max(1) as f64
            );
        }
        report("eyes open score", o, c);
    }
    if let (Ok(sharp), Ok(soft)) = (std::env::var("LUMINA_SHARP"), std::env::var("LUMINA_SOFT")) {
        let s: Vec<f32> = faces_in(&sharp, false).iter().filter_map(|q| q.sharpness).collect();
        let b: Vec<f32> = faces_in(&soft, false).iter().filter_map(|q| q.sharpness).collect();
        for t in [20.0f32, 40.0, 60.0, 80.0, 120.0] {
            println!(
                "focus threshold {t}: {:.1}% of sharp faces flagged, {:.1}% of soft faces caught",
                s.iter().filter(|v| **v < t).count() as f64 * 100.0 / s.len().max(1) as f64,
                b.iter().filter(|v| **v < t).count() as f64 * 100.0 / b.len().max(1) as f64
            );
        }
        report("face sharpness", s, b);
    }
}

#[test]
fn highlights_prefer_quality_and_variety() {
    use crate::highlights::{select_highlights, HighlightCandidate};
    let c = |hash: &str, base: f64, group: Option<i64>, minute: f64| HighlightCandidate {
        hash: hash.into(),
        base,
        group,
        time: Some(minute * 60.0),
    };
    let candidates = vec![
        c("burst_best", 5.0, Some(1), 0.0),
        c("burst_second", 4.9, Some(1), 0.1), // the same burst: never both
        c("same_minute", 4.8, None, 1.0),     // a minute later: repeats the moment
        c("later", 3.0, None, 120.0),
        c("much_later", 2.5, None, 300.0),
        c("poor", -3.0, None, 600.0),
    ];
    let no_vectors: HashMap<String, Vec<f32>> = HashMap::new();
    let none: HashMap<String, f64> = HashMap::new();
    let picks = select_highlights(&candidates, &no_vectors, &none, 3);
    assert_eq!(picks, vec!["burst_best", "later", "much_later"], "chronological, varied, best first");

    // Near-identical looks (CLIP) count as repeats too, even far apart in time
    let mut vectors = HashMap::new();
    vectors.insert("later".to_string(), vec![1.0f32, 0.0]);
    vectors.insert("much_later".to_string(), vec![1.0f32, 0.0]);
    vectors.insert("poor".to_string(), vec![0.0f32, 1.0]);
    vectors.insert("burst_best".to_string(), vec![0.6f32, 0.8]);
    let picks = select_highlights(&candidates, &vectors, &none, 3);
    assert!(picks.contains(&"burst_best".to_string()) && picks.contains(&"later".to_string()));
    assert!(!picks.contains(&"much_later".to_string()), "a look-alike of an earlier pick drops out");

    // Asking for more than there is returns everything once, without two from one burst
    let all = select_highlights(&candidates, &no_vectors, &none, 50);
    assert_eq!(all.len(), 5);
}

#[test]
fn gallery_names_and_escaping() {
    use crate::gallery::{gallery_folder_name, html_escape};
    assert_eq!(gallery_folder_name("Paris · June 2024"), "Paris-June-2024");
    assert_eq!(gallery_folder_name("  ///  "), "Gallery");
    assert_eq!(gallery_folder_name("Zomer in Lagos!"), "Zomer-in-Lagos");
    assert_eq!(html_escape("<b>Tom & Jerry</b>"), "&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;");
}

#[test]
fn backup_remaps_library_paths() {
    use crate::backup::remap_path;
    let remaps = vec![
        (r"D:\Photos".to_string(), r"E:\Pictures\".to_string()),
        (r"D:\Photos\Phone".to_string(), r"F:\Phone".to_string()),
    ];
    assert_eq!(remap_path(r"D:\Photos\2023\a.jpg", &remaps).as_deref(), Some(r"E:\Pictures\2023\a.jpg"));
    // Case-insensitive, and the longest matching folder wins
    assert_eq!(remap_path(r"d:\photos\Phone\b.heic", &remaps).as_deref(), Some(r"F:\Phone\b.heic"));
    assert_eq!(remap_path(r"D:\Photos", &remaps).as_deref(), Some(r"E:\Pictures"));
    // A sibling folder with the same start is not inside the root
    assert_eq!(remap_path(r"D:\Photos2\c.jpg", &remaps), None);
    assert_eq!(remap_path(r"C:\Other\d.jpg", &remaps), None);
}

#[test]
fn backup_finds_library_roots() {
    use crate::backup::library_roots;
    let paths: Vec<String> = [
        r"D:\04_Media\iPhone_Photos\a.jpg",
        r"D:\04_Media\iPhone_Photos\2023\b.jpg",
        r"D:\04_Media\Camera\c.jpg",
        r"C:\Users\Maarten\Pictures\Trip\d.jpg",
        r"E:\e.jpg",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let roots = library_roots(&paths, &[r"D:\04_Media\".to_string()]);
    let got: Vec<(&str, usize)> = roots.iter().map(|r| (r.path.as_str(), r.photos)).collect();
    // The known library folder takes its photos; the rest are cut to two levels below the drive
    assert_eq!(got, vec![(r"D:\04_Media", 3), (r"C:\Users\Maarten", 1), (r"E:\", 1)]);
}

#[test]
fn backup_rewrites_paths_in_the_database() {
    use crate::backup::rewrite_paths;
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r"CREATE TABLE photos (hash TEXT PRIMARY KEY, current_path TEXT, staged_target TEXT);
         CREATE TABLE photo_faces (face_id TEXT PRIMARY KEY, face_thumb TEXT);
         CREATE TABLE people (id INTEGER PRIMARY KEY, cover_face_thumb TEXT);
         INSERT INTO photos VALUES ('a', 'D:\Photos\a.jpg', 'D:\Photos\Sorted'), ('b', 'C:\Elsewhere\b.jpg', NULL);
         INSERT INTO photo_faces VALUES ('f1', 'C:\Users\Old\AppData\Local\com.amazhr.lumina\faces\f1.jpg');
         INSERT INTO people VALUES (1, 'C:\Users\Old\AppData\Local\com.amazhr.lumina\faces\f1.jpg');",
    )
    .unwrap();
    let remaps = vec![
        (r"D:\Photos".to_string(), r"E:\Photos".to_string()),
        (r"C:\Users\Old\AppData\Local\com.amazhr.lumina".to_string(), r"C:\Users\New\AppData\Local\com.amazhr.lumina".to_string()),
    ];
    assert_eq!(rewrite_paths(&mut conn, &remaps).unwrap(), 1);
    let photo: (String, String) = conn
        .query_row("SELECT current_path, staged_target FROM photos WHERE hash = 'a'", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(photo, (r"E:\Photos\a.jpg".to_string(), r"E:\Photos\Sorted".to_string()));
    let other: String = conn.query_row("SELECT current_path FROM photos WHERE hash = 'b'", [], |r| r.get(0)).unwrap();
    assert_eq!(other, r"C:\Elsewhere\b.jpg");
    let face: String = conn.query_row("SELECT face_thumb FROM photo_faces", [], |r| r.get(0)).unwrap();
    let cover: String = conn.query_row("SELECT cover_face_thumb FROM people", [], |r| r.get(0)).unwrap();
    assert_eq!(face, r"C:\Users\New\AppData\Local\com.amazhr.lumina\faces\f1.jpg");
    assert_eq!(cover, face);
}

#[test]
fn backup_csv_quoting() {
    use crate::backup::{csv_date, csv_field};
    assert_eq!(csv_date("2024:04:12 12:05:26"), "2024-04-12 12:05:26");
    assert_eq!(csv_date("2024-04-12 12:05:26"), "2024-04-12 12:05:26");
    assert_eq!(csv_field("plain"), "plain");
    assert_eq!(csv_field("beach, sunset"), "\"beach, sunset\"");
    assert_eq!(csv_field("a \"quote\""), "\"a \"\"quote\"\"\"");
}

// ----------------- DUPLICATES -----------------

fn dup_row(hash: &str, path: &str, size: i64, pixels: i64, captured_at: &str, dhash: u64) -> duplicates::DupRow {
    duplicates::DupRow {
        hash: hash.into(),
        path: path.into(),
        size,
        mtime: 0,
        pixels,
        captured_at: captured_at.into(),
        dhash: Some(dhash),
        info: 0,
    }
}

#[test]
fn exact_copies_are_proven_from_the_salted_ids() {
    let copy_path = r"D:\Takeout\Family\IMG_1.jpg";
    let rows = vec![
        dup_row("aaaa", r"D:\Photos\IMG_1.jpg", 1000, 12, "", 0),
        dup_row(&salt_hash_with_path("aaaa", copy_path), copy_path, 1000, 12, "", 0),
        // Same size, but not a copy: its ID isn't derived from the original's
        dup_row("bbbb", r"D:\Photos\IMG_2.jpg", 1000, 12, "", 0),
    ];
    assert_eq!(duplicates::exact_copy_sets(&rows).into_iter().map(|mut s| { s.sort(); s }).collect::<Vec<_>>(), vec![vec![0, 1]]);
}

#[test]
fn the_copy_to_keep_is_largest_then_oldest_then_most_info() {
    let mut small = dup_row("s", r"D:\a\x.jpg", 100, 10, "2020-01-01 10:00:00", 0);
    let big = dup_row("b", r"D:\b\x.jpg", 50, 20, "2021-01-01 10:00:00", 0);
    assert_eq!(duplicates::keeper_order(&big, &small), std::cmp::Ordering::Less);
    small.pixels = 20;
    small.size = 50;
    // Same size: the older one
    assert_eq!(duplicates::keeper_order(&small, &big), std::cmp::Ordering::Less);
    let mut rated = big.clone();
    rated.captured_at = small.captured_at.clone();
    rated.info = 3;
    assert_eq!(duplicates::keeper_order(&rated, &small), std::cmp::Ordering::Less);
}

#[test]
fn same_photo_needs_the_same_shot_not_a_burst_or_a_raw() {
    use duplicates::{camera_frame, same_photo};
    assert_eq!(camera_frame(r"D:\a\DSC00645.JPG"), Some(("dsc".into(), 645)));
    assert_eq!(camera_frame(r"D:\a\IMG_7619.CR3.jpg"), Some(("img".into(), 7619)));
    assert_eq!(camera_frame(r"D:\a\2023-09-25-0495.CR3.jpg"), None);
    assert_eq!(camera_frame(r"D:\a\IMG_E7619.HEIC"), Some(("img".into(), 7619)));
    let clip = HashMap::new();
    let looks = HashMap::new();
    let t = "2017-09-13 15:14:01";
    let original = dup_row("a", r"D:\a\DSC00645.JPG", 9, 9, t, 0xff00);
    let resized = dup_row("b", r"D:\t\DSC00645.JPG", 3, 2, t, 0xff01);
    let bw = dup_row("c", r"D:\a\DSC00645BW.jpg", 9, 9, t, 0xff03);
    let next_frame = dup_row("d", r"D:\a\DSC00646.JPG", 9, 9, t, 0xff00);
    let raw = dup_row("e", r"D:\a\DSC00645.ARW", 9, 9, t, 0xff00);
    assert!(same_photo(&original, &resized, &clip, &looks));
    assert!(same_photo(&original, &bw, &clip, &looks));
    assert!(!same_photo(&original, &next_frame, &clip, &looks));
    assert!(!same_photo(&original, &raw, &clip, &looks));
    // Grouped only within one second, and never on a date without a time
    let rows = vec![original, resized, dup_row("f", r"D:\w\IMG-1-WA0001.jpg", 1, 1, "2020-05-30 00:00:00", 0), dup_row("g", r"D:\w\IMG-1-WA0002.jpg", 1, 1, "2020-05-30 00:00:00", 0)];
    let sets = duplicates::same_photo_sets(&rows, &[0, 1, 2, 3], &clip, &looks);
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0].len(), 2);

    // An export matching two burst frames doesn't join them into one set
    let rows = vec![
        dup_row("a", r"D:\a\DSC03762.JPG", 9, 9, t, 0xff00),
        dup_row("b", r"D:\d\i5659--1x-1.ARW.jpg", 9, 9, t, 0xff00),
        dup_row("c", r"D:\a\DSC03763.JPG", 9, 9, t, 0xff00),
    ];
    let looks: HashMap<String, Vec<u8>> = ["a", "b", "c"].iter().map(|h| (h.to_string(), test_look(0))).collect();
    let sets = duplicates::same_photo_sets(&rows, &[0, 1, 2], &clip, &looks);
    assert!(sets.iter().all(|s| !(s.contains(&0) && s.contains(&2))), "{sets:?}");
    // ... and joins the frame it matches best, not the first one it was compared with
    let mut looks = looks;
    looks.get_mut("a").unwrap().iter_mut().enumerate().for_each(|(i, v)| *v = v.saturating_add((i * 7 % 5) as u8));
    assert!(same_photo(&rows[0], &rows[1], &clip, &looks));
    let sets = duplicates::same_photo_sets(&rows, &[0, 1, 2], &clip, &looks);
    assert_eq!(sets.into_iter().map(|mut s| { s.sort(); s }).collect::<Vec<_>>(), vec![vec![1, 2]]);
}

// A 64x64 grey test picture: a few bars, `shift` pixels to the right
fn test_look(shift: usize) -> Vec<u8> {
    let n = duplicates::LOOK_EDGE as usize;
    (0..n * n).map(|i| if ((i % n + n - shift) / 7 + i / n / 13).is_multiple_of(2) { 40 } else { 200 }).collect()
}

#[test]
fn file_names_tell_a_copy_from_a_burst() {
    use duplicates::{NamesSay::*, names_say};
    // Copies and edits of one shot
    assert_eq!(names_say(r"D:\a\IMG_5748.CR3.jpg", r"D:\d\IMG_5748_1.CR3.jpg"), SameShot);
    assert_eq!(names_say(r"D:\a\IMG_4187.HEIC", r"D:\a\IMG_E4187.HEIC"), SameShot);
    assert_eq!(names_say(r"D:\t\20140208_025350.jpg", r"D:\t\20140208_025350-edited.jpg"), SameShot);
    assert_eq!(names_say(r"D:\t\IMG_20180922_111851.jpg", r"D:\t\IMG_20180922_111851-EFFECTS-edited.jpg"), SameShot);
    assert_eq!(names_say(r"D:\t\IMG20260912042644.jpg", r"D:\t\IMG20260912042644~2.jpg"), SameShot);
    assert_eq!(names_say(r"D:\a\DSC00467.JPG", r"D:\b\MAARTEN - DSC00467(1).JPG"), SameShot);
    // Burst frames
    assert_eq!(names_say(r"D:\t\IMG20261014172951.jpg", r"D:\t\IMG20261014172951_01.jpg"), OtherShot);
    assert_eq!(names_say(r"D:\t\IMG_20171018_213508_012.jpg", r"D:\t\IMG_20171018_213508_008.jpg"), OtherShot);
    assert_eq!(names_say(r"D:\t\IMG_20210926_105547__01.jpg", r"D:\t\IMG_20210926_105547.jpg"), OtherShot);
    assert_eq!(names_say(r"D:\a\IMG_1835.HEIC", r"D:\a\IMG_E1836.HEIC"), OtherShot);
    // Nothing to go on
    assert_eq!(names_say(r"D:\i\BJZH8955.JPG", r"D:\i\JHBL1609.JPG"), Unknown);
    assert_eq!(names_say(r"D:\a\holiday-beach.jpg", r"D:\a\holiday-sunset.jpg"), Unknown);
}

#[test]
fn unrelated_names_need_matching_thumbnails() {
    use duplicates::{same_photo, same_photo_by_data};
    let clip = HashMap::new();
    let t = "2026-04-25 13:04:48";
    let a = dup_row("a", r"D:\i\BJZH8955.JPG", 9, 9, t, 0xff00);
    let b = dup_row("b", r"D:\i\JHBL1609.JPG", 9, 9, t, 0xff00);
    assert_eq!(same_photo_by_data(&a, &b, &clip), None);
    // No thumbnails: not the same photo
    assert!(!same_photo(&a, &b, &clip, &HashMap::new()));
    let looks = |sb: usize| -> HashMap<String, Vec<u8>> { [("a".to_string(), test_look(0)), ("b".to_string(), test_look(sb))].into() };
    assert!(same_photo(&a, &b, &clip, &looks(0)));
    // Something moved
    assert!(!same_photo(&a, &b, &clip, &looks(3)));
    // A brighter, recompressed copy still matches
    let mut brighter = looks(0);
    brighter.get_mut("b").unwrap().iter_mut().enumerate().for_each(|(i, v)| *v = (*v as u32 * 9 / 10 + 20 + (i % 3) as u32) as u8);
    assert!(same_photo(&a, &b, &clip, &brighter));
}

#[test]
fn staging_duplicates_gives_the_kept_copy_their_stars_tags_people_and_albums() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE photos (hash TEXT PRIMARY KEY, rating INTEGER, flag TEXT, color_label TEXT, ai_caption TEXT, staged_target TEXT);
         CREATE TABLE photo_tags (hash TEXT, tag TEXT, PRIMARY KEY (hash, tag));
         CREATE TABLE photo_people (hash TEXT, person_name TEXT, PRIMARY KEY (hash, person_name));
         CREATE TABLE album_photos (album_id INTEGER, hash TEXT, PRIMARY KEY (album_id, hash));
         INSERT INTO photos VALUES ('keep', 2, NULL, NULL, '', NULL), ('extra', 4, 'pick', 'red', 'A beach', NULL);
         INSERT INTO photo_tags VALUES ('keep', 'sea'), ('extra', 'sea'), ('extra', 'holiday');
         INSERT INTO photo_people VALUES ('extra', 'Anna');
         INSERT INTO album_photos VALUES (7, 'extra');",
    )
    .unwrap();
    duplicates::merge_into_keeper(&conn, "keep", "extra").unwrap();
    let (rating, flag, label, caption): (i64, String, String, String) = conn
        .query_row("SELECT rating, flag, color_label, ai_caption FROM photos WHERE hash = 'keep'", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap();
    assert_eq!((rating, flag.as_str(), label.as_str(), caption.as_str()), (4, "pick", "red", "A beach"));
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(count("SELECT COUNT(*) FROM photo_tags WHERE hash = 'keep'"), 2);
    assert_eq!(count("SELECT COUNT(*) FROM photo_people WHERE hash = 'keep'"), 1);
    assert_eq!(count("SELECT COUNT(*) FROM album_photos WHERE hash = 'keep'"), 1);
}

// Duplicates in a real library (read-only): LUMINA_DIAG_DB=<path to library.db> cargo test --lib duplicates_in_library -- --ignored --nocapture
#[test]
#[ignore]
fn duplicates_in_library() {
    let Ok(db) = std::env::var("LUMINA_DIAG_DB") else {
        eprintln!("Set LUMINA_DIAG_DB");
        return;
    };
    let conn = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let thumbs = std::path::Path::new(&db).parent().unwrap().join("thumbnails");
    let started = Instant::now();
    let (sets, photos) = duplicates::find_duplicate_sets(&conn, None, &thumbs).unwrap();
    let count = |kind: &str| {
        let s: Vec<&duplicates::DuplicateSet> = sets.iter().filter(|s| s.kind == kind).collect();
        (s.len(), s.iter().map(|s| s.hashes.len() - 1).sum::<usize>())
    };
    eprintln!("{photos} photos in {} ms", started.elapsed().as_millis());
    eprintln!("exact: {:?} (sets, extra files)", count("exact"));
    eprintln!("same photo: {:?} (sets, extra files)", count("same_photo"));
    let path = |h: &str| conn.query_row("SELECT current_path FROM photos WHERE hash = ?1", params![h], |r| r.get::<_, String>(0)).unwrap();
    for set in sets.iter().filter(|s| s.kind == "same_photo").step_by(997).take(8) {
        eprintln!("--");
        for h in &set.hashes {
            eprintln!("  {h} {}", path(h));
        }
    }
}

// Real Recycle Bin on each drive (moves scratch files there): LUMINA_RECYCLE_DIRS="C:\tmp;D:\tmp" cargo test --lib recycle_on_drives -- --ignored --nocapture
#[test]
#[ignore]
fn recycle_on_drives() {
    let Ok(dirs) = std::env::var("LUMINA_RECYCLE_DIRS") else {
        eprintln!("Set LUMINA_RECYCLE_DIRS");
        return;
    };
    for dir in dirs.split(';') {
        let dir = std::path::Path::new(dir).join("lumina-recycle-test");
        std::fs::create_dir_all(&dir).unwrap();
        let files: Vec<std::path::PathBuf> = (0..3)
            .map(|i| {
                let p = dir.join(format!("recycle-test-{i}.txt"));
                std::fs::write(&p, b"Lumina recycle test").unwrap();
                p
            })
            .collect();
        let info = crate::recycle::bin_info(&dir);
        eprintln!("{info:?}");
        let started = Instant::now();
        let outcome = crate::recycle::recycle(&files);
        eprintln!(
            "  gone {} failed {:?} refused {} in {} ms",
            outcome.gone.len(),
            outcome.failed,
            outcome.refused_permanent,
            started.elapsed().as_millis()
        );
        if std::env::var("LUMINA_EXPECT_REFUSED").is_ok() {
            // Nothing may be deleted when the Recycle Bin can't take it
            assert!(outcome.refused_permanent);
            assert!(files.iter().all(|p| p.exists()));
            let _ = std::fs::remove_dir_all(&dir);
        } else {
            assert_eq!(outcome.gone.len(), 3);
            assert!(!outcome.refused_permanent);
            let _ = std::fs::remove_dir(&dir);
        }
    }
}

#[test]
fn trash_sidecars_travel_and_orphans_are_found() {
    let root = std::env::temp_dir().join(format!("lumina-trash-sidecars-{}", std::process::id()));
    let trash = root.join("_Trash");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&trash).unwrap();
    for name in ["a.jpg", "a.jpg.xmp", "b.xmp", "c.cr2", "c.jpg", "c.xmp", "d.nef", "d.xmp"] {
        std::fs::write(trash.join(name), b"x").unwrap();
    }
    // Only c.jpg leaves while c.cr2 stays: c.xmp belongs to the RAW and stays too
    let leaving = vec![trash.join("a.jpg"), trash.join("c.jpg"), trash.join("d.nef")];
    let found = crate::files::sidecars_for_many(&leaving);
    assert_eq!(found.get(&trash.join("a.jpg")), Some(&vec![trash.join("a.jpg.xmp")]));
    assert_eq!(found.get(&trash.join("c.jpg")), None);
    assert_eq!(found.get(&trash.join("d.nef")), Some(&vec![trash.join("d.xmp")]));

    // b.xmp has no photo left; the others still have theirs
    let orphans = crate::files::orphan_trash_sidecars(&root.to_string_lossy());
    assert_eq!(orphans, vec![trash.join("b.xmp")]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn takeout_and_folder_dates() {
    use crate::exif_meta::{fallback_photo_date, takeout_photo_date};
    let root = std::env::temp_dir().join(format!("lumina-takeout-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let part1 = root.join("Takeout").join("Google Photos").join("Family");
    let part2 = root.join("Takeout").join("Google Photos (2)").join("Family");
    std::fs::create_dir_all(&part1).unwrap();
    std::fs::create_dir_all(&part2).unwrap();
    let json = |secs: u64| format!("{{\"photoTakenTime\": {{\"timestamp\": \"{secs}\"}}}}");
    // 24 Nov 2022 18:15:10 UTC
    let taken = 1_669_313_710u64;

    // Same folder, newest naming
    std::fs::write(part1.join("a.jpg"), b"x").unwrap();
    std::fs::write(part1.join("a.jpg.supplemental-metadata.json"), json(taken)).unwrap();
    // Older naming, and a "(1)" duplicate
    std::fs::write(part1.join("b(1).jpg"), b"x").unwrap();
    std::fs::write(part1.join("b.jpg(1).json"), json(taken + 60)).unwrap();
    // "-edited" uses the original's JSON
    std::fs::write(part1.join("c-edited.jpg"), b"x").unwrap();
    std::fs::write(part1.join("c.jpg.json"), json(taken + 120)).unwrap();
    // JSON in another part of the export
    std::fs::write(part1.join("d.jpg"), b"x").unwrap();
    std::fs::write(part2.join("d.jpg.supplemental-metadata.json"), json(taken + 180)).unwrap();

    for (name, offset) in [("a.jpg", 0), ("b(1).jpg", 60), ("c-edited.jpg", 120), ("d.jpg", 180)] {
        let got = takeout_photo_date(&part1.join(name)).unwrap_or_else(|| panic!("no Takeout date for {name}"));
        // Local time: within a day of the UTC moment, on the right minute
        assert!(got.starts_with("2022-11-2"), "{name}: {got}");
        let expected_min_sec = format!("{:02}:{:02}", (15 + offset / 60) % 60, 10);
        assert!(got.ends_with(&expected_min_sec), "{name}: {got}");
    }
    assert_eq!(takeout_photo_date(&part1.join("none.jpg")), None);

    // No JSON: the folder's year wins over a later file time (when the files were copied)
    let year_dir = root.join("New Zealand 2018");
    std::fs::create_dir_all(&year_dir).unwrap();
    let f = year_dir.join("beach.jpg");
    std::fs::write(&f, b"x").unwrap();
    let meta = std::fs::metadata(&f).unwrap();
    assert_eq!(fallback_photo_date(&f, Some(&meta)), "2018-01-01 00:00:00");
    // A range of years says nothing
    let range_dir = root.join("Holidays 2018-2020");
    std::fs::create_dir_all(&range_dir).unwrap();
    let g = range_dir.join("x.jpg");
    std::fs::write(&g, b"x").unwrap();
    let meta = std::fs::metadata(&g).unwrap();
    assert!(!fallback_photo_date(&g, Some(&meta)).starts_with("2018-01-01"));
    // A date in the name still comes first
    let h = year_dir.join("IMG_20190305_101010.jpg");
    std::fs::write(&h, b"x").unwrap();
    let meta = std::fs::metadata(&h).unwrap();
    assert_eq!(fallback_photo_date(&h, Some(&meta)), "2019-03-05 10:10:10");
    let _ = std::fs::remove_dir_all(&root);
}

// Which photos the next scan re-dates (read-only): LUMINA_DIAG_DB=<library.db> cargo test --lib redate_in_library -- --ignored --nocapture
#[test]
#[ignore]
fn redate_in_library() {
    let Ok(db) = std::env::var("LUMINA_DIAG_DB") else {
        eprintln!("Set LUMINA_DIAG_DB");
        return;
    };
    let conn = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT current_path, COALESCE(captured_at, '') FROM photos")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .flatten()
        .collect();
    let started = Instant::now();
    let mut changes: HashMap<String, usize> = HashMap::new();
    let mut samples: Vec<String> = Vec::new();
    for (path, captured) in &rows {
        let p = std::path::Path::new(path);
        let Ok(meta) = std::fs::metadata(p) else { continue };
        if !crate::exif_meta::is_old_creation_time_date(p, captured, &meta) {
            continue;
        }
        let new = crate::exif_meta::fallback_photo_date(p, Some(&meta));
        let source = if crate::exif_meta::takeout_photo_date(p).is_some() { "takeout json" } else { "folder year" };
        *changes.entry(format!("{source}: {} -> {}", &captured[..4.min(captured.len())], &new[..4.min(new.len())])).or_default() += 1;
        if samples.len() < 12 && (samples.len() % 2 == 0 || source == "folder year") {
            samples.push(format!("{captured} -> {new}  {path}"));
        }
    }
    eprintln!("{} photos checked in {} ms", rows.len(), started.elapsed().as_millis());
    let mut list: Vec<_> = changes.into_iter().collect();
    list.sort_by(|a, b| b.1.cmp(&a.1));
    for (k, n) in list.iter().take(25) {
        eprintln!("{n:6}  {k}");
    }
    eprintln!("total {}", list.iter().map(|x| x.1).sum::<usize>());
    for s in samples {
        eprintln!("  {s}");
    }
}

#[test]
fn whatsapp_media_by_name_and_folder() {
    use crate::imaging::is_whatsapp_media;
    use std::path::Path;
    assert!(is_whatsapp_media(Path::new(r"D:\Photos\IMG-20200313-WA0014.jpg")));
    assert!(is_whatsapp_media(Path::new(r"D:\Photos\IMG-20171127-WA0007-edited.jpg")));
    assert!(is_whatsapp_media(Path::new(r"D:\Phone\WhatsApp Images\Sent\photo.jpg")));
    assert!(!is_whatsapp_media(Path::new(r"D:\Photos\IMG_20200313_101010.jpg")));
    assert!(!is_whatsapp_media(Path::new(r"D:\Photos\HAWAII-WAVE.jpg")));
    assert!(!is_whatsapp_media(Path::new(r"D:\Photos\x-wa12.jpg")));
}

#[test]
fn screen_sized_jpeg_is_not_a_screenshot() {
    use crate::imaging::is_likely_screenshot;
    use std::path::Path;
    let img = image::DynamicImage::new_rgb8(8, 8);
    let dims = Some((1080, 1920));
    assert!(!is_likely_screenshot(Path::new("IMG-20200313-WA0014.jpg"), "", Some(&img), dims));
    assert!(is_likely_screenshot(Path::new("IMG_5107.PNG"), "", Some(&img), dims));
    assert!(is_likely_screenshot(Path::new("Screenshot_20180320-155259.jpg"), "", Some(&img), dims));
}

// ----------------- VIDEO CONTAINERS -----------------

fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    b.extend_from_slice(kind);
    b.extend_from_slice(body);
    b
}

fn test_mvhd(version: u8, created_1904: u64, timescale: u32, duration: u64) -> Vec<u8> {
    let mut b = vec![version, 0, 0, 0];
    if version == 1 {
        b.extend_from_slice(&created_1904.to_be_bytes());
        b.extend_from_slice(&created_1904.to_be_bytes());
        b.extend_from_slice(&timescale.to_be_bytes());
        b.extend_from_slice(&duration.to_be_bytes());
    } else {
        b.extend_from_slice(&(created_1904 as u32).to_be_bytes());
        b.extend_from_slice(&(created_1904 as u32).to_be_bytes());
        b.extend_from_slice(&timescale.to_be_bytes());
        b.extend_from_slice(&(duration as u32).to_be_bytes());
    }
    b.extend_from_slice(&[0u8; 80]);
    mp4_box(b"mvhd", &b)
}

// A video track: tkhd with the rotation matrix of `a, b` (16.16) and a size, hdlr 'vide', stsd with `codec`
fn test_video_trak(a: i32, b: i32, width: u32, height: u32, codec: &[u8; 4]) -> Vec<u8> {
    let mut tkhd = vec![0u8; 40];
    tkhd.extend_from_slice(&a.to_be_bytes());
    tkhd.extend_from_slice(&b.to_be_bytes());
    tkhd.extend_from_slice(&[0u8; 28]);
    tkhd.extend_from_slice(&(width << 16).to_be_bytes());
    tkhd.extend_from_slice(&(height << 16).to_be_bytes());
    let mut hdlr = vec![0u8; 8];
    hdlr.extend_from_slice(b"vide");
    hdlr.extend_from_slice(&[0u8; 12]);
    let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
    stsd.extend_from_slice(&86u32.to_be_bytes());
    stsd.extend_from_slice(codec);
    stsd.extend_from_slice(&[0u8; 78]);
    let stbl = mp4_box(b"stbl", &mp4_box(b"stsd", &stsd));
    let mdia = [mp4_box(b"hdlr", &hdlr), mp4_box(b"minf", &stbl)].concat();
    mp4_box(b"trak", &[mp4_box(b"tkhd", &tkhd), mp4_box(b"mdia", &mdia)].concat())
}

// QuickTime metadata as iPhones write it: keys + ilst with UTF-8 values
fn test_apple_meta(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut keys = vec![0u8, 0, 0, 0];
    keys.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    let mut ilst = Vec::new();
    for (i, (name, value)) in entries.iter().enumerate() {
        keys.extend_from_slice(&((name.len() + 8) as u32).to_be_bytes());
        keys.extend_from_slice(b"mdta");
        keys.extend_from_slice(name.as_bytes());
        let mut data = vec![0, 0, 0, 1, 0, 0, 0, 0];
        data.extend_from_slice(value.as_bytes());
        ilst.extend(mp4_box(&((i + 1) as u32).to_be_bytes(), &mp4_box(b"data", &data)));
    }
    let hdlr = mp4_box(b"hdlr", &[0u8; 24]);
    mp4_box(b"meta", &[hdlr, mp4_box(b"keys", &keys), mp4_box(b"ilst", &ilst)].concat())
}

#[test]
fn video_meta_reads_an_iphone_movie() {
    // 2024-04-05 15:34:38 UTC, 12.5 s, portrait (rotated 90), HEVC, Ghent, recorded at 17:34:38 local time
    let created = 1_712_331_278u64 + 2_082_844_800;
    let moov = [
        test_mvhd(0, created, 600, 7500),
        test_video_trak(0, 0x10000, 1920, 1080, b"hvc1"),
        test_apple_meta(&[
            ("com.apple.quicktime.location.ISO6709", "+51.0543+003.7174+012.000/"),
            ("com.apple.quicktime.make", "Apple"),
            ("com.apple.quicktime.model", "iPhone 13"),
            ("com.apple.quicktime.creationdate", "2024-04-05T17:34:38+0200"),
        ]),
    ]
    .concat();
    let m = video_meta::parse_moov(&moov);
    assert_eq!(m.duration_ms, Some(12_500));
    assert_eq!(m.created_utc, Some(1_712_331_278));
    assert_eq!(m.rotation, 90);
    assert_eq!((m.width, m.height), (1080, 1920));
    assert_eq!(m.codec.as_deref(), Some("hvc1"));
    assert_eq!((m.lat, m.lon), (Some(51.0543), Some(3.7174)));
    assert_eq!((m.make.as_deref(), m.model.as_deref()), (Some("Apple"), Some("iPhone 13")));
    assert_eq!(m.local_created.as_deref(), Some("2024-04-05 17:34:38"));
}

#[test]
fn video_meta_reads_version_1_headers_and_android_location() {
    let created = 1_600_000_000u64 + 2_082_844_800;
    let mut xyz = (18u16).to_be_bytes().to_vec();
    xyz.extend_from_slice(&[0x15, 0xc7]);
    xyz.extend_from_slice(b"-33.8688+151.2093/");
    let udta = mp4_box(b"udta", &mp4_box(&[0xA9, b'x', b'y', b'z'], &xyz));
    let moov = [test_mvhd(1, created, 90_000, 90_000 * 3), test_video_trak(0x10000, 0, 3840, 2160, b"avc1"), udta].concat();
    let m = video_meta::parse_moov(&moov);
    assert_eq!(m.duration_ms, Some(3000));
    assert_eq!(m.created_utc, Some(1_600_000_000));
    assert_eq!((m.rotation, m.width, m.height), (0, 3840, 2160));
    assert_eq!((m.lat, m.lon), (Some(-33.8688), Some(151.2093)));
    assert_eq!(m.local_created, None);
}

#[test]
fn video_meta_treats_a_zero_date_as_unknown() {
    let m = video_meta::parse_moov(&[test_mvhd(0, 0, 1000, 500), test_video_trak(-0x10000, 0, 640, 480, b"mp4v")].concat());
    assert_eq!(m.created_utc, None);
    assert_eq!((m.rotation, m.width, m.height), (180, 640, 480));
}

#[test]
fn iso6709_locations() {
    assert_eq!(video_meta::parse_iso6709("+51.0543+003.7174+012.000/"), Some((51.0543, 3.7174)));
    assert_eq!(video_meta::parse_iso6709("-33.8688+151.2093/"), Some((-33.8688, 151.2093)));
    assert_eq!(video_meta::parse_iso6709("+00.0000+000.0000/"), None);
    assert_eq!(video_meta::parse_iso6709("garbage"), None);
}

#[test]
fn video_meta_finds_moov_after_the_media_data() {
    let dir = std::env::temp_dir().join("lumina_video_meta_test");
    let _ = fs::create_dir_all(&dir);
    let file = dir.join("clip.mp4");
    let moov = mp4_box(b"moov", &[test_mvhd(0, 3_800_000_000, 1000, 4200), test_video_trak(0x10000, 0, 1280, 720, b"avc1")].concat());
    let data = [mp4_box(b"ftyp", b"isom\0\0\0\0"), mp4_box(b"mdat", &vec![7u8; 100_000]), moov].concat();
    fs::write(&file, data).unwrap();
    let m = video_meta::read_video_meta(&file);
    assert_eq!(m.duration_ms, Some(4200));
    assert_eq!((m.width, m.height), (1280, 720));
    let _ = fs::remove_dir_all(&dir);
}

// Reads every video in LUMINA_DIAG_DIR (dates, codecs, places) and grabs frames for a sample of each type
// into LUMINA_DIAG_OUT, with timings
#[test]
#[ignore]
fn videos_in_library() {
    let (Ok(dir), Ok(out)) = (std::env::var("LUMINA_DIAG_DIR"), std::env::var("LUMINA_DIAG_OUT")) else {
        eprintln!("Set LUMINA_DIAG_DIR and LUMINA_DIAG_OUT");
        return;
    };
    let files: Vec<PathBuf> = WalkDir::new(&dir)
        .into_iter()
        .flatten()
        .map(|e| e.into_path())
        .filter(|p| video_meta::is_video_path(p))
        .collect();
    let started = Instant::now();
    let mut codecs: HashMap<String, usize> = HashMap::new();
    let (mut dated, mut placed, mut rotated, mut camera) = (0, 0, 0, 0);
    let mut by_type: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for f in &files {
        let pass = video_meta::extract_video_pass(f);
        let meta = video_meta::read_video_meta(f);
        *codecs.entry(meta.codec.clone().unwrap_or_else(|| "-".into())).or_default() += 1;
        dated += (meta.local_created.is_some() || meta.created_utc.is_some()) as usize;
        placed += pass.lat.is_some() as usize;
        rotated += (meta.rotation != 0) as usize;
        camera += (!pass.camera_model.is_empty()) as usize;
        let ext = f.extension().unwrap().to_string_lossy().to_lowercase();
        by_type.entry(format!("{ext}/{}", meta.codec.unwrap_or_default())).or_default().push(f.clone());
    }
    eprintln!(
        "{} videos in {} ms: container date {dated}, place {placed}, rotated {rotated}, camera {camera}",
        files.len(),
        started.elapsed().as_millis()
    );
    eprintln!("codecs: {codecs:?}");
    let out = PathBuf::from(out);
    let _ = fs::create_dir_all(&out);
    for (kind, list) in by_type {
        for f in list.iter().take(3) {
            let t = Instant::now();
            let rotation = video_meta::read_video_meta(f).rotation;
            match video_frames::grab_frames(f, rotation) {
                Some(g) => {
                    let stem = f.file_stem().unwrap().to_string_lossy().to_string();
                    for (n, img) in g.frames.iter().enumerate() {
                        let _ = img.to_rgb8().save(out.join(format!("{stem}_{n}.jpg")));
                    }
                    eprintln!(
                        "{kind:12} {:40} {} frames {}x{} {} ms long, grabbed in {} ms",
                        f.file_name().unwrap().to_string_lossy(),
                        g.frames.len(),
                        g.width,
                        g.height,
                        g.duration_ms,
                        t.elapsed().as_millis()
                    );
                }
                None => eprintln!("{kind:12} {:40} NO FRAMES ({} ms)", f.file_name().unwrap().to_string_lossy(), t.elapsed().as_millis()),
            }
        }
    }
}

// ----------------- LIVE PHOTOS -----------------

fn live(stem: &str, at: &'static str, video_ms: Option<u64>) -> video_meta::LiveCandidate<'static> {
    video_meta::LiveCandidate { stem: stem.to_string(), captured_at: at, is_video: video_ms.is_some(), duration_ms: video_ms, still: video_ms.is_none() }
}

#[test]
fn live_photo_clips_pair_with_their_photo() {
    let items = [
        live("img_4368", "2025-09-12 15:25:44", None),
        live("img_4368", "2025-09-12 15:25:43", Some(2_800)),
        // Same name a year earlier (the counter wrapped): another photo
        live("img_4368", "2024-06-01 10:00:00", None),
    ];
    assert_eq!(video_meta::pair_live_photos(&items), vec![(0, 1)]);
}

#[test]
fn live_photo_needs_a_short_clip_close_in_time() {
    // A real video with the same name, or a clip minutes later, is not the photo's
    assert!(video_meta::pair_live_photos(&[live("img_1", "2025-01-01 10:00:00", None), live("img_1", "2025-01-01 10:00:01", Some(45_000))]).is_empty());
    assert!(video_meta::pair_live_photos(&[live("img_1", "2025-01-01 10:00:00", None), live("img_1", "2025-01-01 10:05:00", Some(3_000))]).is_empty());
    assert!(video_meta::pair_live_photos(&[live("img_1", "2025-01-01 10:00:00", None), live("img_2", "2025-01-01 10:00:00", Some(3_000))]).is_empty());
}

#[test]
fn live_photo_clip_in_utc_still_pairs() {
    // The clip's time came from UTC: two hours (summer time) off, to the second
    let items = [live("img_9", "2024-07-10 14:00:02", None), live("img_9", "2024-07-10 12:00:00", Some(3_000))];
    assert_eq!(video_meta::pair_live_photos(&items), vec![(0, 1)]);
    // Two hours and five minutes off is something else
    let items = [live("img_9", "2024-07-10 14:05:00", None), live("img_9", "2024-07-10 12:00:00", Some(3_000))];
    assert!(video_meta::pair_live_photos(&items).is_empty());
}

#[test]
fn date_seconds_counts_days_across_months() {
    let a = video_meta::date_seconds("2024-02-28 23:59:59").unwrap();
    let b = video_meta::date_seconds("2024-03-01 00:00:00").unwrap();
    assert_eq!(b - a, 86_400 + 1);
    assert_eq!(video_meta::date_seconds("1970-01-01 00:00:00"), Some(0));
}

#[test]
fn video_faces_remember_their_frame() {
    let id = video_frames::face_frame_id("ab12cd34ef56ab78", 3, (0.25, 0.4, 0.1, 0.1));
    assert_eq!(id, "ab12cd34ef56ab78_f3_25_40");
    assert_eq!(video_frames::frame_of_face(&id), Some(3));
    // A photo's face id has no frame
    assert_eq!(video_frames::frame_of_face("ab12cd34ef56ab78_25_40"), None);
}

// Faces in the stored frames of the library's videos (read-only): how many each frame has, and how many
// people are kept per video. Face crops go to LUMINA_DIAG_OUT.
// PowerShell: $env:LUMINA_DIAG_OUT="<folder>"; cargo test --release --lib video_faces_in_library -- --ignored --nocapture
#[test]
#[ignore]
fn video_faces_in_library() {
    let Ok(out) = std::env::var("LUMINA_DIAG_OUT") else {
        eprintln!("Set LUMINA_DIAG_OUT");
        return;
    };
    let app_dir = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap()).join("com.amazhr.lumina");
    let models = FaceModels::load(&app_dir.join("models")).expect("face models");
    let frames_dir = video_frames::frames_dir(&app_dir);
    let conn = Connection::open_with_flags(app_dir.join("library.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let hashes: Vec<String> = conn
        .prepare("SELECT hash FROM photos WHERE media_type = 'video' AND COALESCE(duration_ms, 0) > 4000 ORDER BY captured_at DESC LIMIT 40")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .flatten()
        .collect();
    let out = PathBuf::from(out);
    let _ = fs::create_dir_all(&out);
    let started = Instant::now();
    let (mut detections, mut kept) = (0, 0);
    for h in &hashes {
        let per_frame: Vec<usize> = video_frames::frame_paths(&frames_dir, h)
            .iter()
            .filter_map(|p| image::open(p).ok())
            .map(|img| models.analyze(&img).unwrap_or_default().iter().filter(|f| face_scan::is_usable_face(&img, f.detection.bbox)).count())
            .collect();
        let faces = face_scan::video_faces(&models, h, &frames_dir, &out, &[]);
        detections += per_frame.iter().sum::<usize>();
        kept += faces.len();
        eprintln!("{h}: faces per frame {per_frame:?} -> {} kept {:?}", faces.len(), faces.iter().map(|f| &f.face.face_id).collect::<Vec<_>>());
    }
    eprintln!("{} videos in {} ms: {detections} detections, {kept} faces kept", hashes.len(), started.elapsed().as_millis());
}
