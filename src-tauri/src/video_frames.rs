// Still frames from videos, decoded by Windows' own codecs through Media Foundation (the HEVC extension and
// the GPU's decoder included): the grid thumbnail and a few frames across the video that smart search and the
// face scan look at. Frames live in `frames/{hash}_{n}.jpg`, next to the thumbnails.
use crate::*;

// Long edge of a stored frame: enough for CLIP (224) and for faces of people at a few metres
pub const FRAME_EDGE: u32 = 640;

// Where in the video the frames are taken (fractions of its length). Short clips get fewer: each seek in
// HEVC decodes from the previous key frame, about half a second per frame for an iPhone video.
const FRAME_POSITIONS: [f64; 5] = [0.05, 0.25, 0.45, 0.65, 0.85];

fn positions_for(duration_ms: u64) -> &'static [f64] {
    match duration_ms {
        0..2_000 => &[0.3],
        2_000..10_000 => &[0.15, 0.5, 0.85],
        _ => &FRAME_POSITIONS,
    }
}

pub fn frames_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("frames")
}

pub fn frame_path(frames_dir: &Path, hash: &str, n: usize) -> PathBuf {
    frames_dir.join(format!("{hash}_{n}.jpg"))
}

// The frames written for a video, in order (stops at the first missing one)
pub fn frame_paths(frames_dir: &Path, hash: &str) -> Vec<PathBuf> {
    (0..FRAME_POSITIONS.len()).map(|n| frame_path(frames_dir, hash, n)).take_while(|p| p.exists()).collect()
}

// A face found in a video carries its frame in its id: "{hash}_f{frame}_{x}_{y}"
pub fn face_frame_id(hash: &str, frame: usize, bbox: (f64, f64, f64, f64)) -> String {
    format!("{hash}_f{frame}_{}_{}", (bbox.0 * 100.0).round() as i32, (bbox.1 * 100.0).round() as i32)
}

pub fn frame_of_face(face_id: &str) -> Option<usize> {
    let rest = face_id.split_once("_f")?.1;
    rest.split('_').next()?.parse().ok()
}

// Frames made before the decoder's padded rows were read correctly can be skewed (2026-11-01). They are made
// again once: the frames go, with the smart search vectors taken from them, and the next thumbnail pass
// writes new frames and thumbnails. Returns whether it happened.
const FRAMES_VERSION: &str = "2";

pub fn refresh_outdated_frames(frames_dir: &Path, conn: &Connection) -> bool {
    let marker = frames_dir.join("version");
    if fs::read_to_string(&marker).ok().as_deref() == Some(FRAMES_VERSION) {
        return false;
    }
    let _ = fs::create_dir_all(frames_dir);
    for entry in fs::read_dir(frames_dir).into_iter().flatten().flatten() {
        if entry.path().extension().is_some_and(|e| e == "jpg") {
            let _ = fs::remove_file(entry.path());
        }
    }
    let _ = conn.execute("DELETE FROM photo_clip_frames", []);
    crate::clip::forget_frame_vectors();
    let _ = fs::write(&marker, FRAMES_VERSION);
    true
}

pub fn delete_frames(frames_dir: &Path, hash: &str) {
    for n in 0..FRAME_POSITIONS.len() {
        let _ = fs::remove_file(frame_path(frames_dir, hash, n));
    }
}

pub struct GrabbedFrames {
    pub frames: Vec<DynamicImage>,
    // Displayed size of the video (pixel aspect and rotation applied)
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
}

// A frame that is almost black (fade-in, lens cap) makes a poor thumbnail
fn mean_luma(img: &DynamicImage) -> f64 {
    let small = img.thumbnail(32, 32).to_luma8();
    let n = small.pixels().len().max(1) as f64;
    small.pixels().map(|p| p.0[0] as f64).sum::<f64>() / n
}

pub fn thumbnail_frame(frames: &[DynamicImage]) -> Option<&DynamicImage> {
    frames.iter().find(|f| mean_luma(f) >= 20.0).or(frames.first())
}

fn rotate(img: DynamicImage, degrees: u32) -> DynamicImage {
    match degrees {
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => img,
    }
}

// Decodes the frames of `path`, turned upright by `rotation` (from the container) and scaled to FRAME_EDGE
pub fn grab_frames(path: &Path, rotation: u32) -> Option<GrabbedFrames> {
    #[cfg(windows)]
    {
        let (raw, duration_ms, (w, h)) = mf::grab(path)?;
        let frames: Vec<DynamicImage> = raw
            .into_iter()
            .map(|f| rotate(f.thumbnail(FRAME_EDGE, FRAME_EDGE), rotation))
            .collect();
        let (width, height) = if rotation == 90 || rotation == 270 { (h, w) } else { (w, h) };
        Some(GrabbedFrames { frames, width, height, duration_ms })
    }
    #[cfg(not(windows))]
    {
        let _ = (path, rotation);
        None
    }
}

#[cfg(windows)]
mod mf {
    use super::*;
    use std::cell::Cell;
    use std::sync::Once;
    use windows::core::{Interface, GUID, HSTRING};
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    static STARTUP: Once = Once::new();

    thread_local! {
        static COM_READY: Cell<bool> = const { Cell::new(false) };
    }

    fn ensure_started() {
        STARTUP.call_once(|| unsafe {
            let _ = MFStartup(MF_VERSION, MFSTARTUP_LITE);
        });
        COM_READY.with(|ready| {
            if !ready.get() {
                // S_FALSE / RPC_E_CHANGED_MODE just mean COM is already initialised on this thread
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                ready.set(true);
            }
        });
    }

    // One decoded frame per position (see positions_for) with square pixels, the length in ms and the
    // displayed size before rotation
    pub fn grab(path: &Path) -> Option<(Vec<DynamicImage>, u64, (u32, u32))> {
        ensure_started();
        unsafe {
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 1).ok()?;
            let attrs = attrs?;
            // Lets the reader convert whatever the decoder produces (NV12, P010, ...) to RGB32
            attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1).ok()?;
            let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path.as_os_str()), &attrs).ok()?;

            let video = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
            let _ = reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false);
            reader.SetStreamSelection(video, true).ok()?;
            let wanted = MFCreateMediaType().ok()?;
            wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).ok()?;
            wanted.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).ok()?;
            reader.SetCurrentMediaType(video, None, &wanted).ok()?;

            let current = reader.GetCurrentMediaType(video).ok()?;
            let size = current.GetUINT64(&MF_MT_FRAME_SIZE).ok()?;
            let (w, h) = ((size >> 32) as u32, size as u32);
            if w == 0 || h == 0 {
                return None;
            }
            // HDV and DV store non-square pixels (1440 x 1080 shown as 1920 x 1080)
            let (par_n, par_d) = current
                .GetUINT64(&MF_MT_PIXEL_ASPECT_RATIO)
                .ok()
                .map(|v| ((v >> 32) as u32, v as u32))
                .filter(|&(n, d)| n > 0 && d > 0)
                .unwrap_or((1, 1));
            let display_w = (w as u64 * par_n as u64 / par_d as u64) as u32;

            let duration_100ns = reader
                .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
                .ok()
                .and_then(|pv| u64::try_from(&pv).ok())
                .unwrap_or(0);
            let duration_ms = duration_100ns / 10_000;
            let positions = positions_for(duration_ms);

            let mut frames = Vec::with_capacity(positions.len());
            for &fraction in positions {
                if duration_100ns > 0 {
                    let pos = PROPVARIANT::from((duration_100ns as f64 * fraction) as i64);
                    if reader.SetCurrentPosition(&GUID::zeroed(), &pos).is_err() && !frames.is_empty() {
                        break;
                    }
                }
                let Some(img) = read_frame(&reader, video, (w, h)) else { break };
                let img = if display_w != w { img.resize_exact(display_w, h, image::imageops::FilterType::Triangle) } else { img };
                frames.push(img);
            }
            (!frames.is_empty()).then_some((frames, duration_ms, (display_w, h)))
        }
    }

    // BGRX rows to an RGB image. `first_row` is the top row of the picture; `pitch` the distance in bytes from
    // one row to the next (negative for pictures stored bottom-up). Decoders pad rows: a 478 px wide frame is
    // stored in rows of 480 px, so the pitch must come from the decoder, never from the width.
    unsafe fn copy_rows(first_row: *const u8, pitch: isize, w: u32, h: u32) -> Option<DynamicImage> {
        if first_row.is_null() || pitch.unsigned_abs() < w as usize * 4 {
            return None;
        }
        let mut rgb = image::RgbImage::new(w, h);
        for y in 0..h as usize {
            let row = unsafe { std::slice::from_raw_parts(first_row.offset(y as isize * pitch), w as usize * 4) };
            for (x, px) in row.chunks_exact(4).enumerate() {
                rgb.put_pixel(x as u32, y as u32, image::Rgb([px[2], px[1], px[0]]));
            }
        }
        Some(DynamicImage::ImageRgb8(rgb))
    }

    // The visible area of a frame of `frame` size: the display aperture when the decoder states one (a 478 x 850
    // video is decoded into 480 x 864), else the picture size the reader first reported, at the top left
    unsafe fn visible_area(media: &IMFMediaType, frame: (u32, u32), first: (u32, u32)) -> (u32, u32, u32, u32) {
        let mut blob = [0u8; 16];
        let aperture = unsafe { media.GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, &mut blob, None) }.ok().map(|_| {
            let x = i16::from_le_bytes([blob[2], blob[3]]).max(0) as u32;
            let y = i16::from_le_bytes([blob[6], blob[7]]).max(0) as u32;
            let cx = i32::from_le_bytes(blob[8..12].try_into().unwrap_or_default()).max(0) as u32;
            let cy = i32::from_le_bytes(blob[12..16].try_into().unwrap_or_default()).max(0) as u32;
            (x, y, cx, cy)
        });
        match aperture {
            Some((x, y, cx, cy)) if cx > 0 && cy > 0 && x + cx <= frame.0 && y + cy <= frame.1 => (x, y, cx, cy),
            _ => (0, 0, first.0.min(frame.0), first.1.min(frame.1)),
        }
    }

    // The next decoded frame after a seek (the reader skips the stream ticks that carry no picture), cropped to
    // its visible area. The size, stride and aperture are read for every frame: once decoding starts the reader
    // may switch to the decoder's padded size (MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED).
    unsafe fn read_frame(reader: &IMFSourceReader, video: u32, first: (u32, u32)) -> Option<DynamicImage> {
        let img = unsafe { read_full_frame(reader, video) }?;
        let media = unsafe { reader.GetCurrentMediaType(video) }.ok()?;
        let (x, y, cw, ch) = unsafe { visible_area(&media, (img.width(), img.height()), first) };
        Some(if (x, y, cw, ch) == (0, 0, img.width(), img.height()) { img } else { img.crop_imm(x, y, cw, ch) })
    }

    unsafe fn read_full_frame(reader: &IMFSourceReader, video: u32) -> Option<DynamicImage> {
        for _ in 0..64 {
            let mut flags = 0u32;
            let mut sample: Option<IMFSample> = None;
            unsafe { reader.ReadSample(video, 0, None, Some(&mut flags), None, Some(&mut sample)) }.ok()?;
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                return None;
            }
            let Some(sample) = sample else { continue };
            let media = unsafe { reader.GetCurrentMediaType(video) }.ok()?;
            let size = unsafe { media.GetUINT64(&MF_MT_FRAME_SIZE) }.ok()?;
            let (w, h) = ((size >> 32) as u32, size as u32);
            if w == 0 || h == 0 {
                return None;
            }
            let stride = unsafe { media.GetUINT32(&MF_MT_DEFAULT_STRIDE) }.ok().map(|s| s as i32);
            let buffer = unsafe { sample.GetBufferByIndex(0) }.or_else(|_| unsafe { sample.ConvertToContiguousBuffer() }).ok()?;
            // A 2D buffer knows its own pitch and where the top row starts
            if let Ok(buffer2d) = buffer.cast::<IMF2DBuffer>() {
                let mut first_row: *mut u8 = std::ptr::null_mut();
                let mut pitch = 0i32;
                unsafe { buffer2d.Lock2D(&mut first_row, &mut pitch) }.ok()?;
                let img = unsafe { copy_rows(first_row, pitch as isize, w, h) };
                let _ = unsafe { buffer2d.Unlock2D() };
                return img;
            }
            // Otherwise the media type's stride, or the buffer length divided over the rows
            let mut ptr: *mut u8 = std::ptr::null_mut();
            let mut len = 0u32;
            unsafe { buffer.Lock(&mut ptr, None, Some(&mut len)) }.ok()?;
            let stride = stride.unwrap_or_else(|| (len / h.max(1)) as i32);
            let row_bytes = stride.unsigned_abs() as usize;
            let img = if ptr.is_null() || (len as usize) < row_bytes * h as usize {
                None
            } else if stride < 0 {
                // Stored bottom-up: the top row is the last one in memory
                unsafe { copy_rows(ptr.add(row_bytes * (h as usize - 1)), stride as isize, w, h) }
            } else {
                unsafe { copy_rows(ptr, stride as isize, w, h) }
            };
            let _ = unsafe { buffer.Unlock() };
            return img;
        }
        None
    }
}
