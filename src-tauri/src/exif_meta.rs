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
}

// Single-Pass Header & EXIF Reader: extracts dimensions, orientation, GPS, date & telemetry
pub fn extract_all_exif_single_pass(file_path: &Path) -> FullExifPass {
    extract_all_exif_with_head(file_path, None)
}

// Same, but parses from `head` (the file's first bytes, already read for hashing) when that is enough;
// only falls back to reading the file for formats whose header/EXIF lies beyond the head (some RAW/HEIC).
pub fn extract_all_exif_with_head(file_path: &Path, head: Option<&[u8]>) -> FullExifPass {
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
        if let Ok(meta) = fs::metadata(file_path) {
            if let Ok(ctime) = meta.created().or_else(|_| meta.modified()) {
                date_str = format_system_time_iso(ctime);
            }
        }
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
