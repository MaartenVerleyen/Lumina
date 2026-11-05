// All photos: one view of several sources at once (docs/plans/one-view.md). A source is a folder on this
// computer or a library on a server; the same photo (by content hash) in two sources is two copies of one
// photo, shown once. Its home is the copy whose ratings and tags are shown and where edits go: a server's
// copy when this account may edit it there, else the copy on this computer; a photo only on a server this
// account may not edit has no home (read-only).
// Pure functions only: index.ts does the calls, and the tests run this under Node.
import type { PersonItem, PhotoItem, SemanticHit, SemanticStatus } from "../types/lumina";

export interface Source {
  // null: a folder on this computer
  server: string | null;
  root: string;
  // How the folder tree names it: "D:\Photos", "cachy: Library"
  label: string;
  // May rate, tag and name people there (a folder on this computer always)
  editable: boolean;
  // Photos sent there are backed up (uploader and up on a server)
  uploadable: boolean;
}

export const sourceKey = (s: Pick<Source, "server" | "root">) => `${s.server ?? ""}|${s.root}`;

// The engine that holds a source: this computer's ("") or a server's
export const engineOf = (s: Pick<Source, "server">) => s.server ?? "";

export interface Copies {
  // Source keys of every copy
  copies: string[];
  // The copy that is shown and edited (null: read-only)
  home: string | null;
  // The copy the window shows (the home, or for a read-only photo the server's copy)
  shown: string;
}

export interface Merged {
  photos: PhotoItem[];
  copies: Map<string, Copies>;
  // The values of each copy on this computer, for keeping them in step with a server home
  localValues: Map<string, LocalValues>;
  // The copies on this computer of a photo, by their ids here, when one differs from the photo's (see
  // `sameAs`): the same file in two folders here is two copies, and an edit goes to both
  localIds: Map<string, string[]>;
}

export interface LocalValues {
  rating: number;
  flag: PhotoItem["flag"];
  color_label: PhotoItem["color_label"];
  tags: string[];
}

// Which copy is the home: a server's the account may edit, else this computer's, else none
function rank(s: Source): number {
  if (s.server !== null && s.editable) return 0;
  if (s.server === null) return 1;
  return 2;
}

// Folder tree path of a photo in a source: the source's label, then its folders (" / " as the tree splits)
function treePath(source: Source, subfolder: string): string {
  return subfolder === "Root" || !subfolder ? source.label : `${source.label} / ${subfolder}`;
}

// Burst and duplicate group numbers are per source: they get a range per source so they don't meet
const GROUP_RANGE = 1_000_000;

// `sameAs`: a copy on this computer that is a server's photo under another id (a second copy of a file here
// gets an id of its own; the upload queue recorded which server photo it is), by its id here
export function mergeSources(lists: { source: Source; photos: PhotoItem[] }[], sameAs: Map<string, string> = new Map()): Merged {
  const byHash = new Map<string, { source: Source; index: number; photo: PhotoItem }[]>();
  lists.forEach(({ source, photos }, index) => {
    for (const photo of photos) {
      const id = (source.server === null && sameAs.get(photo.hash)) || photo.hash;
      let entry = byHash.get(id);
      if (!entry) byHash.set(id, (entry = []));
      entry.push({ source, index, photo });
    }
  });
  const photos: PhotoItem[] = [];
  const copies = new Map<string, Copies>();
  const localValues = new Map<string, LocalValues>();
  const localIds = new Map<string, string[]>();
  for (const [hash, found] of byHash) {
    const ordered = [...found].sort((a, b) => rank(a.source) - rank(b.source));
    const shown = ordered[0];
    const home = rank(shown.source) < 2 ? sourceKey(shown.source) : null;
    const local = found.find((f) => f.source.server === null);
    if (local) {
      const p = local.photo;
      localValues.set(hash, { rating: p.rating, flag: p.flag, color_label: p.color_label, tags: [...p.tags] });
      const own = [...new Set(found.filter((f) => f.source.server === null).map((f) => f.photo.hash))];
      if (own.some((h) => h !== hash)) localIds.set(hash, own);
    }
    const keys = [...new Set(found.map((f) => sourceKey(f.source)))];
    copies.set(hash, { copies: keys, home, shown: sourceKey(shown.source) });
    const group = shown.photo.duplicate_group;
    // People travel with a shared photo: who is in it shows also where your own copy is the home (Dad's copy
    // of a photo shared with him finds maarten's names)
    const people = [...shown.photo.people];
    for (const f of found) {
      if (f === shown || rank(f.source) < 2) continue;
      for (const n of f.photo.people) if (!people.some((x) => x.toLowerCase() === n.toLowerCase())) people.push(n);
    }
    photos.push({
      ...shown.photo,
      hash,
      people,
      subfolder: treePath(shown.source, shown.photo.subfolder),
      also_in: found.filter((f) => f !== shown).map((f) => treePath(f.source, f.photo.subfolder)),
      duplicate_group: group == null ? group : shown.index * GROUP_RANGE + group,
      copies: keys,
      home,
    });
  }
  return { photos, copies, localValues, localIds };
}

// An edit for this computer's engine, with the ids it knows its copies by
export function withLocalIds(args: Record<string, unknown>, localIds: Map<string, string[]>): Record<string, unknown> {
  if (!Array.isArray(args.hashes)) return args;
  return { ...args, hashes: (args.hashes as string[]).flatMap((h) => localIds.get(h) ?? [h]) };
}

// The hashes of an edit, per engine of their home; photos without a home can't be changed
export function splitByHome(
  hashes: string[],
  copies: Map<string, Copies>,
  sources: Map<string, Source>
): { byEngine: Map<string, string[]>; readOnly: string[]; alsoLocal: string[] } {
  const byEngine = new Map<string, string[]>();
  const readOnly: string[] = [];
  const alsoLocal: string[] = [];
  for (const hash of hashes) {
    const c = copies.get(hash);
    const home = c?.home ? sources.get(c.home) : undefined;
    if (!c || !home) {
      readOnly.push(hash);
      continue;
    }
    const engine = engineOf(home);
    let list = byEngine.get(engine);
    if (!list) byEngine.set(engine, (list = []));
    list.push(hash);
    // A server home with a copy on this computer: that copy follows (it shows the same when opened alone)
    if (home.server !== null && c.copies.some((k) => sources.get(k)?.server === null)) alsoLocal.push(hash);
  }
  return { byEngine, readOnly, alsoLocal };
}

// The edits that make the copies on this computer show what their server home says (rating, flag, label,
// tags), grouped so a library of thousands takes a few calls
export function copyDownEdits(
  homes: PhotoItem[],
  localValues: Map<string, LocalValues>
): { command: string; args: Record<string, unknown> }[] {
  const ratings = new Map<number, string[]>();
  const flags = new Map<string, string[]>();
  const labels = new Map<string, string[]>();
  const added = new Map<string, string[]>();
  const removed = new Map<string, string[]>();
  const push = <K>(m: Map<K, string[]>, key: K, hash: string) => {
    let list = m.get(key);
    if (!list) m.set(key, (list = []));
    list.push(hash);
  };
  for (const p of homes) {
    const local = localValues.get(p.hash);
    if (!local) continue;
    if (local.rating !== p.rating) push(ratings, p.rating, p.hash);
    if (local.flag !== p.flag) push(flags, p.flag ?? "", p.hash);
    if (local.color_label !== p.color_label) push(labels, p.color_label ?? "", p.hash);
    for (const t of p.tags) if (!local.tags.includes(t)) push(added, t, p.hash);
    for (const t of local.tags) if (!p.tags.includes(t)) push(removed, t, p.hash);
  }
  const edits: { command: string; args: Record<string, unknown> }[] = [];
  for (const [rating, hashes] of ratings) edits.push({ command: "set_photos_rating", args: { hashes, rating } });
  for (const [flag, hashes] of flags) edits.push({ command: "set_photo_flag", args: { hashes, flag: flag || null } });
  for (const [color, hashes] of labels) edits.push({ command: "set_photo_color_label", args: { hashes, color: color || null } });
  for (const [tag, hashes] of added) edits.push({ command: "add_tag_batch", args: { hashes, tag } });
  for (const [tag, hashes] of removed) edits.push({ command: "remove_tag_batch", args: { hashes, tag } });
  return edits;
}

// What a local copy holds after those edits
export function localValuesOf(p: PhotoItem): LocalValues {
  return { rating: p.rating, flag: p.flag, color_label: p.color_label, tags: [...p.tags] };
}

// People of every source by name: the same name is one person (decision 3), with the photos of both
export function mergePeople(lists: PersonItem[][]): PersonItem[] {
  const byName = new Map<string, PersonItem>();
  for (const list of lists) {
    for (const p of list) {
      const key = p.name.toLowerCase();
      const seen = byName.get(key);
      if (!seen) {
        byName.set(key, { ...p });
      } else {
        seen.photo_count += p.photo_count;
        seen.cover_thumb = seen.cover_thumb || p.cover_thumb;
        seen.starred = seen.starred || p.starred;
        seen.hidden = seen.hidden && p.hidden;
      }
    }
  }
  return [...byName.values()].sort((a, b) => b.photo_count - a.photo_count || a.name.localeCompare(b.name));
}

// Smart search over several engines: a photo found twice counts once, with its best score
export function mergeHits(lists: SemanticHit[][]): SemanticHit[] {
  const best = new Map<string, number>();
  for (const list of lists) for (const h of list) best.set(h.hash, Math.max(best.get(h.hash) ?? -Infinity, h.score));
  return [...best].map(([hash, score]) => ({ hash, score })).sort((a, b) => b.score - a.score);
}

export function mergeStatus(list: SemanticStatus[]): SemanticStatus {
  return {
    models_ready: list.some((s) => s.models_ready),
    indexed: list.reduce((n, s) => n + s.indexed, 0),
    total: list.reduce((n, s) => n + s.total, 0),
    running: list.some((s) => s.running),
  };
}

// Where a photo is, for its mark in the grid and the Where filter
export type Whereabouts = "not-backed-up" | "this-pc" | "server-only" | "both";

export function whereabouts(p: Pick<PhotoItem, "copies">, sources: Map<string, Source>, canBackUp: boolean): Whereabouts {
  const found = (p.copies ?? []).map((k) => sources.get(k)).filter((s): s is Source => !!s);
  const local = found.some((s) => s.server === null);
  const server = found.some((s) => s.server !== null);
  if (local && server) return "both";
  if (server) return "server-only";
  return canBackUp ? "not-backed-up" : "this-pc";
}

// Sources the user took off the list (Settings → All photos); every other folder and library counts
export function includedSources(all: Source[], excluded: string[]): Source[] {
  const off = new Set(excluded);
  return all.filter((s) => !off.has(sourceKey(s)));
}

// ---------- People of several sources (milestone 3) ----------

// A user's own name for a server's person (get_person_names), and whether it is kept apart
export interface PersonName {
  person: string;
  shown_as: string | null;
  apart: boolean;
}

// How this account shows a server's person: by the name of their own, and with the server's name added when
// kept apart from a person of the same name elsewhere ("Emma (cachy)")
export function shownPersonName(name: string, names: Map<string, PersonName> | undefined, serverLabel: string): string {
  const own = names?.get(name.toLowerCase());
  const base = own?.shown_as || name;
  return own?.apart ? `${base} (${serverLabel})` : base;
}

// A photo with its people (and named faces) as this account shows them
export function withPeopleNamed(p: PhotoItem, show: (name: string) => string): PhotoItem {
  return {
    ...p,
    people: p.people.map(show),
    faces: (p.faces ?? []).map((f) => (f.person_name ? { ...f, person_name: show(f.person_name) } : f)),
  };
}

// One source's part of a person All photos shows: the engine, the name there, and whether this account may
// change that person there (else a name of their own is all it can give)
export interface PersonPart {
  engine: string;
  label: string;
  name: string;
  editable: boolean;
  shownAs: string | null;
  apart: boolean;
}

// A name with the library it is kept apart in ("Emma (cachy)"): the name and the library, else null
export function splitApartName(name: string): { base: string; library: string } | null {
  const m = /^(.*\S) \(([^()]+)\)$/.exec(name);
  return m ? { base: m[1], library: m[2] } : null;
}

// The person's name on an engine, for a name the window shows (a new name stays as it is)
export function nameOn(engine: string, shown: string, parts: Map<string, PersonPart[]>): string {
  return parts.get(shown.toLowerCase())?.find((p) => p.engine === engine)?.name ?? shown;
}

// ---------- Suggested names (milestone 5) ----------

// A person's face in short from an engine (person_centroids), by the name the window shows
export interface Centroid {
  engine: string;
  name: string;
  vector: Float32Array;
}

export interface NameSuggestion {
  // The person who would take the other's name, and that person
  from: { engine: string; name: string };
  to: { engine: string; name: string };
  score: number;
}

// The engines send a centroid as base64 of little-endian f32
export function decodeCentroid(base64: string): Float32Array {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
}

const dotProduct = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
};

// People of two libraries whose faces look alike but whose names differ: pairs that are each other's best
// match there, at 0.6 or more (the engine's "likely" match). The server's person takes this PC's name (a
// name of your own, which changes nothing for anyone else); between two servers the second takes the first's.
export function suggestSamePeople(centroids: Centroid[], minScore = 0.6): NameSuggestion[] {
  const best = (c: Centroid, engine: string) => {
    let top: { other: Centroid; score: number } | null = null;
    for (const o of centroids) {
      if (o.engine !== engine) continue;
      const score = dotProduct(c.vector, o.vector);
      if (!top || score > top.score) top = { other: o, score };
    }
    return top;
  };
  const engineOrder = (e: string) => (e === "" ? "" : `~${e}`);
  const out: NameSuggestion[] = [];
  for (const a of centroids) {
    for (const engine of new Set(centroids.map((c) => c.engine))) {
      if (engine === a.engine || engineOrder(engine) > engineOrder(a.engine)) continue;
      const match = best(a, engine);
      if (!match || match.score < minScore) continue;
      const back = best(match.other, a.engine);
      if (back?.other !== a || match.other.name.toLowerCase() === a.name.toLowerCase()) continue;
      out.push({ from: { engine: a.engine, name: a.name }, to: { engine, name: match.other.name }, score: match.score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

// ---------- Duplicates across libraries (milestone 5) ----------

const popcount32 = (n: number) => {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

function dhashBits(a: string, b: string): number {
  const half = (h: string, i: number) => parseInt(h.slice(i * 8, i * 8 + 8), 16) >>> 0;
  return popcount32((half(a, 0) ^ half(b, 0)) >>> 0) + popcount32((half(a, 1) ^ half(b, 1)) >>> 0);
}

// Each library groups its own near-duplicates (with smart search to confirm); across libraries photos whose
// fingerprints are at most 8 bits apart join a group too, as the engine does without smart search. Compared in
// capture order, each with the next 300 of another library. Groups are numbered again from 1.
export function groupAcrossSources(photos: PhotoItem[], shownIn: (p: PhotoItem) => string): PhotoItem[] {
  const parent = photos.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const byGroup = new Map<number, number>();
  photos.forEach((p, i) => {
    if (p.duplicate_group == null) return;
    const first = byGroup.get(p.duplicate_group);
    if (first === undefined) byGroup.set(p.duplicate_group, i);
    else join(i, first);
  });
  const order = photos
    .map((_, i) => i)
    .filter((i) => /^[0-9a-f]{16}$/i.test(photos[i].dhash))
    .sort((a, b) => photos[a].captured_at.localeCompare(photos[b].captured_at) || photos[a].name.localeCompare(photos[b].name));
  const joined = new Set<number>();
  for (let x = 0; x < order.length; x++) {
    const a = order[x];
    for (let y = x + 1; y < Math.min(order.length, x + 300); y++) {
      const b = order[y];
      if (shownIn(photos[a]) === shownIn(photos[b])) continue;
      if (dhashBits(photos[a].dhash, photos[b].dhash) <= 8) {
        join(a, b);
        joined.add(a).add(b);
      }
    }
  }
  const size = new Map<number, number>();
  photos.forEach((p, i) => {
    if (p.duplicate_group != null || joined.has(i)) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  });
  const numbers = new Map<number, number>();
  return photos.map((p, i) => {
    const root = find(i);
    if ((size.get(root) ?? 0) < 2) return p.duplicate_group == null ? p : { ...p, duplicate_group: null };
    if (!numbers.has(root)) numbers.set(root, numbers.size + 1);
    return { ...p, duplicate_group: numbers.get(root)! };
  });
}
