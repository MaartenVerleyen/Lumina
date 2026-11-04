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
  // A copy on this computer known here by another id than the photo's (see `sameAs`): its own id
  localIds: Map<string, string>;
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
  const localIds = new Map<string, string>();
  for (const [hash, found] of byHash) {
    const ordered = [...found].sort((a, b) => rank(a.source) - rank(b.source));
    const shown = ordered[0];
    const home = rank(shown.source) < 2 ? sourceKey(shown.source) : null;
    const local = found.find((f) => f.source.server === null);
    if (local) {
      const p = local.photo;
      localValues.set(hash, { rating: p.rating, flag: p.flag, color_label: p.color_label, tags: [...p.tags] });
      if (p.hash !== hash) localIds.set(hash, p.hash);
    }
    const keys = [...new Set(found.map((f) => sourceKey(f.source)))];
    copies.set(hash, { copies: keys, home, shown: sourceKey(shown.source) });
    const group = shown.photo.duplicate_group;
    photos.push({
      ...shown.photo,
      hash,
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
export function withLocalIds(args: Record<string, unknown>, localIds: Map<string, string>): Record<string, unknown> {
  if (!Array.isArray(args.hashes)) return args;
  return { ...args, hashes: (args.hashes as string[]).map((h) => localIds.get(h) ?? h) };
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
