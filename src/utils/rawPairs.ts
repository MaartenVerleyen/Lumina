import type { PhotoItem } from "../types/lumina";

export const RAW_OR_HEIC_NAME = /\.(cr2|cr3|nef|arw|dng|orf|rw2|heic|heif|pef|raf)$/i;

// The photo's own file on disk. For RAW/HEIC `path` is the cached preview and the original is in
// `pair_raw_path`; for a JPEG `pair_raw_path` is its RAW partner, so the JPEG itself is `path`.
export function diskPathOf(photo: Pick<PhotoItem, "name" | "path" | "pair_raw_path">): string {
  return RAW_OR_HEIC_NAME.test(photo.name) && photo.pair_raw_path ? photo.pair_raw_path : photo.path;
}

// Adds the RAW/JPEG partner of every selected photo, in both directions.
// `pair_raw_path` means different things per type: on a RAW/HEIC item it is the item's OWN original path
// (its `path` points at the cached preview); on a JPEG it is the path of the partner RAW.
export function expandWithRawPairs(
  hashes: string[],
  photos: Pick<PhotoItem, "hash" | "name" | "pair_raw_path">[]
): string[] {
  const result = new Set<string>(hashes);
  const key = (path: string) => path.toLowerCase();
  const rawByOriginalPath = new Map<string, string>();
  const jpegByPartnerRawPath = new Map<string, string>();
  const byHash = new Map<string, Pick<PhotoItem, "name" | "pair_raw_path">>();
  for (const p of photos) {
    byHash.set(p.hash, p);
    if (!p.pair_raw_path) continue;
    if (RAW_OR_HEIC_NAME.test(p.name)) {
      rawByOriginalPath.set(key(p.pair_raw_path), p.hash);
    } else {
      jpegByPartnerRawPath.set(key(p.pair_raw_path), p.hash);
    }
  }
  for (const h of hashes) {
    const p = byHash.get(h);
    if (!p?.pair_raw_path) continue;
    const partner = RAW_OR_HEIC_NAME.test(p.name)
      ? jpegByPartnerRawPath.get(key(p.pair_raw_path))
      : rawByOriginalPath.get(key(p.pair_raw_path));
    if (partner) result.add(partner);
  }
  return Array.from(result);
}
