import { ALL_PHOTOS, mediaUrl } from "../api";
import { PhotoItem, AutoStagePreset } from "../types/lumina";

// What the open library is called: a folder's own name, or All photos
export function libraryName(folder: string): string {
  if (folder === ALL_PHOTOS) return "All photos";
  return folder.split(/[\\/]/).filter(Boolean).pop() || folder;
}

export { foldersOf, buildFolderTree } from "./folderTree";

export function getPhotoEventName(p: PhotoItem): string {
  const ym =
    p.captured_at && p.captured_at.length >= 7
      ? p.captured_at.slice(0, 7).replace(":", "-")
      : "";
  const city = p.location ? p.location.split(",")[0] : "";
  if (ym && city) return `${ym} • ${city}`;
  if (ym) return `${ym}`;
  return "";
}

export function computePresetTargetFolder(
  p: PhotoItem,
  preset: AutoStagePreset
): string | null {
  const ym =
    p.captured_at && p.captured_at.length >= 7
      ? p.captured_at.slice(0, 7).replace(/:/g, "-")
      : "Undated";
  const yr = ym !== "Undated" ? ym.slice(0, 4) : "Undated";
  const city = p.location ? p.location.split(",")[0].trim() : "";

  switch (preset) {
    case "YEAR_MONTH_CITY":
      if (ym === "Undated") return null;
      return `${yr}/${ym}${city ? `_${city}` : ""}`;
    case "YEAR_MONTH":
      if (ym === "Undated") return null;
      return `${yr}/${ym}`;
    case "PERSON_YEAR": {
      const person = p.people[0] || "Unassigned_People";
      return `People/${person}/${yr}`;
    }
    case "SCREENSHOTS_BY_MONTH":
      if (!p.tags.includes("screenshot")) return null;
      return `_Screenshots/${ym}`;
    case "FAVORITES_YEAR":
      if (p.rating < 4 && p.flag !== "pick") return null;
      return `Favorites/${yr}`;
    default:
      return null;
  }
}

// Thumbnail URL; `thumb_rev` changes when the thumbnail file is replaced, so the webview reloads it
export function thumbSrc(photo: Pick<PhotoItem, "hash" | "thumb_path" | "thumb_rev">): string {
  const src = mediaUrl({ kind: "thumb", hash: photo.hash, path: photo.thumb_path });
  return photo.thumb_rev ? `${src}?v=${photo.thumb_rev}` : src;
}

// 1536 -> "2 KB", 3.2e9 -> "3.2 GB"
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
