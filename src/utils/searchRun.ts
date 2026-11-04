// What a search finds among a library's photos, as one pure function. The grid applies the same steps among
// its other filters (useNaturalSearch, useLibraryView); the server runs a copy of this in Rust for shared
// dynamic albums (lumina-core search.rs). tests/fixtures/search-cases.json keeps the two in step.
import { interpretNatural } from "./naturalQuery.ts";
import { matchesTerms, parseSearchQuery, type MatchablePhoto, type MatchContext, type SearchTerm } from "./searchQuery.ts";
import { SEMANTIC_MAX_HITS, semanticCutoff } from "./semanticCutoff.ts";

export interface SearchPhoto extends MatchablePhoto {
  width: number;
  height: number;
  sharpness: number;
  live_photo_hash?: string | null;
}

// Names and places the library knows, from its photos: plain words in a query are read against these
export function searchVocabulary(photos: Pick<MatchablePhoto, "people" | "location">[]): { people: string[]; places: string[] } {
  const people = new Set<string>();
  const places = new Set<string>();
  for (const p of photos) {
    for (const name of p.people) people.add(name);
    const city = p.location.split(",")[0].trim();
    if (city) places.add(city);
  }
  return { people: Array.from(people), places: Array.from(places) };
}

// The typed key:value terms plus what plain words mean; typed terms win over understood ones of the same kind
export function understandQuery(
  query: string,
  vocabulary: { people: string[]; places: string[] },
  today: Date
): { terms: SearchTerm[]; text: string } {
  const parsed = parseSearchQuery(query);
  const typed = new Set<SearchTerm["key"]>(parsed.terms.map((t) => t.key));
  const natural = interpretNatural(parsed.text, { ...vocabulary, today }, typed);
  return { terms: [...parsed.terms, ...natural.terms], text: natural.rest };
}

// The text plain search looks in, lower-cased
export function searchTextFields(p: Pick<MatchablePhoto, "name" | "ai_caption" | "ocr_text" | "location" | "tags" | "people">): string {
  return [p.name, p.ai_caption, p.ocr_text, p.location, ...p.tags, ...p.people].join("\n").toLowerCase();
}

export interface SearchRunContext extends MatchContext {
  today: Date;
  // Smart search on: free text ranks by these scores (hash -> CLIP score) instead of matching words
  semanticScores?: Map<string, number>;
}

// The photos a saved search shows, in the order the grid shows smart search hits (best first) or as given
export function runSearch<P extends SearchPhoto>(photos: P[], query: string, ctx: SearchRunContext): P[] {
  const { terms, text } = understandQuery(query, searchVocabulary(photos), ctx.today);
  const scores = ctx.semanticScores && text !== "" ? ctx.semanticScores : null;
  const q = scores ? "" : text.toLowerCase();
  const kept = photos.filter((p) => {
    // A Live Photo's clip plays from its photo
    if (p.live_photo_hash) return false;
    if (q && !searchTextFields(p).includes(q)) return false;
    if (terms.length > 0 && !matchesTerms(p, terms, ctx)) return false;
    if (scores && !scores.has(p.hash)) return false;
    return true;
  });
  if (!scores) return kept;
  const ranked = kept.sort((a, b) => (scores.get(b.hash) ?? 0) - (scores.get(a.hash) ?? 0));
  const line = semanticCutoff(ranked.map((p) => scores.get(p.hash) ?? 0));
  return ranked.filter((p) => (scores.get(p.hash) ?? 0) >= line).slice(0, SEMANTIC_MAX_HITS);
}
