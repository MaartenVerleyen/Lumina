import { useMemo } from "react";
import { TermKey } from "../utils/searchQuery";
import type { LibraryState } from "../hooks/useLibraryState";

// Autocomplete values for search terms (person:, tag:, camera: ...), from the open library
export function useSearchSuggestions(lib: LibraryState) {
  const searchValues = useMemo(() => {
    const cameras = new Set<string>();
    const lenses = new Set<string>();
    const places = new Set<string>();
    const years = new Set<string>();
    for (const p of lib.photos) {
      if (p.camera_model) cameras.add(p.camera_model);
      if (p.lens_model) lenses.add(p.lens_model);
      if (p.location) places.add(p.location.split(",")[0].trim());
      const y = /^(\d{4})/.exec(p.captured_at || "")?.[1];
      if (y) years.add(y);
    }
    const sorted = (s: Set<string>) => Array.from(s).sort((a, b) => a.localeCompare(b));
    return {
      camera: sorted(cameras),
      lens: sorted(lenses),
      place: sorted(places),
      date: Array.from(years).sort().reverse(),
    };
  }, [lib.photos]);

  const getSearchSuggestions = (key: TermKey, partial: string): string[] => {
    const fixed: Partial<Record<TermKey, string[]>> = {
      rating: ["5", ">=4", ">=3", ">=1", "0"],
      flag: ["pick", "reject", "none"],
      label: ["red", "yellow", "green", "blue", "none"],
      has: ["gps", "faces", "people", "caption", "ocr", "tags", "location"],
      is: ["raw", "paired", "screenshot", "damaged", "staged", "basket", "pick", "reject"],
    };
    const values =
      fixed[key] ??
      (key === "person"
        ? lib.people.map((p) => p.name)
        : key === "tag"
        ? lib.allLibraryTags
        : key === "album"
        ? lib.albums.map((a) => a.name)
        : key === "camera" || key === "lens" || key === "place" || key === "date"
        ? searchValues[key]
        : []);
    const q = partial.toLowerCase();
    return values
      .filter((v) => v.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)))
      .slice(0, 8);
  };

  return getSearchSuggestions;
}
