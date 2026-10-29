// Highlights and On this day: which photos are worth showing. Pure functions (tests/highlights.test.ts);
// the final pick (variety, how attractive a photo looks) happens in src-tauri/src/highlights.rs.
import { hasClosedEyes, isSoftFocus, type CullingPhoto, type CullingSettings } from "./culling.ts";

export interface HighlightPhoto extends CullingPhoto {
  hash: string;
  rating: number;
  flag: "pick" | "reject" | null;
  tags: string[];
  people: string[];
  captured_at: string;
  subfolder: string;
  // File name (Best of recognises photos received through WhatsApp by it)
  name?: string;
  staged_target?: string | null;
  damaged?: boolean;
  duplicate_group?: number | null;
}

export interface HighlightCandidate {
  hash: string;
  base: number;
  group: number | null;
  time: number | null;
}

// "2024:06:15 18:30:00" / "2024-06-15 18:30:00" -> Unix seconds (taken as UTC; only differences matter)
export function captureTime(capturedAt: string): number | null {
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(capturedAt || "");
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isNaN(t) || +m[1] < 1971 ? null : t / 1000;
}

// Best of a year is about the user's own life: photos of their starred people, not every photo of friends or
// forwarded through WhatsApp. `starred` holds the starred people's names in lower case (may be empty).
export interface HighlightFocus {
  starred: Set<string>;
}

// Saved from WhatsApp: "IMG-20230615-WA0001.jpg", or kept in a WhatsApp folder
export function isReceivedPhoto(p: Pick<HighlightPhoto, "name" | "subfolder" | "tags">): boolean {
  return p.tags.includes("whatsapp") || /-WA\d{4}/i.test(p.name ?? "") || /whatsapp/i.test(p.subfolder);
}

function focusBonus(p: HighlightPhoto, focus: HighlightFocus): number {
  const starredHere = p.people.filter((name) => focus.starred.has(name.toLowerCase())).length;
  if (starredHere > 0) return 2 + 0.5 * Math.min(2, starredHere - 1);
  let bonus = 0;
  // Only other people (named or not): someone else's moment
  if (focus.starred.size > 0 && (p.people.length > 0 || p.faces.length > 0)) bonus -= 1.5;
  if (isReceivedPhoto(p)) bonus -= 1.5;
  return bonus;
}

// The app's own judgement of a photo, or null when it shouldn't be a highlight at all (rejected, on its way
// to _Trash, damaged, a screenshot)
export function highlightScore(p: HighlightPhoto, culling: CullingSettings, focus?: HighlightFocus): number | null {
  if (p.flag === "reject" || p.staged_target === "_Trash" || p.subfolder === "_Trash" || p.subfolder.startsWith("_Trash / "))
    return null;
  if (p.damaged || p.tags.includes("screenshot")) return null;
  let score = p.rating * 0.6 + (p.flag === "pick" ? 1.2 : 0);
  if (hasClosedEyes(p, culling)) score -= 2;
  if (isSoftFocus(p, culling)) score -= 1;
  if (p.faces.length > 0) score += 0.5;
  score += 0.3 * Math.min(3, p.people.length);
  // Sharpness on a log scale (the main face's when there is one)
  const face = [...p.faces].sort((a, b) => b.bbox_w * b.bbox_h - a.bbox_w * a.bbox_h)[0];
  const sharp = face?.face_sharpness ?? p.sharpness;
  score += Math.min(1, Math.log1p(Math.max(0, sharp)) / Math.log1p(2000));
  if (focus) score += focusBonus(p, focus);
  return score;
}

export function highlightCandidates(
  photos: HighlightPhoto[],
  culling: CullingSettings,
  focus?: HighlightFocus
): HighlightCandidate[] {
  const out: HighlightCandidate[] = [];
  for (const p of photos) {
    const base = highlightScore(p, culling, focus);
    if (base === null) continue;
    out.push({ hash: p.hash, base, group: p.duplicate_group ?? null, time: captureTime(p.captured_at) });
  }
  return out;
}

export interface OnThisDayGroup<T extends HighlightPhoto = HighlightPhoto> {
  yearsAgo: number;
  date: string; // YYYY-MM-DD
  photos: T[];
}

// Photos taken on today's date in earlier years, newest year first, the best few of each day
export function onThisDay<T extends HighlightPhoto>(
  photos: T[],
  today: Date,
  culling: CullingSettings,
  perDay = 6
): OnThisDayGroup<T>[] {
  const mmdd = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const byDate = new Map<string, T[]>();
  for (const p of photos) {
    const day = (p.captured_at || "").slice(0, 10).replace(/:/g, "-");
    if (day.length !== 10 || day.slice(5) !== mmdd) continue;
    const year = +day.slice(0, 4);
    if (year >= today.getFullYear() || year < 1971) continue;
    if (highlightScore(p, culling) === null) continue;
    const list = byDate.get(day) || [];
    list.push(p);
    byDate.set(day, list);
  }
  return Array.from(byDate, ([date, list]) => ({
    date,
    yearsAgo: today.getFullYear() - +date.slice(0, 4),
    photos: list
      .sort((a, b) => (highlightScore(b, culling) ?? 0) - (highlightScore(a, culling) ?? 0))
      .slice(0, perDay),
  })).sort((a, b) => a.yearsAgo - b.yearsAgo);
}
