import { useMemo } from "react";
import { interpretNatural } from "../../utils/naturalQuery";
import type { SearchTerm } from "../../utils/searchQuery";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";

// The search box understood: the typed key:value terms plus what plain words mean ("emma at the beach summer
// 2024" -> Emma, summer 2024, "at the beach"). Replaces `parsedSearch` for everything that filters or
// searches; typed terms win over understood ones of the same kind.
export function useNaturalSearch(core: LibraryCore, filters: FilterState) {
  const { photos } = core;
  const { parsedSearch } = filters;

  // Names and places this library knows, from its photos
  const vocabulary = useMemo(() => {
    const people = new Set<string>();
    const places = new Set<string>();
    for (const p of photos) {
      for (const name of p.people) people.add(name);
      const city = p.location.split(",")[0].trim();
      if (city) places.add(city);
    }
    return { people: Array.from(people), places: Array.from(places) };
  }, [photos]);

  const natural = useMemo(() => {
    const typed = new Set<SearchTerm["key"]>(parsedSearch.terms.map((t) => t.key));
    return interpretNatural(parsedSearch.text, { ...vocabulary, today: new Date() }, typed);
  }, [parsedSearch, vocabulary]);

  // One object per change of the query (effects and memos downstream depend on its identity)
  const understood = useMemo(
    () => ({ terms: [...parsedSearch.terms, ...natural.terms], text: natural.rest }),
    [parsedSearch, natural]
  );
  return { parsedSearch: understood };
}
