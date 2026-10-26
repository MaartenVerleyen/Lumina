use crate::*;
use ort::session::Session;
use ort::value::Tensor;

// ----------------- FACE ENGINE v2: SCRFD + ALIGNED ARCFACE ON ONNX RUNTIME -----------------
// Detector: SCRFD det_10g at 640x640 (letterboxed, never squashed) with 5 facial landmarks.
// Embedder: ArcFace w600k_r50 on 112x112 crops aligned to the standard ArcFace template.
// Runs on the GPU through DirectML when available (≈3 ms per photo + ≈3 ms per face on an RTX 5070 Ti),
// otherwise on the CPU with the same models, so embeddings never depend on the device.
// Pre/post-processing follows InsightFace's reference implementation (scrfd.py, arcface_onnx.py, face_align.py).

// Stored with every embedding: vectors from different engines must never be compared
pub const FACE_ENGINE_V2: &str = "scrfd10g-arcface_r50-aligned-v1";

pub const DETECTOR_FILE: &str = "det_10g.onnx";
pub const EMBEDDER_FILE: &str = "w600k_r50.onnx";
// SHA-256 of the files in InsightFace's official buffalo_l release (v0.7)
pub const DETECTOR_SHA256: &str = "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91";
pub const EMBEDDER_SHA256: &str = "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43";

const DET_SIZE: usize = 640;
const DET_SCORE_THRESHOLD: f32 = 0.5;
const DET_NMS_IOU: f64 = 0.4;
const STRIDES: [usize; 3] = [8, 16, 32];
const ANCHORS_PER_CELL: usize = 2;

// Where the five landmarks (eyes, nose tip, mouth corners) sit in a 112x112 ArcFace input
const ARCFACE_TEMPLATE: [(f32, f32); 5] = [
    (38.2946, 51.6963),
    (73.5318, 51.5014),
    (56.0252, 71.7366),
    (41.5493, 92.3655),
    (70.7299, 92.2041),
];

pub struct FaceModels {
    detector: Mutex<Session>,
    embedder: Mutex<Session>,
    pub device: String,
}

#[derive(Clone, Debug)]
pub struct Detection {
    // Normalized (x, y, w, h) in the oriented source image
    pub bbox: (f64, f64, f64, f64),
    pub score: f32,
    // Pixel coordinates in the source image: left eye, right eye, nose, left mouth, right mouth
    pub landmarks: [(f32, f32); 5],
}

pub struct FaceV2 {
    pub detection: Detection,
    pub aligned: image::RgbImage,
    pub embedding: Vec<f32>,
}

static ORT_ENV: LazyLock<Option<ort::environment::Environment>> =
    LazyLock::new(|| ort::init().with_name("lumina").build().ok());

fn build_session(path: &Path, gpu: bool) -> Result<Session, String> {
    let env = ORT_ENV.as_ref().ok_or("ONNX Runtime could not be initialised")?;
    let mut builder = Session::builder(env).map_err(|e| e.to_string())?;
    if gpu {
        // DirectML requires these two settings (see ONNX Runtime's DirectML EP documentation)
        builder = builder
            .with_memory_pattern(false)
            .map_err(|e| e.to_string())?
            .with_parallel_execution(false)
            .map_err(|e| e.to_string())?
            .with_execution_providers([ort::ep::DirectML::default().build().error_on_failure()])
            .map_err(|e| e.to_string())?;
    } else {
        let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(4).max(1);
        builder = builder.with_intra_threads(threads).map_err(|e| e.to_string())?;
    }
    builder.commit_from_file(path).map_err(|e| e.to_string())
}

impl FaceModels {
    // GPU (DirectML) first, CPU as fallback; both models must load on the same device
    pub fn load(models_dir: &Path) -> Result<FaceModels, String> {
        let det = models_dir.join(DETECTOR_FILE);
        let emb = models_dir.join(EMBEDDER_FILE);
        let gpu = build_session(&det, true).and_then(|d| build_session(&emb, true).map(|e| (d, e)));
        let (detector, embedder, device) = match gpu {
            Ok((d, e)) => (d, e, "GPU (DirectML)".to_string()),
            Err(gpu_err) => {
                let d = build_session(&det, false)?;
                let e = build_session(&emb, false)?;
                (d, e, format!("CPU (GPU unavailable: {gpu_err})"))
            }
        };
        let models = FaceModels { detector: Mutex::new(detector), embedder: Mutex::new(embedder), device };
        // First DirectML run compiles shaders (~1-2 s): do it now, not on the user's first photo
        let warm = image::RgbImage::new(320, 240);
        let _ = models.detect(&DynamicImage::ImageRgb8(warm));
        let _ = models.embed(&[image::RgbImage::new(112, 112)]);
        Ok(models)
    }

    pub fn detect(&self, img: &DynamicImage) -> Result<Vec<Detection>, String> {
        let (src_w, src_h) = img.dimensions();
        if src_w < 16 || src_h < 16 {
            return Ok(Vec::new());
        }
        // Letterbox: scale to fit 640x640 keeping the aspect ratio, top-left aligned, black padding
        let scale = (DET_SIZE as f32 / src_w as f32).min(DET_SIZE as f32 / src_h as f32);
        let (new_w, new_h) = (((src_w as f32 * scale).round() as u32).max(1), ((src_h as f32 * scale).round() as u32).max(1));
        let resized = img.resize_exact(new_w, new_h, FilterType::Triangle).to_rgb8();
        let plane = DET_SIZE * DET_SIZE;
        // (x - 127.5) / 128, RGB, NCHW; padding = (0 - 127.5) / 128
        let mut input = vec![-127.5f32 / 128.0; 3 * plane];
        for (x, y, px) in resized.enumerate_pixels() {
            let i = y as usize * DET_SIZE + x as usize;
            for c in 0..3 {
                input[c * plane + i] = (px[c] as f32 - 127.5) / 128.0;
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, DET_SIZE, DET_SIZE], input)).map_err(|e| e.to_string())?;

        let mut session = self.detector.lock().map_err(|_| "face detector lock poisoned")?;
        let outputs = session.run(ort::inputs![tensor]).map_err(|e| e.to_string())?;

        // Outputs come as 3 score maps, 3 box maps, 3 landmark maps; identify them by shape
        let mut by_shape: HashMap<(usize, usize), Vec<f32>> = HashMap::new();
        for (_, value) in outputs.iter() {
            let (shape, data) = value.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            if shape.len() == 2 {
                by_shape.insert((shape[0] as usize, shape[1] as usize), data.to_vec());
            }
        }
        drop(outputs);
        drop(session);

        let mut found: Vec<Detection> = Vec::new();
        for stride in STRIDES {
            let cells = DET_SIZE / stride;
            let n = cells * cells * ANCHORS_PER_CELL;
            let (Some(scores), Some(boxes), Some(kps)) = (by_shape.get(&(n, 1)), by_shape.get(&(n, 4)), by_shape.get(&(n, 10))) else {
                return Err(format!("unexpected detector outputs for stride {stride}"));
            };
            for i in 0..n {
                let score = scores[i];
                if score < DET_SCORE_THRESHOLD {
                    continue;
                }
                let cell = i / ANCHORS_PER_CELL;
                let (ax, ay) = (((cell % cells) * stride) as f32, ((cell / cells) * stride) as f32);
                let s = stride as f32;
                let (x1, y1) = (ax - boxes[i * 4] * s, ay - boxes[i * 4 + 1] * s);
                let (x2, y2) = (ax + boxes[i * 4 + 2] * s, ay + boxes[i * 4 + 3] * s);
                let mut landmarks = [(0f32, 0f32); 5];
                for (k, lm) in landmarks.iter_mut().enumerate() {
                    *lm = ((ax + kps[i * 10 + k * 2] * s) / scale, (ay + kps[i * 10 + k * 2 + 1] * s) / scale);
                }
                // Back to source pixels, clipped, then normalized
                let (x1, y1) = ((x1 / scale).max(0.0), (y1 / scale).max(0.0));
                let (x2, y2) = ((x2 / scale).min(src_w as f32), (y2 / scale).min(src_h as f32));
                if x2 <= x1 || y2 <= y1 {
                    continue;
                }
                found.push(Detection {
                    bbox: (
                        x1 as f64 / src_w as f64,
                        y1 as f64 / src_h as f64,
                        (x2 - x1) as f64 / src_w as f64,
                        (y2 - y1) as f64 / src_h as f64,
                    ),
                    score,
                    landmarks,
                });
            }
        }

        // Non-maximum suppression
        found.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        let mut kept: Vec<Detection> = Vec::new();
        for d in found {
            if kept.iter().all(|k| bbox_iou(k.bbox, d.bbox) <= DET_NMS_IOU) {
                kept.push(d);
            }
        }
        Ok(kept)
    }

    // 512-D L2-normalized embeddings for aligned 112x112 faces. One face per run: the model's output is
    // declared as [1, 512], and batching several faces fails on DirectML (≈3-7 ms per face on the GPU anyway).
    pub fn embed(&self, faces: &[image::RgbImage]) -> Result<Vec<Vec<f32>>, String> {
        let plane = 112 * 112;
        let mut session = self.embedder.lock().map_err(|_| "face embedder lock poisoned")?;
        let mut embeddings = Vec::with_capacity(faces.len());
        for face in faces {
            let mut input = vec![0f32; 3 * plane];
            for (x, y, px) in face.enumerate_pixels() {
                let i = y as usize * 112 + x as usize;
                for c in 0..3 {
                    // (x - 127.5) / 127.5, RGB, NCHW
                    input[c * plane + i] = (px[c] as f32 - 127.5) / 127.5;
                }
            }
            let tensor = Tensor::from_array(([1usize, 3, 112, 112], input)).map_err(|e| e.to_string())?;
            let outputs = session.run(ort::inputs![tensor]).map_err(|e| e.to_string())?;
            let (_, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let norm = data.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
            embeddings.push(data.iter().map(|x| x / norm).collect());
        }
        Ok(embeddings)
    }

    // Detect, align and embed every face in the image
    pub fn analyze(&self, img: &DynamicImage) -> Result<Vec<FaceV2>, String> {
        let detections = self.detect(img)?;
        if detections.is_empty() {
            return Ok(Vec::new());
        }
        let rgb = img.to_rgb8();
        let aligned: Vec<image::RgbImage> = detections.iter().map(|d| align_face(&rgb, &d.landmarks)).collect();
        let embeddings = self.embed(&aligned)?;
        Ok(detections
            .into_iter()
            .zip(aligned)
            .zip(embeddings)
            .map(|((detection, aligned), embedding)| FaceV2 { detection, aligned, embedding })
            .collect())
    }
}

// Least-squares similarity transform (rotation + uniform scale + translation) mapping `src` onto `dst`.
// In 2D this has a closed form (complex-number regression); same result as Umeyama without reflection.
// Returns (a, b, tx, ty) for x' = a*x - b*y + tx, y' = b*x + a*y + ty.
pub fn similarity_transform(src: &[(f32, f32); 5], dst: &[(f32, f32); 5]) -> (f32, f32, f32, f32) {
    let n = src.len() as f32;
    let (msx, msy) = (src.iter().map(|p| p.0).sum::<f32>() / n, src.iter().map(|p| p.1).sum::<f32>() / n);
    let (mdx, mdy) = (dst.iter().map(|p| p.0).sum::<f32>() / n, dst.iter().map(|p| p.1).sum::<f32>() / n);
    let (mut num_a, mut num_b, mut den) = (0f32, 0f32, 0f32);
    for (s, d) in src.iter().zip(dst) {
        let (sx, sy) = (s.0 - msx, s.1 - msy);
        let (dx, dy) = (d.0 - mdx, d.1 - mdy);
        num_a += dx * sx + dy * sy;
        num_b += dy * sx - dx * sy;
        den += sx * sx + sy * sy;
    }
    let den = den.max(1e-6);
    let (a, b) = (num_a / den, num_b / den);
    (a, b, mdx - (a * msx - b * msy), mdy - (b * msx + a * msy))
}

// Warps the face onto the 112x112 ArcFace template (bilinear sampling, black outside the photo)
pub fn align_face(img: &image::RgbImage, landmarks: &[(f32, f32); 5]) -> image::RgbImage {
    let (a, b, tx, ty) = similarity_transform(landmarks, &ARCFACE_TEMPLATE);
    // Inverse of [a -b; b a] is [a b; -b a] / (a^2 + b^2)
    let det = (a * a + b * b).max(1e-9);
    let (w, h) = (img.width() as f32, img.height() as f32);
    let mut out = image::RgbImage::new(112, 112);
    for (u, v, px) in out.enumerate_pixels_mut() {
        let (du, dv) = (u as f32 - tx, v as f32 - ty);
        let sx = (a * du + b * dv) / det;
        let sy = (-b * du + a * dv) / det;
        if sx < 0.0 || sy < 0.0 || sx > w - 1.0 || sy > h - 1.0 {
            continue;
        }
        let (x0, y0) = (sx.floor() as u32, sy.floor() as u32);
        let (x1, y1) = ((x0 + 1).min(img.width() - 1), (y0 + 1).min(img.height() - 1));
        let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
        let (p00, p10, p01, p11) = (img.get_pixel(x0, y0), img.get_pixel(x1, y0), img.get_pixel(x0, y1), img.get_pixel(x1, y1));
        for c in 0..3 {
            let top = p00[c] as f32 * (1.0 - fx) + p10[c] as f32 * fx;
            let bottom = p01[c] as f32 * (1.0 - fx) + p11[c] as f32 * fx;
            px[c] = (top * (1.0 - fy) + bottom * fy).round() as u8;
        }
    }
    out
}
