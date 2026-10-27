// Culling signals from the face scan: closed eyes and a soft (out of focus) main face, and a "best of the
// burst" score that uses them. Pure functions; the thresholds come from the eye_calibration test (tests.rs).

export type CheckLevel = "off" | "normal" | "high";

export interface CullingSettings {
  eyes: CheckLevel;
  focus: CheckLevel;
}

export interface CullingFace {
  bbox_w: number;
  bbox_h: number;
  eyes_open?: number | null;
  face_sharpness?: number | null;
  confidence?: number;
}

export interface CullingPhoto {
  width: number;
  height: number;
  sharpness: number;
  faces: CullingFace[];
}

// Eyes-open score (CLIP: "open eyes" minus "closed eyes"): below this the eyes look shut.
// normal: <1% of open eyes flagged, 70% of shut ones caught; high: ~2.5% flagged, ~80% caught.
const EYES_THRESHOLD: Record<Exclude<CheckLevel, "off">, number> = { normal: -0.013, high: -0.01 };
// Face focus (Laplacian variance on the aligned face): normal catches clear misses, high also slight softness
const FOCUS_THRESHOLD: Record<Exclude<CheckLevel, "off">, number> = { normal: 40, high: 80 };
// Faces smaller than this share of the photo's long side are too small to judge (eyes / focus)
const MIN_FACE_FOR_EYES = 0.03;
const MIN_FACE_FOR_FOCUS = 0.05;
// Unsure detections (a pet, a pattern) are not judged: real faces score about 0.68 and up
const MIN_CONFIDENCE = 0.65;
const judgeable = (f: CullingFace) => f.confidence == null || f.confidence >= MIN_CONFIDENCE;

export const DEFAULT_CULLING: CullingSettings = { eyes: "normal", focus: "normal" };

function faceSize(photo: CullingPhoto, face: CullingFace): number {
  // Boxes are fractions of the photo: the face's long side as a share of the photo's long side
  const w = photo.width || 1;
  const h = photo.height || 1;
  return Math.max(face.bbox_w * w, face.bbox_h * h) / Math.max(w, h);
}

function mainFace(photo: CullingPhoto): CullingFace | undefined {
  let best: CullingFace | undefined;
  for (const f of photo.faces) {
    if (!judgeable(f)) continue;
    if (!best || f.bbox_w * f.bbox_h > best.bbox_w * best.bbox_h) best = f;
  }
  return best;
}

// Someone in the photo blinked (any face big enough to judge)
export function hasClosedEyes(photo: CullingPhoto, s: CullingSettings = DEFAULT_CULLING): boolean {
  if (s.eyes === "off") return false;
  const t = EYES_THRESHOLD[s.eyes];
  return photo.faces.some(
    (f) => judgeable(f) && f.eyes_open != null && f.eyes_open < t && faceSize(photo, f) >= MIN_FACE_FOR_EYES
  );
}

// The main face is out of focus (a sharp background doesn't help a soft face)
export function isSoftFocus(photo: CullingPhoto, s: CullingSettings = DEFAULT_CULLING): boolean {
  if (s.focus === "off") return false;
  const f = mainFace(photo);
  return Boolean(
    f && f.face_sharpness != null && faceSize(photo, f) >= MIN_FACE_FOR_FOCUS && f.face_sharpness < FOCUS_THRESHOLD[s.focus]
  );
}

// Higher is better: open eyes first, then a sharp main face, then overall sharpness. Used to choose the
// photo shown for a burst and the one "Keep best" keeps.
export function cullScore(photo: CullingPhoto, s: CullingSettings = DEFAULT_CULLING): number {
  const penalty = (hasClosedEyes(photo, s) ? 2 : 0) + (isSoftFocus(photo, s) ? 1 : 0);
  const face = mainFace(photo);
  const focus = face?.face_sharpness != null ? face.face_sharpness : photo.sharpness;
  return -penalty * 1000 + Math.log1p(Math.max(0, focus));
}
