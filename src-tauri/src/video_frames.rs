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
    use windows::core::{GUID, HSTRING};
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
            let stride = current.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|s| s as i32).unwrap_or(w as i32 * 4);
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
                let Some(img) = read_frame(&reader, video, w, h, stride) else { break };
                let img = if display_w != w { img.resize_exact(display_w, h, image::imageops::FilterType::Triangle) } else { img };
                frames.push(img);
            }
            (!frames.is_empty()).then_some((frames, duration_ms, (display_w, h)))
        }
    }

    // The next decoded frame after a seek (the reader skips the stream ticks that carry no picture)
    unsafe fn read_frame(reader: &IMFSourceReader, video: u32, w: u32, h: u32, stride: i32) -> Option<DynamicImage> {
        for _ in 0..64 {
            let mut flags = 0u32;
            let mut sample: Option<IMFSample> = None;
            unsafe { reader.ReadSample(video, 0, None, Some(&mut flags), None, Some(&mut sample)) }.ok()?;
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                return None;
            }
            let Some(sample) = sample else { continue };
            let buffer = unsafe { sample.ConvertToContiguousBuffer() }.ok()?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            let mut len = 0u32;
            unsafe { buffer.Lock(&mut ptr, None, Some(&mut len)) }.ok()?;
            let row_bytes = stride.unsigned_abs() as usize;
            let needed = row_bytes * h as usize;
            let img = if ptr.is_null() || (len as usize) < needed || row_bytes < w as usize * 4 {
                None
            } else {
                let data = unsafe { std::slice::from_raw_parts(ptr, needed) };
                let mut rgb = image::RgbImage::new(w, h);
                for y in 0..h as usize {
                    // A negative stride means the rows are stored bottom-up
                    let src_row = if stride < 0 { h as usize - 1 - y } else { y };
                    let row = &data[src_row * row_bytes..src_row * row_bytes + w as usize * 4];
                    for (x, px) in row.chunks_exact(4).enumerate() {
                        rgb.put_pixel(x as u32, y as u32, image::Rgb([px[2], px[1], px[0]]));
                    }
                }
                Some(DynamicImage::ImageRgb8(rgb))
            };
            let _ = unsafe { buffer.Unlock() };
            return img;
        }
        None
    }
}
