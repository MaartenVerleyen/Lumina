import { useState } from "react";
import { call } from "../../api";
import { PhotoItem } from "../../types/lumina";
import { highlightCandidates, type HighlightFocus } from "../../utils/highlights";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";
import type { LibraryView } from "./useLibraryView";
import type { Collections } from "./useCollections";

export interface HighlightsState {
  title: string;
  source: PhotoItem[];
  count: number;
  // Best of: chosen around the starred people
  focus?: HighlightFocus;
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

  // The picks are chosen one at a time, best first, so the best 4 of a set are also the first 4 of its best 25:
  // a cover made from pickHighlights(source, 4) shows photos that are in the set's highlights
  const pickHighlights = (source: PhotoItem[], count: number, focus?: HighlightFocus) =>
    call<string[]>("pick_highlights", { candidates: highlightCandidates(source, culling, focus), count });

  async function choose(title: string, source: PhotoItem[], count: number, focus?: HighlightFocus) {
    setHighlights({ title, source, count, focus, hashes: null });
    try {
      const hashes = await pickHighlights(source, count, focus);
      setHighlights((h) => (h && h.title === title && h.count === count ? { ...h, hashes } : h));
    } catch (err) {
      setHighlights(null);
      setError(`Highlights: ${String(err)}`);
    }
  }

  const openHighlights = (title: string, source: PhotoItem[], count = 20, focus?: HighlightFocus) =>
    choose(title, source, count, focus);
  const setHighlightsCount = (count: number) =>
    highlights && choose(highlights.title, highlights.source, count, highlights.focus);

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
    pickHighlights,
    openHighlights,
    setHighlightsCount,
    showHighlightsInGrid,
    saveHighlightsAsAlbum,
  };
}
