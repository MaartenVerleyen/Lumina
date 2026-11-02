import { PhotoItem, AiPerf } from "../../types/lumina";

// Constants and small helpers shared by the library hooks

// The vision model Lumina suggests and downloads. The instruct variant answers straight away (no hidden
// reasoning first) and read photos more accurately than the hybrid qwen3-vl:8b in tests (2026-11).
export const DEFAULT_AI_MODEL = "qwen3-vl:8b-instruct";

export const MAX_UNDO_STEPS = 20;
export const MAX_TOASTS = 4;

export interface Toast {
  id: number;
  kind: "info" | "error";
  message: string;
  // A button on the toast ("Import photos…")
  action?: { label: string; run: () => void };
}

// One collator for all sorting: String.localeCompare(..., options) builds a new collator on every call,
// which dominated sort time on large libraries
export const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true });
export const TEXT_COLLATOR = new Intl.Collator();
// Dates are "YYYY-MM-DD HH:MM:SS": plain code-unit order is the correct (and fastest) order
export const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Lower-cased searchable text per photo object. Photos are replaced (not mutated) on every change,
// so the WeakMap entry refreshes automatically and stale entries are garbage-collected.
export const searchTextCache = new WeakMap<PhotoItem, string>();
export function searchTextOf(p: PhotoItem): string {
  let text = searchTextCache.get(p);
  if (text === undefined) {
    text = [p.name, p.ai_caption, p.ocr_text, p.location, ...p.tags, ...p.people]
      .join("\n")
      .toLowerCase();
    searchTextCache.set(p, text);
  }
  return text;
}

// Error text of an AI request aborted by the Stop button (matches ai::AI_CANCELLED in Rust)
export const AI_CANCELLED = "AI analysis cancelled";
// Matching scan::SCAN_CANCELLED and ai::PULL_CANCELLED
export const SCAN_CANCELLED = "Folder scan cancelled";
export const PULL_CANCELLED = "Model download cancelled";
// Matching clip::SEMANTIC_CANCELLED
export const SEMANTIC_CANCELLED = "Smart search indexing cancelled";

// The library's most used tags, offered to the model so the same subject gets the same tag everywhere
export function topLibraryTags(list: PhotoItem[], max = 40): string[] {
  const counts = new Map<string, number>();
  for (const p of list) {
    for (const t of p.tags) {
      if (t !== "screenshot") counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}

// Windows paths: compare case-insensitively and ignore a trailing separator
export type LocationValue = { location: string; latitude: number | null; longitude: number | null };

export function isSameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

// Averages per-photo AI timings into one Session Log line (tokens/s use summed tokens over summed durations)
export function summarizeAiPerf(perfs: AiPerf[]): string {
  if (perfs.length === 0) return "";
  const sum = (key: keyof AiPerf) => perfs.reduce((acc, p) => acc + p[key], 0);
  const avg = (key: keyof AiPerf) => Math.round(sum(key) / perfs.length);
  const rate = (tokens: number, ms: number) => (ms > 0 ? ((tokens * 1000) / ms).toFixed(1) : "?");
  return [
    `avg ${(avg("total_ms") / 1000).toFixed(1)} s/photo`,
    `encode ${avg("encode_ms")} ms (${avg("image_kb")} KB image)`,
    `ollama ${avg("request_ms")} ms (model load ${avg("ollama_load_ms")} ms)`,
    `prompt ${avg("prompt_tokens")} tok @ ${rate(sum("prompt_tokens"), sum("prompt_eval_ms"))} tok/s`,
    `output ${avg("output_tokens")} tok @ ${rate(sum("output_tokens"), sum("output_eval_ms"))} tok/s`,
    `db + faces ${avg("post_ms")} ms`,
  ].join(" · ");
}
