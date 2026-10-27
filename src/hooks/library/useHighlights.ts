import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PhotoItem } from "../../types/lumina";
import { highlightCandidates } from "../../utils/highlights";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";
import type { LibraryView } from "./useLibraryView";
import type { Collections } from "./useCollections";

export interface HighlightsState {
  title: string;
  source: PhotoItem[];
  count: number;
  // The picks, null while they are being chosen
  hashes: string[] | null;
}

// Highlights: the best photos of a trip, album, year or whatever is shown, in a dialog; from there they can
// be shown in the grid or saved as an album
export function useHighlights(core: LibraryCore, filters: FilterState, view: LibraryView, collections: Collections) {
  const { setError, setViewMode, addLog } = core;
  const { setHashFilter } = filters;
  const { culling, clearAllFilters } = view;
  const [highlights, setHighlights] = useState<HighlightsState | null>(null);

  async function choose(title: string, source: PhotoItem[], count: number) {
    setHighlights({ title, source, count, hashes: null });
    try {
      const hashes = await invoke<string[]>("pick_highlights", {
        candidates: highlightCandidates(source, culling),
        count,
      });
      setHighlights((h) => (h && h.title === title && h.count === count ? { ...h, hashes } : h));
    } catch (err) {
      setHighlights(null);
      setError(`Highlights: ${String(err)}`);
    }
  }

  const openHighlights = (title: string, source: PhotoItem[], count = 20) => choose(title, source, count);
  const setHighlightsCount = (count: number) => highlights && choose(highlights.title, highlights.source, count);

  function showHighlightsInGrid() {
    if (!highlights?.hashes) return;
    clearAllFilters();
    setHashFilter({ label: `Highlights · ${highlights.title}`, hashes: new Set(highlights.hashes) });
    setViewMode("grid");
    setHighlights(null);
  }

  async function saveHighlightsAsAlbum() {
    if (!highlights?.hashes) return;
    const name = `${highlights.title} · highlights`;
    const id = await collections.handleCreateAlbum(name, highlights.hashes);
    if (id !== null) {
      addLog("LIBRARY", `Saved ${highlights.hashes.length} highlights as album "${name}"`);
      core.notify(`Saved as the album "${name}".`);
      setHighlights(null);
    }
  }

  return {
    highlights,
    setHighlights,
    openHighlights,
    setHighlightsCount,
    showHighlightsInGrid,
    saveHighlightsAsAlbum,
  };
}
