use crate::*;

// ----------------- FACE MATCHING v2: PROFILES, EXCLUSIVE ASSIGNMENT, CLUSTERING -----------------
// Shared by the app's suggestions (get_pending_face_match_counts / find_similar_faces) and the face_eval
// benchmark, so the measured numbers are the app's numbers.

// More references than this add little but cost time; the most diverse ones are kept
pub const MAX_REFERENCES: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ScoreMethod {
    // 0.55 * best reference + 0.45 * centroid (the original scoring)
    BestPlusCentroid,
    // 0.6 * mean of the 3 best references + 0.4 * centroid. Measured worse (lower recall, no fewer errors);
    // kept only so face_eval can show the comparison.
    #[allow(dead_code)]
    Top3PlusCentroid,
}

pub const SCORE_METHOD: ScoreMethod = ScoreMethod::BestPlusCentroid;

// Chosen with face_eval (10-person set, 2026-10-26): at T=0.50 exclusive assignment kept recall at 96-99% with
// 0% wrong people and 0% strangers for every margin tested (0-0.08); 0.05 guards against look-alikes in
// larger libraries at no measured cost. The "top 3" score lowered recall without fewer errors, so it is unused.
pub const FACE_ASSIGN_MARGIN: f32 = 0.05;
pub const MAX_SUGGESTIONS_PER_PERSON: usize = 300;
// Clustering at 0.40 gave pure clusters with 99% of each person's photos in one cluster; 0.35 was perfect on
// the test set but merges become likelier as a library holds more people. A split cluster is harmless
// (name both parts the same); a merged one would put two people under one name.
pub const CLUSTER_SIMILARITY: f32 = 0.40;

pub struct PersonProfile {
    pub refs: Vec<Vec<f32>>,
    pub centroid: Vec<f32>,
    // Faces the user rejected for this person: a candidate closer to these than to the person is not suggested
    pub negatives: Vec<Vec<f32>>,
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

// Keeps up to `max` references that cover the person's variety (k-center / farthest-point selection),
// starting from the one closest to the centroid
pub fn select_diverse(refs: Vec<Vec<f32>>, max: usize) -> Vec<Vec<f32>> {
    if refs.len() <= max {
        return refs;
    }
    let Some(centroid) = compute_normalized_centroid(&refs, refs[0].len()) else {
        return refs.into_iter().take(max).collect();
    };
    let first = (0..refs.len())
        .max_by(|&a, &b| dot(&refs[a], &centroid).partial_cmp(&dot(&refs[b], &centroid)).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(0);
    let mut chosen = vec![first];
    // Similarity of every reference to its closest chosen reference
    let mut closest: Vec<f32> = refs.iter().map(|r| dot(r, &refs[first])).collect();
    while chosen.len() < max {
        let next = (0..refs.len())
            .filter(|i| !chosen.contains(i))
            .min_by(|&a, &b| closest[a].partial_cmp(&closest[b]).unwrap_or(std::cmp::Ordering::Equal));
        let Some(next) = next else { break };
        chosen.push(next);
        for (i, c) in closest.iter_mut().enumerate() {
            *c = c.max(dot(&refs[i], &refs[next]));
        }
    }
    chosen.into_iter().map(|i| refs[i].clone()).collect()
}

pub fn build_profile(refs: Vec<Vec<f32>>, negatives: Vec<Vec<f32>>) -> Option<PersonProfile> {
    let refs: Vec<Vec<f32>> = refs.into_iter().filter(|r| r.len() == 512).collect();
    if refs.is_empty() {
        return None;
    }
    let centroid = compute_normalized_centroid(&refs, 512)?;
    Some(PersonProfile { refs: select_diverse(refs, MAX_REFERENCES), centroid, negatives })
}

pub fn profile_score(cand: &[f32], profile: &PersonProfile, method: ScoreMethod) -> f32 {
    let centroid_sim = dot(cand, &profile.centroid);
    match method {
        ScoreMethod::BestPlusCentroid => {
            let best = profile.refs.iter().map(|r| dot(cand, r)).fold(f32::MIN, f32::max);
            0.55 * best + 0.45 * centroid_sim
        }
        ScoreMethod::Top3PlusCentroid => {
            let mut sims: Vec<f32> = profile.refs.iter().map(|r| dot(cand, r)).collect();
            sims.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
            let k = sims.len().min(3);
            let top = sims[..k].iter().sum::<f32>() / k as f32;
            0.6 * top + 0.4 * centroid_sim
        }
    }
}

// Is this candidate closer to a face the user rejected for this person than to the person?
fn looks_like_a_rejection(cand: &[f32], profile: &PersonProfile, score: f32) -> bool {
    profile.negatives.iter().any(|n| dot(cand, n) > score)
}

pub struct Assignment {
    pub person: usize,
    pub score: f32,
}

// Exclusive assignment: the candidate goes to its single best-scoring person, only when that score clears
// `min_score`, beats the runner-up by `margin` (ambiguous faces are not suggested to anyone), and the face
// doesn't look more like one of that person's rejected faces.
pub fn assign_face(
    cand: &[f32],
    profiles: &[PersonProfile],
    method: ScoreMethod,
    min_score: f32,
    margin: f32,
) -> Option<Assignment> {
    let mut best: Option<(usize, f32)> = None;
    let mut second = f32::MIN;
    for (i, p) in profiles.iter().enumerate() {
        let s = profile_score(cand, p, method);
        match best {
            Some((_, b)) if s <= b => second = second.max(s),
            _ => {
                if let Some((_, b)) = best {
                    second = second.max(b);
                }
                best = Some((i, s));
            }
        }
    }
    let (person, score) = best?;
    if score < min_score || score - second < margin || looks_like_a_rejection(cand, &profiles[person], score) {
        return None;
    }
    Some(Assignment { person, score })
}

// ----------------- CLUSTERING UNKNOWN FACES ("Who is this?") -----------------

// Chinese Whispers on the graph of face pairs with similarity >= `threshold` (each face linked to at most
// `max_neighbors` nearest faces). Returns a cluster label per face; faces without neighbours get their own.
pub fn cluster_faces(embeddings: &[Vec<f32>], threshold: f32, max_neighbors: usize) -> Vec<usize> {
    let n = embeddings.len();
    // Neighbour lists in parallel (the O(n^2) part: ~1 s for 10k faces on 12 threads)
    let neighbors: Vec<Vec<(usize, f32)>> = (0..n)
        .into_par_iter()
        .map(|i| {
            let mut near: Vec<(usize, f32)> = (0..n)
                .filter(|&j| j != i)
                .map(|j| (j, dot(&embeddings[i], &embeddings[j])))
                .filter(|(_, s)| *s >= threshold)
                .collect();
            near.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            near.truncate(max_neighbors);
            near
        })
        .collect();

    let mut labels: Vec<usize> = (0..n).collect();
    // Deterministic node order (a fixed pseudo-random permutation) so results are reproducible
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by_key(|&i| (i.wrapping_mul(2654435761)) % n.max(1));
    for _ in 0..20 {
        let mut changed = false;
        for &i in &order {
            if neighbors[i].is_empty() {
                continue;
            }
            let mut weight: HashMap<usize, f32> = HashMap::new();
            for &(j, s) in &neighbors[i] {
                *weight.entry(labels[j]).or_default() += s;
            }
            let best = weight
                .into_iter()
                .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal).then(b.0.cmp(&a.0)))
                .map(|(label, _)| label)
                .unwrap_or(labels[i]);
            if best != labels[i] {
                labels[i] = best;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    labels
}
