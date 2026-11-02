use crate::*;

// Numbers the temporary files of Windows Imaging Component decodes, so parallel ones never collide
static WIC_COUNTER: AtomicUsize = AtomicUsize::new(1);

pub fn read_exif_orientation_from_bytes(bytes: &[u8]) -> Option<u32> {
    let mut cursor = Cursor::new(bytes);
    let exifreader = Reader::new();
    if let Ok(exif) = exifreader.read_from_container(&mut cursor) {
        if let Some(field) = exif
            .get_field(Tag::Orientation, exif::In::PRIMARY)
            .or_else(|| exif.get_field(Tag::Orientation, exif::In::THUMBNAIL))
            .or_else(|| exif.fields().find(|f| f.tag == Tag::Orientation))
        {
            if let Some(v) = field.value.get_uint(0) {
                if (1..=8).contains(&v) {
                    return Some(v);
                }
            }
        }
    }
    None
}

pub fn read_exif_orientation(file_path: &Path) -> u32 {
    if let Ok(file) = File::open(file_path) {
        let mut bufreader = BufReader::new(file);
        let exifreader = Reader::new();
        if let Ok(exif) = exifreader.read_from_container(&mut bufreader) {
            if let Some(field) = exif
                .get_field(Tag::Orientation, exif::In::PRIMARY)
                .or_else(|| exif.fields().find(|f| f.tag == Tag::Orientation))
            {
                if let Some(v) = field.value.get_uint(0) {
                    if (1..=8).contains(&v) {
                        return v;
                    }
                }
            }
        }
    }
    1
}

pub fn apply_exif_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

pub fn is_raw_or_heic_ext(ext: &str) -> bool {
    matches!(
        ext,
        "cr2" | "cr3" | "nef" | "arw" | "dng" | "orf" | "rw2" | "heic" | "heif" | "pef" | "raf"
    )
}


// Two-tier embedded JPEG extractor for Camera RAW (.CR2, .CR3, .NEF, .ARW, .DNG, .ORF, .RW2):
// - `prefer_fast_thumb = true`: reads only the first 4MB and targets the medium preview (300px..=1620px) for ~1.5ms thumbnailing!
// - `prefer_fast_thumb = false`: reads up to 48MB and targets the largest full-resolution embedded JPEG for Loupe/Compare!
pub const RAW_THUMB_READ_BYTES: usize = 6 * 1024 * 1024;
const RAW_FULL_READ_BYTES: usize = 36 * 1024 * 1024;

pub fn extract_embedded_raw_jpeg_sized(
    file_path: &Path,
    prefer_fast_thumb: bool,
) -> Option<(DynamicImage, u32)> {
    let mut file = File::open(file_path).ok()?;
    let file_len = file.metadata().ok()?.len();
    if file_len < 8192 {
        return None;
    }

    let max_read = if prefer_fast_thumb { RAW_THUMB_READ_BYTES } else { RAW_FULL_READ_BYTES };
    let buffer = read_file_prefix(&mut file, max_read).ok()?;
    let outer_orientation = read_exif_orientation(file_path);
    // Full-size requests only need enough pixels for a 1920px preview / face input, not 24+ MP
    let min_edge = if prefer_fast_thumb { THUMB_EDGE } else { 2048 };

    if let Some(found) = extract_embedded_raw_jpeg_from_bytes(&buffer, prefer_fast_thumb, outer_orientation, min_edge) {
        return Some(found);
    }
    if prefer_fast_thumb && file_len > RAW_THUMB_READ_BYTES as u64 {
        return extract_embedded_raw_jpeg_sized(file_path, false);
    }
    None
}

// Reads up to `max` bytes from the current position (loops: a single read() may return less)
pub fn read_file_prefix(file: &mut File, max: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(max.min(64 * 1024 * 1024));
    file.take(max as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

// Finds and decodes the best embedded JPEG preview inside RAW file bytes. `min_long_edge` lets large
// previews decode directly at reduced size (DCT scaling) when that is all the caller needs.
pub fn extract_embedded_raw_jpeg_from_bytes(
    slice: &[u8],
    prefer_fast_thumb: bool,
    outer_orientation: u32,
    min_long_edge: u32,
) -> Option<(DynamicImage, u32)> {
    let mut candidates: Vec<(usize, usize, u32, u32)> = Vec::new();
    let mut i = 0;
    let limit = slice.len().saturating_sub(4);

    while i < limit {
        // Look for valid JPEG SOI followed by APP0/APP1/DQT/SOF
        if slice[i] == 0xFF
            && slice[i + 1] == 0xD8
            && slice[i + 2] == 0xFF
            && matches!(slice[i + 3], 0xE0 | 0xE1 | 0xDB | 0xC0 | 0xC2 | 0xEE)
        {
            let start = i;
            // Walk JPEG segments to find SOF dimensions and EOI (FF D9) cleanly
            let mut cursor = start + 2;
            let mut found_dims: Option<(u32, u32)> = None;
            let mut end_pos: Option<usize> = None;

            while cursor + 4 < slice.len() {
                if slice[cursor] != 0xFF {
                    break;
                }
                let marker = slice[cursor + 1];
                if marker == 0xFF {
                    cursor += 1;
                    continue;
                }
                if marker == 0xD9 {
                    end_pos = Some(cursor + 2);
                    break;
                }
                if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
                    cursor += 2;
                    continue;
                }
                let seg_len = ((slice[cursor + 2] as usize) << 8) | (slice[cursor + 3] as usize);
                if seg_len < 2 || cursor + 2 + seg_len > slice.len() {
                    break;
                }
                if matches!(marker, 0xC0 | 0xC1 | 0xC2) && seg_len >= 7 {
                    let h = ((slice[cursor + 5] as u32) << 8) | (slice[cursor + 6] as u32);
                    let w = ((slice[cursor + 7] as u32) << 8) | (slice[cursor + 8] as u32);
                    if w >= 200 && h >= 200 {
                        found_dims = Some((w, h));
                    }
                }
                cursor += 2 + seg_len;
                if marker == 0xDA {
                    // Inside SOS entropy stream: scan forward to the first real EOI (FF D9)
                    let mut scan = cursor;
                    while scan + 1 < slice.len() {
                        if slice[scan] == 0xFF && slice[scan + 1] == 0xD9 {
                            end_pos = Some(scan + 2);
                            break;
                        }
                        scan += 1;
                    }
                    break;
                }
            }

            if let (Some((w, h)), Some(end)) = (found_dims, end_pos) {
                if end > start + 8192 {
                    candidates.push((start, end, w, h));
                    // Fast exit: for a thumbnail, the first preview of thumbnail size up to 2048 px will do
                    if prefer_fast_thumb && w.max(h) >= THUMB_EDGE && w <= 2048 {
                        break;
                    }
                    i = end;
                    continue;
                }
            }
        }
        i += 1;
    }

    if prefer_fast_thumb {
        candidates.sort_by_key(|&(_, _, w, h)| {
            let max_d = w.max(h);
            if (320..=1920).contains(&max_d) { 0 } else { 1 }
        });
    } else {
        candidates.sort_by(|a, b| (b.2 * b.3).cmp(&(a.2 * a.3)));
    }

    for (s, e, cw, ch) in candidates.into_iter().take(4) {
        let jpeg_slice = &slice[s..e];
        // Big previews (e.g. a full 6000px embedded JPEG) decode straight to the needed size
        let scaled = if cw.max(ch) >= min_long_edge * 2 {
            decode_jpeg_scaled(jpeg_slice, min_long_edge)
        } else {
            None
        };
        let decoded = scaled.or_else(|| image::load_from_memory_with_format(jpeg_slice, ImageFormat::Jpeg).ok());
        if let Some(img) = decoded {
            let (w, h) = img.dimensions();
            let embedded_orient = read_exif_orientation_from_bytes(jpeg_slice);
            let final_orient = match embedded_orient {
                Some(o) if o != 1 => o,
                _ => {
                    if h > w && matches!(outer_orientation, 5 | 6 | 7 | 8) {
                        1
                    } else {
                        outer_orientation
                    }
                }
            };
            return Some((img, final_orient));
        }
    }

    None
}

#[cfg(target_os = "windows")]
pub fn batch_decode_heic_thumbs_windows(jobs: &[(String, String, u32)]) {
    if jobs.is_empty() {
        return;
    }
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let seq = WIC_COUNTER.fetch_add(1, Ordering::Relaxed);
    let manifest_path = std::env::temp_dir().join(format!(
        "lumina_wic_thumbs_{}_{}.json",
        std::process::id(),
        seq
    ));

    let json_items: Vec<JsonValue> = jobs
        .iter()
        .map(|(src, dst, max_dim)| json!({ "src": src, "dst": dst, "dim": max_dim }))
        .collect();

    if fs::write(&manifest_path, serde_json::to_string(&json_items).unwrap_or_default()).is_err() {
        return;
    }

    let manifest_escaped = manifest_path.to_string_lossy().replace('\'', "''");
    let ps_script = format!(
        r#"$ErrorActionPreference = 'Stop';
Add-Type -AssemblyName PresentationCore;
Add-Type -AssemblyName WindowsBase;
$rawJson = Get-Content -Raw -LiteralPath '{manifest}' | ConvertFrom-Json;
$items = @($rawJson);
foreach ($it in $items) {{
  $s = $null; $o = $null;
  try {{
    $s = [System.IO.File]::Open($it.src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite);
    $d = [System.Windows.Media.Imaging.BitmapDecoder]::Create($s, [System.Windows.Media.Imaging.BitmapCreateOptions]::IgnoreColorProfile, [System.Windows.Media.Imaging.BitmapCacheOption]::OnDemand);
    $frame = $d.Frames[0];
    $angle = 0;
    try {{
      $meta = $frame.Metadata;
      if ($meta -ne $null -and $meta.ContainsQuery('/app1/ifd/{{ushort=274}}')) {{
        $orient = $meta.GetQuery('/app1/ifd/{{ushort=274}}');
        if ($orient -eq 6) {{ $angle = 90 }} elseif ($orient -eq 3) {{ $angle = 180 }} elseif ($orient -eq 8) {{ $angle = 270 }}
      }}
    }} catch {{}}
    $targetThumb = $frame.Thumbnail;
    $srcBmp = if ($targetThumb -ne $null -and $it.dim -le 360 -and [Math]::Max($targetThumb.PixelWidth, $targetThumb.PixelHeight) -ge 200) {{ $targetThumb }} else {{ $frame }};
    $pw = $srcBmp.PixelWidth; $ph = $srcBmp.PixelHeight;
    $maxDim = [Math]::Max($pw, $ph);
    $scale = if ($maxDim -gt $it.dim) {{ [double]$it.dim / $maxDim }} else {{ 1.0 }};
    $tg = New-Object System.Windows.Media.TransformGroup;
    if ($scale -lt 1.0) {{ $tg.Children.Add((New-Object System.Windows.Media.ScaleTransform($scale, $scale))) }};
    if ($angle -ne 0) {{ $tg.Children.Add((New-Object System.Windows.Media.RotateTransform($angle))) }};
    $bmp = if ($tg.Children.Count -gt 0) {{ New-Object System.Windows.Media.Imaging.TransformedBitmap($srcBmp, $tg) }} else {{ $srcBmp }};
    $e = New-Object System.Windows.Media.Imaging.JpegBitmapEncoder;
    $e.QualityLevel = 85;
    $e.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bmp));
    $o = [System.IO.File]::Create($it.dst);
    $e.Save($o);
  }} catch {{
  }} finally {{
    if ($o -ne $null) {{ try {{ $o.Close() }} catch {{}} }}
    if ($s -ne $null) {{ try {{ $s.Close() }} catch {{}} }}
  }}
}}"#,
        manifest = manifest_escaped
    );

    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Sta", "-Command", &ps_script])
        .creation_flags(CREATE_NO_WINDOW)
        .status();

    let _ = fs::remove_file(&manifest_path);
}

#[cfg(not(target_os = "windows"))]
pub fn batch_decode_heic_thumbs_windows(_jobs: &[(String, String, u32)]) {}

#[cfg(target_os = "windows")]
pub fn decode_via_windows_wic(file_path: &Path, max_dim: u32) -> Option<(DynamicImage, u32)> {
    // In-process WIC (≈25 ms for a HEIC thumbnail) instead of starting PowerShell (≈0.5-1.8 s per call).
    // WIC returns pixels as stored: JPEGs still need their EXIF rotation, HEIC comes out upright.
    if let Some(img) = wic_decode(file_path, max_dim, max_dim <= THUMB_EDGE) {
        let ext = file_path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let orientation = if is_jpeg_ext(&ext) { read_exif_orientation(file_path) } else { 1 };
        return Some((img, orientation));
    }
    if wic_available() {
        // The same codecs back the PowerShell route, so it would fail too
        return None;
    }

    let seq = WIC_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_jpg = std::env::temp_dir().join(format!(
        "lumina_wic_single_{}_{}.jpg",
        std::process::id(),
        seq
    ));

    let jobs = vec![(
        file_path.to_string_lossy().to_string(),
        tmp_jpg.to_string_lossy().to_string(),
        max_dim,
    )];
    batch_decode_heic_thumbs_windows(&jobs);

    if tmp_jpg.exists() {
        let bytes = fs::read(&tmp_jpg).ok()?;
        let _ = fs::remove_file(&tmp_jpg);
        let img = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg).ok()?;
        return Some((img, 1));
    }
    let _ = fs::remove_file(&tmp_jpg);
    None
}

// Other systems decode HEIC with ffmpeg (the server's Docker image includes it); it comes out upright
#[cfg(not(target_os = "windows"))]
pub fn decode_via_windows_wic(file_path: &Path, max_dim: u32) -> Option<(DynamicImage, u32)> {
    decode_with_ffmpeg(&crate::ffmpeg::system_ffmpeg()?, file_path, max_dim).map(|img| (img, 1))
}

// A still image (HEIC/HEIF, AVIF) decoded by ffmpeg, its long edge scaled down to `max_dim` (never up).
// ffmpeg applies the image's rotation itself.
pub fn decode_with_ffmpeg(ffmpeg: &Path, file_path: &Path, max_dim: u32) -> Option<DynamicImage> {
    let scale = format!("scale='min(iw,{max_dim})':'min(ih,{max_dim})':force_original_aspect_ratio=decrease");
    let out = crate::ffmpeg::ffmpeg_command(ffmpeg)
        .arg("-i")
        .arg(file_path)
        .args(["-frames:v", "1", "-vf", &scale, "-f", "image2pipe", "-c:v", "png", "-"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    image::load_from_memory_with_format(&out.stdout, ImageFormat::Png).ok()
}

// Large camera JPEGs (≥ ~1.5 MB) decode via DCT scaling when only `min_edge` pixels are needed; smaller ones
// stay on `image`'s faster full decoder (scaling gains little there and the scaled decoder is stricter).
const SCALED_JPEG_MIN_BYTES: usize = 1_500_000;

// Decodes in-memory image bytes, oriented. `image` rejects damaged files (e.g. truncated progressive JPEGs
// from interrupted downloads) that Windows' own decoder still renders from the data that is present.
// Returns (image, recovered_from_damaged_file).
fn decode_bytes_or_recover(
    file_path: &Path,
    bytes: &[u8],
    min_edge: u32,
) -> Result<(DynamicImage, bool), String> {
    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if is_jpeg_ext(&ext) && bytes.len() >= SCALED_JPEG_MIN_BYTES {
        if let Some(img) = decode_jpeg_scaled_oriented(bytes, min_edge) {
            return Ok((img, false));
        }
    }
    match image::load_from_memory(bytes) {
        Ok(img) => Ok((apply_exif_orientation(img, read_exif_orientation_from_bytes(bytes).unwrap_or(1)), false)),
        Err(e) => match decode_via_windows_wic(file_path, min_edge.max(THUMB_EDGE)) {
            Some((img, orient)) => Ok((apply_exif_orientation(img, orient), true)),
            None => Err(e.to_string()),
        },
    }
}

fn decode_standard_or_recover(file_path: &Path, min_edge: u32) -> Result<(DynamicImage, bool), String> {
    let bytes = fs::read(file_path).map_err(|e| e.to_string())?;
    decode_bytes_or_recover(file_path, &bytes, min_edge)
}

// What a thumbnail reader thread loads for the decoders: RAW only needs its first 6 MB (embedded
// previews live there), HEIC is opened by WIC itself (None).
pub fn read_for_thumb(path: &Path) -> Option<Vec<u8>> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext == "heic" || ext == "heif" {
        return None;
    }
    let mut file = File::open(path).ok()?;
    let max = if is_raw_or_heic_ext(&ext) { RAW_THUMB_READ_BYTES } else { usize::MAX };
    read_file_prefix(&mut file, max).ok()
}

// Thumbnail-ready image from bytes already read by `read_for_thumb` (falls back to reading the file).
// Returns (image, file was damaged and only partially recovered).
pub fn decode_for_thumb(path: &Path, bytes: Option<&[u8]>) -> Result<(DynamicImage, bool), String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let Some(bytes) = bytes else {
        return open_and_orient_image_for_thumb(path);
    };
    if is_raw_or_heic_ext(&ext) {
        let outer = read_exif_orientation_from_bytes(bytes).unwrap_or(1);
        if let Some((img, orient)) = extract_embedded_raw_jpeg_from_bytes(bytes, true, outer, THUMB_EDGE) {
            return Ok((apply_exif_orientation(img, orient), false));
        }
        // Preview beyond the first 6 MB, or a RAW codec via WIC
        return open_and_orient_image_for_thumb(path);
    }
    decode_bytes_or_recover(path, bytes, THUMB_EDGE)
}

// Returns (thumbnail-ready image, file was damaged and only partially recovered)
pub fn open_and_orient_image_for_thumb(file_path: &Path) -> Result<(DynamicImage, bool), String> {
    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if is_raw_or_heic_ext(&ext) {
        if ext != "heic" && ext != "heif" {
            // Fast 4MB medium-preview extraction for RAW thumbnails!
            if let Some((raw_preview, orient)) = extract_embedded_raw_jpeg_sized(file_path, true) {
                return Ok((apply_exif_orientation(raw_preview, orient), false));
            }
        }
        // Fast thumbnail-size WIC decode for HEIC
        if let Some((wic_img, orient)) = decode_via_windows_wic(file_path, THUMB_EDGE) {
            return Ok((apply_exif_orientation(wic_img, orient), false));
        }
        if let Some((heic_preview, orient)) = extract_embedded_raw_jpeg_sized(file_path, true) {
            return Ok((apply_exif_orientation(heic_preview, orient), false));
        }
    }

    decode_standard_or_recover(file_path, THUMB_EDGE)
}

// ~1920 px is plenty for previews, face detection/crops and AI input; big JPEGs decode straight to it
pub fn open_and_orient_image(file_path: &Path) -> Result<DynamicImage, String> {
    open_and_orient_image_sized(file_path, 1920)
}

// Oriented image whose long edge is at least `min_edge` where the source allows (RAW previews and big
// JPEGs decode directly near that size; HEIC is decoded by WIC at that size)
pub fn open_and_orient_image_sized(file_path: &Path, min_edge: u32) -> Result<DynamicImage, String> {
    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if is_raw_or_heic_ext(&ext) {
        if ext != "heic" && ext != "heif" {
            if let Some((raw_preview, orient)) = extract_embedded_raw_jpeg_sized(file_path, false) {
                return Ok(apply_exif_orientation(raw_preview, orient));
            }
        }
        if let Some((wic_img, orient)) = decode_via_windows_wic(file_path, min_edge) {
            return Ok(apply_exif_orientation(wic_img, orient));
        }
        if let Some((heic_preview, orient)) = extract_embedded_raw_jpeg_sized(file_path, false) {
            return Ok(apply_exif_orientation(heic_preview, orient));
        }
    }

    decode_standard_or_recover(file_path, min_edge).map(|(img, _)| img)
}

// The 1920px preview for RAW & HEIC, made on demand when a photo is viewed in Loupe / Compare
pub fn ensure_high_res_preview(host: &dyn Host, hash: &str, source_path: &str) -> Result<String, String> {
    let app = host;
    let previews_dir = get_app_storage_dir(app).join("previews");
    let _ = fs::create_dir_all(&previews_dir);
    let preview_file = previews_dir.join(format!("{}_preview.jpg", hash));

    if preview_file.exists() && preview_file.metadata().map(|m| m.len() > 1024).unwrap_or(false) {
        return Ok(preview_file.to_string_lossy().to_string());
    }

    let preview_started = Instant::now();
    let src = Path::new(source_path);
    let img = open_and_orient_image(src)?;
    let decode_ms = elapsed_ms(preview_started);
    let (w, h) = img.dimensions();
    let scaled = if w > 1920 || h > 1920 {
        img.thumbnail(1920, 1920)
    } else {
        img
    };
    scaled
        .to_rgb8()
        .save(&preview_file)
        .map_err(|e| e.to_string())?;

    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_uppercase())
        .unwrap_or_default();
    emit_perf(
        app,
        &format!("1920px preview ({ext})"),
        preview_started,
        1,
        format!("decode {decode_ms} ms · source {w}x{h}"),
    );

    Ok(preview_file.to_string_lossy().to_string())
}
