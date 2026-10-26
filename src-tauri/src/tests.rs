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
