// The folder tree beside the grid, built from the photos' folders (and folders on disk with none in them yet)
import type { PhotoItem, FolderTreeNode } from "../types/lumina";

// The folders a photo is in: its own, and in All photos those of its other copies. A photo of the phone layout's
// lean lists has no folder (leanList.ts): it counts as in the library's root.
export function foldersOf(p: Pick<PhotoItem, "subfolder" | "also_in">): string[] {
  const own = p.subfolder ?? "Root";
  return p.also_in && p.also_in.length > 0 ? [own, ...p.also_in] : [own];
}

// `emptyFolders`: folders on disk (tree paths) that show even with no photo in them
export function buildFolderTree(photos: PhotoItem[], emptyFolders: string[] = []): { rootCount: number; nodes: FolderTreeNode[] } {
  const directCounts = new Map<string, number>();
  for (const p of photos) {
    // In All photos a photo is in the folder of each of its copies
    for (const sub of foldersOf(p)) directCounts.set(sub, (directCounts.get(sub) || 0) + 1);
  }
  for (const f of emptyFolders) if (f !== "Root" && !directCounts.has(f)) directCounts.set(f, 0);

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
