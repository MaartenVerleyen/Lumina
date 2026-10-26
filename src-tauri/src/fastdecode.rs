use crate::*;

// ----------------- FAST DECODING: SCALED JPEG + IN-PROCESS WIC -----------------

// Decodes a JPEG at reduced size directly in the DCT domain (1/1, 1/2, 1/4 or 1/8): the smallest scale whose
// long edge is still at least `min_long_edge`. Visually identical at the target size, several times faster and
// a fraction of the memory of a full decode. None = not a JPEG this decoder handles (CMYK, 16-bit, corrupt);
// callers then fall back to the regular decoder.
pub fn decode_jpeg_scaled(bytes: &[u8], min_long_edge: u32) -> Option<DynamicImage> {
    let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    decoder.read_info().ok()?;
    let edge = min_long_edge.clamp(1, u16::MAX as u32) as u16;
    let (w, h) = decoder.scale(edge, edge).ok()?;
    let pixels = decoder.decode().ok()?;
    let info = decoder.info()?;
    match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => {
            image::RgbImage::from_raw(w as u32, h as u32, pixels).map(DynamicImage::ImageRgb8)
        }
        jpeg_decoder::PixelFormat::L8 => {
            image::GrayImage::from_raw(w as u32, h as u32, pixels).map(DynamicImage::ImageLuma8)
        }
        _ => None,
    }
}

// Scaled JPEG decode with EXIF orientation applied
pub fn decode_jpeg_scaled_oriented(bytes: &[u8], min_long_edge: u32) -> Option<DynamicImage> {
    let img = decode_jpeg_scaled(bytes, min_long_edge)?;
    Some(apply_exif_orientation(img, read_exif_orientation_from_bytes(bytes).unwrap_or(1)))
}

pub fn is_jpeg_ext(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg")
}

#[cfg(windows)]
mod wic {
    use super::*;
    use std::cell::RefCell;
    use windows::core::{GUID, HSTRING};
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICBitmapSource, IWICImagingFactory,
        WICBitmapDitherTypeNone, WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom,
        WICDecodeMetadataCacheOnDemand,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    thread_local! {
        // One factory per worker thread (COM is initialised once per thread, multithreaded apartment)
        static FACTORY: RefCell<Option<IWICImagingFactory>> = const { RefCell::new(None) };
    }

    fn with_factory<T>(f: impl FnOnce(&IWICImagingFactory) -> Option<T>) -> Option<T> {
        FACTORY.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                unsafe {
                    // S_FALSE / RPC_E_CHANGED_MODE just mean COM is already initialised on this thread
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                    *slot = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok();
                }
            }
            slot.as_ref().and_then(f)
        })
    }

    pub fn factory_available() -> bool {
        with_factory(|_| Some(())).is_some()
    }

    fn source_size(src: &IWICBitmapSource) -> Option<(u32, u32)> {
        let (mut w, mut h) = (0u32, 0u32);
        unsafe { src.GetSize(&mut w, &mut h) }.ok()?;
        Some((w, h))
    }

    // Decodes with Windows' own codecs (HEIC/HEIF via the HEIF extension, damaged JPEGs, ...) inside this
    // process: no PowerShell start-up per file. Pixels are returned as stored (no EXIF rotation applied).
    // With `allow_embedded_thumb` a codec-provided thumbnail of at least 200 px is used when it suffices.
    pub fn decode(path: &Path, max_dim: u32, allow_embedded_thumb: bool) -> Option<DynamicImage> {
        with_factory(|factory| unsafe {
            let decoder = factory
                .CreateDecoderFromFilename(
                    &HSTRING::from(path.as_os_str()),
                    None,
                    GENERIC_READ,
                    WICDecodeMetadataCacheOnDemand,
                )
                .ok()?;
            let frame = decoder.GetFrame(0).ok()?;
            let frame_src: IWICBitmapSource = frame.clone().into();

            let mut src: IWICBitmapSource = frame_src;
            if allow_embedded_thumb {
                if let Ok(thumb) = frame.GetThumbnail() {
                    if let Some((tw, th)) = source_size(&thumb) {
                        // An embedded thumbnail is only used when it is at least as big as requested
                        if tw.max(th) >= max_dim {
                            src = thumb;
                        }
                    }
                }
            }

            let (w, h) = source_size(&src)?;
            if w == 0 || h == 0 {
                return None;
            }
            if w.max(h) > max_dim {
                let scale = max_dim as f64 / w.max(h) as f64;
                let (nw, nh) = (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1));
                let scaler = factory.CreateBitmapScaler().ok()?;
                scaler.Initialize(&src, nw, nh, WICBitmapInterpolationModeFant).ok()?;
                src = scaler.into();
            }

            let converter = factory.CreateFormatConverter().ok()?;
            let rgba: GUID = GUID_WICPixelFormat32bppRGBA;
            converter
                .Initialize(&src, &rgba, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
                .ok()?;
            let (cw, ch) = source_size(&converter.clone().into())?;
            let stride = cw * 4;
            let mut buf = vec![0u8; (stride * ch) as usize];
            converter.CopyPixels(std::ptr::null(), stride, &mut buf).ok()?;
            image::RgbaImage::from_raw(cw, ch, buf).map(|img| DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(img).to_rgb8()))
        })
    }
}

// In-process WIC decode (Windows only). See wic::decode.
pub fn wic_decode(path: &Path, max_dim: u32, allow_embedded_thumb: bool) -> Option<DynamicImage> {
    #[cfg(windows)]
    {
        wic::decode(path, max_dim, allow_embedded_thumb)
    }
    #[cfg(not(windows))]
    {
        let _ = (path, max_dim, allow_embedded_thumb);
        None
    }
}

pub fn wic_available() -> bool {
    #[cfg(windows)]
    {
        wic::factory_available()
    }
    #[cfg(not(windows))]
    {
        false
    }
}
