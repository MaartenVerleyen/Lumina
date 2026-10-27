// Natural search: "emma and lucas at the beach summer 2024" or "kerst bij oma 2023" becomes the search box's
// own filters (person:, date:, place:) plus the words left over ("at the beach"), which go to smart search
// or text search. English and Dutch. Pure functions; tests in tests/naturalQuery.test.ts.
import type { SearchTerm } from "./searchQuery.ts";

export interface NaturalContext {
  people: string[]; // display names
  places: string[]; // place names in the library ("Paris", "Lagos")
  today: Date;
}

export interface NaturalPart {
  kind: "person" | "date" | "place";
  label: string;
  // Where it was in the text, so its chip can remove those words again
  start: number;
  end: number;
}

export interface NaturalResult {
  terms: SearchTerm[];
  parts: NaturalPart[];
  rest: string;
}

interface Word {
  text: string; // as typed
  norm: string; // lower-case, no accents
  start: number;
  end: number;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’]/g, "'");

function words(text: string): Word[] {
  return Array.from(text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’&-]*/gu), (m) => ({
    text: m[0],
    norm: fold(m[0]),
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m: 1-12

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, januari: 1, february: 2, feb: 2, februari: 2, march: 3, mar: 3, maart: 3, april: 4,
  apr: 4, may: 5, mei: 5, june: 6, jun: 6, juni: 6, july: 7, jul: 7, juli: 7, august: 8, aug: 8, augustus: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, oktober: 10, okt: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};
const MONTH_LABEL = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Seasons as month ranges (winter wraps into the next year)
const SEASONS: Record<string, { from: number; to: number; label: string }> = {
  spring: { from: 3, to: 5, label: "spring" }, lente: { from: 3, to: 5, label: "spring" }, voorjaar: { from: 3, to: 5, label: "spring" },
  summer: { from: 6, to: 8, label: "summer" }, zomer: { from: 6, to: 8, label: "summer" },
  autumn: { from: 9, to: 11, label: "autumn" }, fall: { from: 9, to: 11, label: "autumn" }, herfst: { from: 9, to: 11, label: "autumn" }, najaar: { from: 9, to: 11, label: "autumn" },
  winter: { from: 12, to: 2, label: "winter" },
};

// Days of the year (any year unless a year follows)
const HOLIDAYS: { words: string[]; from: string; to: string; label: string }[] = [
  { words: ["new", "year's", "eve"], from: "12-31", to: "12-31", label: "New Year's Eve" },
  { words: ["oudejaarsavond"], from: "12-31", to: "12-31", label: "New Year's Eve" },
  { words: ["oudejaar"], from: "12-31", to: "12-31", label: "New Year's Eve" },
  { words: ["oudjaar"], from: "12-31", to: "12-31", label: "New Year's Eve" },
  { words: ["new", "year"], from: "01-01", to: "01-01", label: "New Year" },
  { words: ["nieuwjaar"], from: "01-01", to: "01-01", label: "New Year" },
  { words: ["christmas"], from: "12-24", to: "12-26", label: "Christmas" },
  { words: ["xmas"], from: "12-24", to: "12-26", label: "Christmas" },
  { words: ["kerstmis"], from: "12-24", to: "12-26", label: "Christmas" },
  { words: ["kerst"], from: "12-24", to: "12-26", label: "Christmas" },
  { words: ["valentine's", "day"], from: "02-14", to: "02-14", label: "Valentine's Day" },
  { words: ["valentijn"], from: "02-14", to: "02-14", label: "Valentine's Day" },
  { words: ["halloween"], from: "10-31", to: "10-31", label: "Halloween" },
];

// Words that only glue the sentence together: dropped next to a recognised part
const FILLERS = new Set([
  "in", "at", "on", "from", "during", "of", "the", "around", "near", "taken", "op", "van", "tijdens", "uit", "bij",
  "rond", "de", "het", "genomen",
]);
const PHOTO_WORDS = new Set(["photo", "photos", "picture", "pictures", "pics", "pic", "foto", "fotos", "foto's", "images"]);
const AND = new Set(["and", "with", "en", "met", "&", "plus"]);
const OR = new Set(["or", "of"]);

interface DateMatch {
  length: number; // words used
  value: string; // a date: term value
  label: string;
}

function yearAt(w: Word | undefined): number | null {
  if (!w || !/^(19[7-9]\d|20\d\d)$/.test(w.norm)) return null;
  return +w.norm;
}

function monthRange(y: number, from: number, to: number): string {
  // to < from: the range wraps into the next year (winter)
  const y2 = to < from ? y + 1 : y;
  return `${y}-${pad(from)}-01..${y2}-${pad(to)}-${pad(lastDay(y2, to))}`;
}

// A date phrase starting at word i: "summer 2024", "june", "last year", "kerst 2023", "2021"
function dateAt(ws: Word[], i: number, today: Date): DateMatch | null {
  const w = (k: number) => ws[i + k]?.norm;
  const Y = today.getFullYear();
  const M = today.getMonth() + 1;

  // Relative phrases
  const two = `${w(0)} ${w(1)}`;
  const relativeYear: Record<string, number> = { "last year": Y - 1, "vorig jaar": Y - 1, "vorige jaar": Y - 1, "this year": Y, "dit jaar": Y };
  if (two in relativeYear) return { length: 2, value: String(relativeYear[two]), label: two };
  if (["last month", "vorige maand"].includes(two)) {
    const y = M === 1 ? Y - 1 : Y;
    const m = M === 1 ? 12 : M - 1;
    return { length: 2, value: `${y}-${pad(m)}`, label: two };
  }
  if (["last week", "vorige week"].includes(two)) {
    const end = new Date(today);
    end.setDate(end.getDate() - 1);
    const start = new Date(today);
    start.setDate(start.getDate() - 7);
    return { length: 2, value: `${iso(start)}..${iso(end)}`, label: two };
  }
  if (w(0) === "yesterday" || w(0) === "gisteren") {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return { length: 1, value: iso(d), label: w(0)! };
  }
  // "last summer" / "vorige zomer" / "this summer"
  if (["last", "vorige", "afgelopen", "this", "deze"].includes(w(0) ?? "") && SEASONS[w(1) ?? ""]) {
    const s = SEASONS[w(1)!];
    const thisOne = w(0) === "this" || w(0) === "deze";
    // The latest one that has started ("this summer") or is over ("last summer")
    let y = Y + 1;
    for (; y > Y - 3; y--) {
      const start = new Date(y, s.from - 1, 1);
      const end = new Date(s.to < s.from ? y + 1 : y, s.to, 0, 23, 59);
      if (thisOne ? start <= today : end < today) break;
    }
    return { length: 2, value: monthRange(y, s.from, s.to), label: `${w(0)} ${s.label}` };
  }

  // Holidays, with an optional year after them
  for (const h of HOLIDAYS) {
    if (h.words.every((hw, k) => w(k) === hw)) {
      const n = h.words.length;
      const year = yearAt(ws[i + n]);
      return year
        ? { length: n + 1, value: `${year}-${h.from}..${year}-${h.to}`, label: `${h.label} ${year}` }
        : { length: n, value: `*-${h.from}..*-${h.to}`, label: h.label };
    }
  }

  // Season or month, with an optional year after it ("summer 2024", "juni 2023")
  const season = SEASONS[w(0) ?? ""];
  const month = MONTHS[w(0) ?? ""];
  if (season || month) {
    // "summer 2024", "summer of 2024", "zomer van 2023"
    const via = ["of", "van"].includes(w(1) ?? "") ? 1 : 0;
    const year = yearAt(ws[i + 1 + via]);
    const used = year ? 2 + via : 1;
    if (season) {
      return year
        ? { length: used, value: monthRange(year, season.from, season.to), label: `${season.label} ${year}` }
        : {
            length: 1,
            value: `*-${pad(season.from)}-01..*-${pad(season.to)}-${pad(lastDay(2001, season.to))}`,
            label: season.label,
          };
    }
    // "may" on its own is too often the verb: only with a year
    if (w(0) === "may" && !year) return null;
    return year
      ? { length: used, value: `${year}-${pad(month)}`, label: `${MONTH_LABEL[month]} ${year}` }
      : { length: 1, value: `*-${pad(month)}`, label: MONTH_LABEL[month] };
  }

  const year = yearAt(ws[i]);
  if (year) return { length: 1, value: String(year), label: String(year) };
  return null;
}

// Longest library name (person or place) starting at word i
function nameAt(ws: Word[], i: number, names: Map<string, string>, maxWords: number): { length: number; name: string } | null {
  for (let n = Math.min(maxWords, ws.length - i); n >= 1; n--) {
    const key = ws
      .slice(i, i + n)
      .map((w) => w.norm)
      .join(" ");
    const name = names.get(key);
    if (name) return { length: n, name };
  }
  return null;
}

function nameIndex(list: string[], withFirstNames: boolean): { map: Map<string, string>; maxWords: number } {
  const map = new Map<string, string>();
  const firstNames = new Map<string, string[]>();
  let maxWords = 1;
  for (const name of list) {
    const key = fold(name).trim();
    if (!key) continue;
    map.set(key, name);
    maxWords = Math.max(maxWords, key.split(/\s+/).length);
    const first = key.split(/\s+/)[0];
    firstNames.set(first, [...(firstNames.get(first) ?? []), name]);
  }
  // "anna" finds "Anna Smith" when she is the only Anna
  if (withFirstNames) {
    for (const [first, names] of firstNames) if (names.length === 1 && !map.has(first)) map.set(first, names[0]);
  }
  return { map, maxWords };
}

const term = (key: SearchTerm["key"], value: string, label: string): SearchTerm & { label: string } => ({
  key,
  op: "=",
  value,
  negate: false,
  raw: "",
  label,
});

export function interpretNatural(text: string, ctx: NaturalContext, skip: Set<SearchTerm["key"]> = new Set()): NaturalResult {
  const ws = words(text);
  const people = nameIndex(ctx.people, true);
  const places = nameIndex(ctx.places, false);
  type Span = { kind: NaturalPart["kind"]; from: number; to: number; label: string; value: string };
  const spans: Span[] = [];
  for (let i = 0; i < ws.length; ) {
    // The user's own names first (someone may be called June or Summer), then dates, then places
    const person = skip.has("person") ? null : nameAt(ws, i, people.map, people.maxWords);
    if (person) {
      spans.push({ kind: "person", from: i, to: i + person.length, label: person.name, value: person.name });
      i += person.length;
      continue;
    }
    const date = skip.has("date") ? null : dateAt(ws, i, ctx.today);
    if (date) {
      spans.push({ kind: "date", from: i, to: i + date.length, label: date.label, value: date.value });
      i += date.length;
      continue;
    }
    const place = skip.has("place") ? null : nameAt(ws, i, places.map, places.maxWords);
    if (place) {
      spans.push({ kind: "place", from: i, to: i + place.length, label: place.name, value: place.name });
      i += place.length;
      continue;
    }
    i++;
  }

  // Which words are used: the spans, connectors between people, and filler words next to a span
  const used = new Array(ws.length).fill(false);
  for (const s of spans) for (let k = s.from; k < s.to; k++) used[k] = true;
  const spanAt = (k: number) => spans.find((s) => s.from <= k && k < s.to);
  // People joined by "or" become one either/or filter; "and" / "with" keep them separate (both in the photo)
  const groups: Span[][] = [];
  for (const s of spans.filter((x) => x.kind === "person")) {
    const prev = groups[groups.length - 1];
    const last = prev?.[prev.length - 1];
    const between = last ? ws.slice(last.to, s.from) : [];
    if (last && between.length === 1 && OR.has(between[0].norm)) {
      prev.push(s);
      used[last.to] = true;
    } else {
      groups.push([s]);
      if (last && between.length === 1 && AND.has(between[0].norm)) used[last.to] = true;
    }
  }
  for (let k = 0; k < ws.length; k++) {
    if (used[k] || !(FILLERS.has(ws[k].norm) || AND.has(ws[k].norm))) continue;
    // A filler next to a recognised part (or a run of fillers leading to one): "in 2024", "in de zomer"
    let j = k;
    while (j < ws.length && !used[j] && (FILLERS.has(ws[j].norm) || AND.has(ws[j].norm))) j++;
    let b = k - 1;
    while (b >= 0 && !used[b] && (FILLERS.has(ws[b].norm) || AND.has(ws[b].norm))) b--;
    if ((j < ws.length && spanAt(j)) || (b >= 0 && spanAt(b) && j >= ws.length)) {
      for (let x = k; x < j; x++) used[x] = true;
    }
  }
  // "photos of ..." at the start
  for (let k = 0; k < ws.length && (PHOTO_WORDS.has(ws[k].norm) || (k > 0 && FILLERS.has(ws[k].norm))); k++) used[k] = true;

  const terms: SearchTerm[] = [];
  const parts: NaturalPart[] = [];
  const part = (s: Span) => ({ kind: s.kind, label: s.label, start: ws[s.from].start, end: ws[s.to - 1].end });
  const source = (from: Span, to: Span) => text.slice(ws[from.from].start, ws[to.to - 1].end);
  for (const g of groups) {
    terms.push({
      ...term("person", g.map((s) => s.value).join("|"), g.map((s) => s.label).join(" or ")),
      raw: source(g[0], g[g.length - 1]),
    });
    parts.push(...g.map(part));
  }
  for (const s of spans.filter((x) => x.kind !== "person")) {
    terms.push({ ...term(s.kind === "date" ? "date" : "place", s.value, s.label), raw: source(s, s) });
    parts.push(part(s));
  }
  if (spans.length === 0) return { terms: [], parts: [], rest: text.trim() };
  const rest = ws
    .filter((_, k) => !used[k])
    .map((w) => w.text)
    .join(" ");
  return { terms, parts: parts.sort((a, b) => a.start - b.start), rest };
}

// Removes an understood part from the query (its chip's ✕), with the word that tied it in ("in paris",
// "with emma", "van 2023") so no dangling "in" is left behind
export function removeUnderstood(query: string, raw: string): string {
  const i = query.toLowerCase().lastIndexOf(raw.toLowerCase());
  if (i < 0 || !raw) return query;
  let start = i;
  const before = /(\S+)\s+$/.exec(query.slice(0, i));
  if (before && (FILLERS.has(fold(before[1])) || AND.has(fold(before[1])) || OR.has(fold(before[1])))) start = before.index;
  return (query.slice(0, start) + query.slice(i + raw.length)).replace(/\s{2,}/g, " ").trim();
}
