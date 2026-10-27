// Smart search's "good enough" line, as in src-tauri/src/clip.rs: CLIP scores shift per query (a broad query
// lifts every photo), so keep the photos in the top part of the spread between the median and the best match.
// Tuned on 1,800 library photos (2026-10-26).
const SPREAD_FRACTION = 0.6;
const ABSOLUTE_FLOOR = 0.12;
export const SEMANTIC_MAX_HITS = 1000;

// `scores` sorted best first
export function semanticCutoff(scores: number[]): number {
  if (scores.length === 0) return ABSOLUTE_FLOOR;
  const top = scores[0];
  const median = scores[Math.floor(scores.length / 2)];
  return Math.max(ABSOLUTE_FLOOR, median + SPREAD_FRACTION * (top - median));
}
