use crate::*;

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
pub fn extract_embedded_raw_jpeg_sized(
    file_path: &Path,
    prefer_fast_thumb: bool,
) -> Option<(DynamicImage, u32)> {
    let mut file = File::open(file_path).ok()?;
    let file_len = file.metadata().ok()?.len();
    if file_len < 8192 {
        return None;
    }

    let max_read = if prefer_fast_thumb {
        6 * 1024 * 1024
    } else {
        36 * 1024 * 1024
    };
    let read_size = (file_len as usize).min(max_read);
    let mut buffer = vec![0u8; read_size];
    let bytes_read = file.read(&mut buffer).ok()?;
    let slice = &buffer[..bytes_read];

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
                    // Fast exit: if we only need a 360px thumb and found a 300..2000px preview, decode immediately!
                    if prefer_fast_thumb && w >= 300 && w <= 2048 {
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

    let outer_orientation = read_exif_orientation(file_path);

    for (s, e, _, _) in candidates.into_iter().take(4) {
        let jpeg_slice = &slice[s..e];
        if let Ok(img) = image::load_from_memory_with_format(jpeg_slice, ImageFormat::Jpeg) {
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

    if prefer_fast_thumb && file_len > 6 * 1024 * 1024 {
        return extract_embedded_raw_jpeg_sized(file_path, false);
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

#[cfg(not(target_os = "windows"))]
pub fn decode_via_windows_wic(_file_path: &Path, _max_dim: u32) -> Option<(DynamicImage, u32)> {
    None
}

pub fn open_and_orient_image_for_thumb(file_path: &Path) -> Result<DynamicImage, String> {
    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if is_raw_or_heic_ext(&ext) {
        if ext != "heic" && ext != "heif" {
            // Fast 4MB medium-preview extraction for RAW thumbnails!
            if let Some((raw_preview, orient)) = extract_embedded_raw_jpeg_sized(file_path, true) {
                return Ok(apply_exif_orientation(raw_preview, orient));
            }
        }
        // Fast 360px WIC thumbnail extraction for HEIC
        if let Some((wic_img, orient)) = decode_via_windows_wic(file_path, 360) {
            return Ok(apply_exif_orientation(wic_img, orient));
        }
        if let Some((heic_preview, orient)) = extract_embedded_raw_jpeg_sized(file_path, true) {
            return Ok(apply_exif_orientation(heic_preview, orient));
        }
    }

    let reader = image::ImageReader::open(file_path).map_err(|e| e.to_string())?;
    let reader_guessed = reader.with_guessed_format().map_err(|e| e.to_string())?;
    let img = reader_guessed.decode().map_err(|e| e.to_string())?;
    let orientation = read_exif_orientation(file_path);
    Ok(apply_exif_orientation(img, orientation))
}

pub fn open_and_orient_image(file_path: &Path) -> Result<DynamicImage, String> {
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
        if let Some((wic_img, orient)) = decode_via_windows_wic(file_path, 1920) {
            return Ok(apply_exif_orientation(wic_img, orient));
        }
        if let Some((heic_preview, orient)) = extract_embedded_raw_jpeg_sized(file_path, false) {
            return Ok(apply_exif_orientation(heic_preview, orient));
        }
    }

    let reader = image::ImageReader::open(file_path).map_err(|e| e.to_string())?;
    let reader_guessed = reader.with_guessed_format().map_err(|e| e.to_string())?;
    let img = reader_guessed.decode().map_err(|e| e.to_string())?;
    let orientation = read_exif_orientation(file_path);
    Ok(apply_exif_orientation(img, orientation))
}


// On-Demand 1920px High-Res Preview Generator for RAW & HEIC (only called when viewing a photo in Loupe / Compare!)
#[tauri::command]
pub async fn ensure_high_res_preview(
    app: AppHandle,
    hash: String,
    source_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let previews_dir = get_app_storage_dir(&app).join("previews");
        let _ = fs::create_dir_all(&previews_dir);
        let preview_file = previews_dir.join(format!("{}_preview.jpg", hash));

        if preview_file.exists() && preview_file.metadata().map(|m| m.len() > 1024).unwrap_or(false) {
            return Ok(preview_file.to_string_lossy().to_string());
        }

        let preview_started = Instant::now();
        let src = Path::new(&source_path);
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
            &app,
            &format!("1920px preview ({ext})"),
            preview_started,
            1,
            format!("decode {decode_ms} ms · source {w}x{h}"),
        );

        Ok(preview_file.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
