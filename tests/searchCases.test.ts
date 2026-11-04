// The shared search examples: the server's Rust copy of the search language (lumina-core search.rs) runs the
// same file in its tests, so both find the same photos for every query
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runSearch, type SearchPhoto } from "../src/utils/searchRun.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/search-cases.json", import.meta.url), "utf8"));
const [y, m, d] = fixture.today.split("-").map(Number);
const albums = new Map<string, Set<string>>(
  Object.entries(fixture.albums as Record<string, string[]>).map(([name, hashes]) => [name.toLowerCase(), new Set(hashes)])
);
const ctx = { today: new Date(y, m - 1, d), albumHashes: (name: string) => albums.get(name.toLowerCase()) };
const photos: SearchPhoto[] = fixture.photos.map((p: Partial<SearchPhoto>) => ({
  name: "", rating: 0, flag: null, color_label: null, people: [], tags: [], camera_model: "", location: "",
  captured_at: "", faces: [], ocr_text: "", ai_caption: "", width: 0, height: 0, sharpness: 0, ...p,
}));

test("every shared search example finds its photos", () => {
  for (const c of fixture.cases) {
    assert.deepEqual(runSearch(photos, c.query, ctx).map((p) => p.hash), c.expect, `query ${JSON.stringify(c.query)}`);
  }
});

test("smart search examples rank and cut like the grid", () => {
  const semanticScores = new Map<string, number>(Object.entries(fixture.smart.scores));
  for (const c of fixture.smart.cases) {
    assert.deepEqual(runSearch(photos, c.query, { ...ctx, semanticScores }).map((p) => p.hash), c.expect, `query ${JSON.stringify(c.query)}`);
  }
});
