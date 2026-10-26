import { convertFileSrc } from "@tauri-apps/api/core";
import { PhotoItem, FolderTreeNode, AutoStagePreset } from "../types/lumina";

export function buildFolderTree(photos: PhotoItem[]): { rootCount: number; nodes: FolderTreeNode[] } {
  const directCounts = new Map<string, number>();
  for (const p of photos) {
    directCounts.set(p.subfolder, (directCounts.get(p.subfolder) || 0) + 1);
  }

  const rootCount = directCounts.get("Root") || 0;
  const nodeMap = new Map<string, FolderTreeNode>();
  const topNodes: FolderTreeNode[] = [];

  const allPaths = Array.from(directCounts.keys())
    .filter((k) => k !== "Root")
    .sort();

  for (const subPath of allPaths) {
    const parts = subPath.split(" / ");
    let currentFull = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const parentFull = currentFull;
      currentFull = currentFull ? `${currentFull} / ${part}` : part;

      if (!nodeMap.has(currentFull)) {
        const newNode: FolderTreeNode = {
          name: part,
          fullPath: currentFull,
          directCount: directCounts.get(currentFull) || 0,
          totalCount: 0,
          children: [],
        };
        nodeMap.set(currentFull, newNode);

        if (i === 0) {
          topNodes.push(newNode);
        } else {
          const parentNode = nodeMap.get(parentFull);
          if (parentNode) {
            parentNode.children.push(newNode);
          }
        }
      }
    }
  }

  function calcTotal(node: FolderTreeNode): number {
    let sum = node.directCount;
    for (const c of node.children) {
      sum += calcTotal(c);
    }
    node.totalCount = sum;
    return sum;
  }

  topNodes.forEach(calcTotal);
  return { rootCount, nodes: topNodes };
}

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
export function thumbSrc(photo: Pick<PhotoItem, "thumb_path" | "thumb_rev">): string {
  const src = convertFileSrc(photo.thumb_path);
  return photo.thumb_rev ? `${src}?v=${photo.thumb_rev}` : src;
}
