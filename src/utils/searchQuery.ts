// Search box syntax: `rating:>=4 person:anna tag:beach date:2024-06 -flag:reject "summer party"`.
// Recognised `key:value` terms filter the photos; everything else is free text (plain or smart search).
// A leading "-" negates a term. Values with spaces go in quotes: camera:"EOS R6". person:anna|bob = either.

export const TERM_KEYS = [
  "rating", "flag", "label", "person", "tag", "camera", "lens", "place", "date", "has", "is", "album", "name",
] as const;
export type TermKey = (typeof TERM_KEYS)[number];
export type TermOp = "=" | ">=" | "<=" | ">" | "<";

export interface SearchTerm {
  key: TermKey;
  op: TermOp;
  value: string;
  negate: boolean;
  // The term as typed, so it can be removed from the query again
  raw: string;
}

export interface ParsedQuery {
  terms: SearchTerm[];
  text: string;
}

const TOKEN = /(-?)([a-z]+):(>=|<=|>|<|=)?(?:"([^"]*)"?|(\S*))|"[^"]*"?|\S+/gi;

export function parseSearchQuery(query: string): ParsedQuery {
  const terms: SearchTerm[] = [];
  const text: string[] = [];
  for (const m of query.matchAll(TOKEN)) {
    const [raw, minus, rawKey, op, quoted, bare] = m;
    const key = rawKey?.toLowerCase() as TermKey | undefined;
    if (key && (TERM_KEYS as readonly string[]).includes(key)) {
      const value = (quoted ?? bare ?? "").trim();
      // "person:" while still typing: not a filter yet
      if (value) terms.push({ key, op: (op as TermOp) || "=", value, negate: minus === "-", raw });
      continue;
    }
    text.push(raw.startsWith('"') ? raw.replace(/"/g, "") : raw);
  }
  return { terms, text: text.join(" ").trim() };
}

// The query without one of its terms (chip ✕)
export function removeTerm(query: string, term: SearchTerm): string {
  const i = query.indexOf(term.raw);
  if (i < 0) return query;
  return (query.slice(0, i) + query.slice(i + term.raw.length)).replace(/\s{2,}/g, " ").trim();
}

const OP_LABEL: Record<TermOp, string> = { "=": "", ">=": "≥ ", "<=": "≤ ", ">": "> ", "<": "< " };
const KEY_LABEL: Record<TermKey, string> = {
  rating: "Rating", flag: "Flag", label: "Label", person: "Person", tag: "Tag", camera: "Camera",
  lens: "Lens", place: "Place", date: "Date", has: "Has", is: "Is", album: "Album", name: "File name",
};

export function describeTerm(t: SearchTerm): string {
  return `${t.negate ? "Not " : ""}${KEY_LABEL[t.key]}: ${OP_LABEL[t.op]}${t.value}`;
}

export interface MatchablePhoto {
  hash: string;
  name: string;
  rating: number;
  flag: "pick" | "reject" | null;
  color_label: string | null;
  people: string[];
  tags: string[];
  camera_model: string;
  lens_model?: string | null;
  location: string;
  captured_at: string;
  latitude?: number | null;
  longitude?: number | null;
  faces: unknown[];
  ocr_text: string;
  ai_caption: string;
  pair_raw_path?: string | null;
  damaged?: boolean;
  staged_target?: string | null;
  in_basket?: boolean;
}

export interface MatchContext {
  // Photos of the album with this name (case-insensitive), or undefined if there is no such album
  albumHashes?: (name: string) => Set<string> | undefined;
}

const RAW_EXT = /\.(cr2|cr3|nef|arw|dng|orf|rw2|pef|raf)$/i;

function compare(a: number, op: TermOp, b: number): boolean {
  switch (op) {
    case ">=": return a >= b;
    case "<=": return a <= b;
    case ">": return a > b;
    case "<": return a < b;
    default: return a === b;
  }
}

// "2024:06:15 10:00:00" -> "2024-06-15"
function dayOf(capturedAt: string): string {
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})/.exec(capturedAt || "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

// Dates match by prefix: date:2024 is the whole year, date:2024-06 the month; ranges with "..";
// comparisons work on the same prefix (date:<2020 = before 2020)
function matchDate(day: string, op: TermOp, value: string): boolean {
  if (!day) return false;
  const v = value.replace(/[/:]/g, "-");
  if (v.includes("..")) {
    const [from, to] = v.split("..");
    return (!from || day.slice(0, from.length) >= from) && (!to || day.slice(0, to.length) <= to);
  }
  const prefix = day.slice(0, v.length);
  switch (op) {
    case ">=": return prefix >= v;
    case "<=": return prefix <= v;
    case ">": return prefix > v;
    case "<": return prefix < v;
    default: return prefix === v;
  }
}

function matchOne(p: MatchablePhoto, t: SearchTerm, ctx: MatchContext): boolean {
  const v = t.value.toLowerCase();
  const has = (s: string | null | undefined) => (s || "").toLowerCase().includes(v);
  switch (t.key) {
    case "rating": {
      const n = Number(v);
      return Number.isFinite(n) && compare(p.rating, t.op, n);
    }
    case "flag":
      return v === "none" ? !p.flag : p.flag === v || (v === "picked" && p.flag === "pick") || (v === "rejected" && p.flag === "reject");
    case "label":
      return v === "none" ? !p.color_label : (p.color_label || "") === v;
    case "person": {
      // person:anna|bob = either of them (several person: terms = all of them)
      const wanted = v.split("|").filter(Boolean);
      return p.people.some((n) => wanted.includes(n.toLowerCase()));
    }
    case "tag":
      return p.tags.some((n) => n.toLowerCase() === v);
    case "camera":
      return has(p.camera_model);
    case "lens":
      return has(p.lens_model);
    case "place":
      return has(p.location);
    case "name":
      return has(p.name);
    case "date":
      return matchDate(dayOf(p.captured_at), t.op, v);
    case "album":
      return ctx.albumHashes?.(t.value)?.has(p.hash) ?? false;
    case "has":
      switch (v) {
        case "gps": return p.latitude != null && p.longitude != null;
        case "faces": return p.faces.length > 0;
        case "people": return p.people.length > 0;
        case "ocr": case "text": return Boolean(p.ocr_text);
        case "caption": return Boolean(p.ai_caption);
        case "tags": return p.tags.length > 0;
        case "location": case "place": return Boolean(p.location);
        default: return false;
      }
    case "is":
      switch (v) {
        case "raw": return RAW_EXT.test(p.name);
        case "paired": return Boolean(p.pair_raw_path);
        case "screenshot": return p.tags.includes("screenshot");
        case "damaged": return Boolean(p.damaged);
        case "staged": return Boolean(p.staged_target);
        case "basket": case "pinned": return Boolean(p.in_basket);
        case "pick": case "picked": return p.flag === "pick";
        case "reject": case "rejected": return p.flag === "reject";
        default: return false;
      }
    default:
      return true;
  }
}

export function matchesTerms(p: MatchablePhoto, terms: SearchTerm[], ctx: MatchContext = {}): boolean {
  for (const t of terms) {
    if (matchOne(p, t, ctx) === t.negate) return false;
  }
  return true;
}

// Autocomplete: the key and partial value of the term being typed at the end of the query
export function termBeingTyped(query: string): { key: TermKey; partial: string; start: number } | null {
  const m = /(?:^|\s)-?([a-z]+):"?([^"\s]*)$/i.exec(query);
  if (!m) return null;
  const key = m[1].toLowerCase();
  if (!(TERM_KEYS as readonly string[]).includes(key)) return null;
  return { key: key as TermKey, partial: m[2], start: query.length - m[0].trimStart().length };
}

// Replaces the term being typed with a completed one (quoted when the value has spaces)
export function completeTerm(query: string, key: TermKey, value: string): string {
  const typing = termBeingTyped(query);
  if (!typing) return query;
  const negate = query.slice(typing.start).startsWith("-") ? "-" : "";
  const v = /\s/.test(value) ? `"${value}"` : value;
  return `${query.slice(0, typing.start)}${negate}${key}:${v} `;
}
