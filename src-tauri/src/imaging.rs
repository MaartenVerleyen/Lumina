use crate::*;

// Identical hash to compute_fast_hash (size + first 64 KB + last 64 KB: existing DB rows stay matched),
// but also returns the file head so EXIF and dimensions can be parsed without reading the file again.
pub fn hash_and_read_head(path: &Path, file_size: u64) -> Result<(String, Vec<u8>), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let head = read_file_head(&mut file, file_size).map_err(|e| e.to_string())?;

    let mut hasher = blake3::Hasher::new();
    hasher.update(&file_size.to_le_bytes());
    hasher.update(&head[..head.len().min(65536)]);

    if file_size > 65536 * 2 {
        file.seek(SeekFrom::End(-65536)).map_err(|e| e.to_string())?;
        let mut tail = vec![0u8; 65536];
        let mut filled = 0;
        while filled < tail.len() {
            let n = file.read(&mut tail[filled..]).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        hasher.update(&tail[..filled]);
    }

    Ok((hasher.finalize().to_hex()[..16].to_string(), head))
}

pub fn compute_dhash(img: &DynamicImage) -> String {
    let gray = img.resize_exact(9, 9, FilterType::Triangle).to_luma8();
    let mut hash: u64 = 0;
    let mut bit = 0;
    for y in (0..8).step_by(2) {
        for x in 0..8 {
            if gray.get_pixel(x, y)[0] > gray.get_pixel(x + 1, y)[0] {
                hash |= 1u64 << bit;
            }
            bit += 1;
        }
    }
    for y in 0..8 {
        for x in (0..8).step_by(2) {
            if gray.get_pixel(x, y)[0] > gray.get_pixel(x, y + 1)[0] {
                hash |= 1u64 << bit;
            }
            bit += 1;
        }
    }
    format!("{:016x}", hash)
}

pub fn compute_sharpness(img: &DynamicImage) -> f64 {
    let gray = img.resize_exact(128, 128, FilterType::Triangle).to_luma8();
    let mut sum = 0.0;
    let mut sum_sq = 0.0;
    let mut count = 0.0;

    for y in 1..127 {
        for x in 1..127 {
            let c = gray.get_pixel(x, y)[0] as f64;
            let top = gray.get_pixel(x, y - 1)[0] as f64;
            let bottom = gray.get_pixel(x, y + 1)[0] as f64;
            let left = gray.get_pixel(x - 1, y)[0] as f64;
            let right = gray.get_pixel(x + 1, y)[0] as f64;

            let lap = (top + bottom + left + right - 4.0 * c).abs();
            sum += lap;
            sum_sq += lap * lap;
            count += 1.0;
        }
    }

    let mean = sum / count;
    let variance = (sum_sq / count) - (mean * mean);
    (variance * 10.0).round() / 10.0
}

// `source_dims` = the original file's pixel size; `img` may be a reduced decode (scaled JPEG or cached thumb)
// Received through WhatsApp: Android names them "IMG-20230615-WA0001.jpg" (and "VID-…-WA…"), and saved media
// lands in a "WhatsApp Images" folder. WhatsApp strips the camera's EXIF, so these hint at a forwarded photo.
pub fn is_whatsapp_media(file_path: &Path) -> bool {
    let name = file_path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let b = name.as_bytes();
    let wa_number = (0..b.len().saturating_sub(6)).any(|i| {
        &b[i..i + 3] == b"-wa" && b[i + 3..i + 7].iter().all(|c| c.is_ascii_digit())
    });
    wa_number
        || file_path
            .ancestors()
            .skip(1)
            .take(4)
            .any(|d| d.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().contains("whatsapp")))
}

// Screen resolutions of common monitors and phones (landscape or portrait)
pub const SCREEN_SIZES: &[(u32, u32)] = &[
    (1920, 1080),
    (2560, 1440),
    (3840, 2160),
    (3440, 1440),
    (1366, 768),
    (1440, 900),
    (2880, 1800),
    (1170, 2532),
    (1179, 2556),
    (1284, 2778),
    (1290, 2796),
    (1080, 2400),
    (1080, 2340),
    (1440, 3200),
];

pub fn is_likely_screenshot(
    file_path: &Path,
    camera_model: &str,
    img: Option<&DynamicImage>,
    source_dims: Option<(u32, u32)>,
) -> bool {
    let fname = file_path
        .file_name()
        .map(|f| f.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if fname.contains("screenshot")
        || fname.contains("screen shot")
        || fname.contains("schermopname")
        || fname.contains("schermafbeelding")
        || fname.contains("capture")
        || fname.contains("snip")
        || fname.starts_with("scr_")
        || (fname.starts_with("img_") && fname.ends_with(".png"))
    {
        return true;
    }

    if !camera_model.is_empty() {
        return false;
    }

    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if let Some(decoded) = img {
        let (w, h) = source_dims.unwrap_or_else(|| decoded.dimensions());
        // A screen-sized JPEG is usually a photo (WhatsApp and phones save 1080 x 1920); screenshots are PNG
        let screen_format = ext == "png" || ext == "webp";
        if screen_format && SCREEN_SIZES.iter().any(|&(sw, sh)| (w, h) == (sw, sh) || (h, w) == (sw, sh)) {
            return true;
        }
        if ext == "png" {
            let small = decoded.resize_exact(64, 64, FilterType::Nearest).to_rgb8();
            let mut flat_count = 0;
            for y in 0..64 {
                for x in 0..63 {
                    if small.get_pixel(x, y) == small.get_pixel(x + 1, y) {
                        flat_count += 1;
                    }
                }
            }
            if flat_count as f32 / (64.0 * 63.0) > 0.38 {
                return true;
            }
        }
    } else if ext == "png" && camera_model.is_empty() && fname.contains("202") {
        return true;
    }

    false
}
