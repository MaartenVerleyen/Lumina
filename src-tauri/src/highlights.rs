use crate::*;

// Highlights: the best N photos of a set (a trip, an album, a year, whatever is shown), for quality and
// variety. The app scores each photo from what it knows (rating, pick, eyes, focus, people: utils/highlights.ts);
// this adds how attractive the photo looks to CLIP and chooses with maximal marginal relevance, so the picks
// aren't ten shots of the same moment.

#[derive(Deserialize, Clone)]
pub struct HighlightCandidate {
    pub hash: String,
    // The app's score (higher is better)
    pub base: f64,
    // Burst / near-duplicate group: never two from one group
    pub group: Option<i64>,
    // Capture time (Unix seconds), for spreading the picks over the event
    pub time: Option<f64>,
}

// What makes a photo look good or bad to CLIP; the difference is the "aesthetic" score
const LOOKS_GOOD: [&str; 3] = [
    "a beautiful photo",
    "a stunning professional photograph with lovely light",
    "a happy moment captured perfectly",
];
const LOOKS_BAD: [&str; 4] = [
    "a blurry photo",
    "a dark, badly lit snapshot",
    "a boring photo of nothing in particular",
    "a screenshot or a photo of a document",
];
const AESTHETIC_WEIGHT: f64 = 1.5;
// Redundancy with the photos already picked: near-identical (CLIP) or taken within minutes of each other
const SIMILAR_FROM: f32 = 0.78;
const MINUTES_APART: f64 = 10.0;
const TIME_WEIGHT: f64 = 3.0;

// Picks up to `count` photos: each step takes the photo with the best score minus how much it repeats an
// earlier pick. Returns them in the order they were taken (oldest first).
pub fn select_highlights(
    candidates: &[HighlightCandidate],
    vectors: &HashMap<String, Vec<f32>>,
    aesthetic: &HashMap<String, f64>,
    count: usize,
) -> Vec<String> {
    let score = |c: &HighlightCandidate| c.base + AESTHETIC_WEIGHT * aesthetic.get(&c.hash).copied().unwrap_or(0.0);
    let mut remaining: Vec<&HighlightCandidate> = candidates.iter().collect();
    let mut picked: Vec<&HighlightCandidate> = Vec::new();
    while picked.len() < count && !remaining.is_empty() {
        let redundancy = |c: &HighlightCandidate| -> f64 {
            picked
                .iter()
                .map(|p| {
                    if c.group.is_some() && c.group == p.group {
                        return f64::INFINITY;
                    }
                    let look = match (vectors.get(&c.hash), vectors.get(&p.hash)) {
                        (Some(a), Some(b)) => ((face_match::dot(a, b) - SIMILAR_FROM).max(0.0) / (1.0 - SIMILAR_FROM)) as f64 * 3.0,
                        _ => 0.0,
                    };
                    let time = match (c.time, p.time) {
                        (Some(a), Some(b)) => TIME_WEIGHT * (-(a - b).abs() / 60.0 / MINUTES_APART).exp(),
                        _ => 0.0,
                    };
                    look.max(time)
                })
                .fold(0.0, f64::max)
        };
        let (best_i, best_value) = remaining
            .iter()
            .enumerate()
            .map(|(i, c)| (i, score(c) - redundancy(c)))
            .fold((usize::MAX, f64::NEG_INFINITY), |a, b| if b.1 > a.1 { b } else { a });
        if best_i == usize::MAX || best_value == f64::NEG_INFINITY {
            break;
        }
        picked.push(remaining.remove(best_i));
    }
    picked.sort_by(|a, b| a.time.unwrap_or(f64::MAX).total_cmp(&b.time.unwrap_or(f64::MAX)));
    picked.into_iter().map(|c| c.hash.clone()).collect()
}

// Aesthetic score per photo, standardised within the set (so it's "nicer than the others here"), clamped
fn aesthetic_scores(clip: &clip::ClipModels, vectors: &HashMap<String, Vec<f32>>) -> HashMap<String, f64> {
    let embed = |texts: &[&str]| -> Option<Vec<f32>> {
        let all: Vec<Vec<f32>> = texts.iter().filter_map(|t| clip.embed_text(t).ok()).collect();
        (!all.is_empty()).then(|| (0..all[0].len()).map(|i| all.iter().map(|v| v[i]).sum::<f32>() / all.len() as f32).collect())
    };
    let (Some(good), Some(bad)) = (embed(&LOOKS_GOOD), embed(&LOOKS_BAD)) else {
        return HashMap::new();
    };
    let raw: Vec<(String, f64)> = vectors
        .iter()
        .map(|(h, v)| (h.clone(), (face_match::dot(v, &good) - face_match::dot(v, &bad)) as f64))
        .collect();
    let n = raw.len().max(1) as f64;
    let mean = raw.iter().map(|r| r.1).sum::<f64>() / n;
    let sd = (raw.iter().map(|r| (r.1 - mean).powi(2)).sum::<f64>() / n).sqrt().max(1e-6);
    raw.into_iter().map(|(h, s)| (h, ((s - mean) / sd).clamp(-2.0, 2.0))).collect()
}

#[tauri::command]
pub async fn pick_highlights(app: AppHandle, candidates: Vec<HighlightCandidate>, count: usize) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_global_db(&app)?;
        let hashes: Vec<String> = candidates.iter().map(|c| c.hash.clone()).collect();
        // Without the smart search index, quality and time spread still decide
        let vectors = clip::clip_vectors(&conn, &hashes);
        let aesthetic = clip::clip_models_if_present(&get_models_dir(&app))
            .map(|clip| aesthetic_scores(&clip, &vectors))
            .unwrap_or_default();
        Ok(select_highlights(&candidates, &vectors, &aesthetic, count))
    })
    .await
    .map_err(|e| e.to_string())?
}
