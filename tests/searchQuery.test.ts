import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSearchQuery,
  matchesTerms,
  removeTerm,
  describeTerm,
  termBeingTyped,
  completeTerm,
} from "../src/utils/searchQuery.ts";

const photo = {
  hash: "h1",
  name: "IMG_0001.CR3",
  rating: 4,
  flag: "pick" as const,
  color_label: "red",
  people: ["Anna", "Bert"],
  tags: ["beach", "sunset"],
  camera_model: "Canon EOS R6",
  lens_model: "RF 24-105mm",
  location: "Knokke, BE",
  captured_at: "2024:06:15 18:30:00",
  latitude: 51.3,
  longitude: 3.3,
  faces: [{}],
  ocr_text: "",
  ai_caption: "A sunset on the beach",
  pair_raw_path: "D:\\IMG_0001.CR3",
  damaged: false,
  staged_target: null,
  in_basket: true,
};

const match = (q: string, ctx = {}) => matchesTerms(photo, parseSearchQuery(q).terms, ctx);

test("terms and free text are separated; quotes keep spaces", () => {
  const p = parseSearchQuery('rating:>=4 camera:"EOS R6" dog on the beach -flag:reject');
  assert.deepEqual(
    p.terms.map((t) => [t.key, t.op, t.value, t.negate]),
    [
      ["rating", ">=", "4", false],
      ["camera", "=", "EOS R6", false],
      ["flag", "=", "reject", true],
    ]
  );
  assert.equal(p.text, "dog on the beach");
});

test("unknown keys and unfinished terms are text / ignored", () => {
  const p = parseSearchQuery("http://x person: hello");
  assert.equal(p.terms.length, 0);
  assert.equal(p.text, "http://x hello");
});

test("each term kind matches", () => {
  assert.ok(match("rating:>=4"));
  assert.ok(!match("rating:5"));
  assert.ok(match("flag:pick label:red"));
  assert.ok(match("person:anna tag:beach"));
  assert.ok(!match("person:ann"));
  assert.ok(match("camera:r6 lens:24-105 place:knokke name:0001"));
  assert.ok(match("has:gps has:faces has:caption is:raw is:paired is:basket"));
  assert.ok(!match("has:ocr"));
  assert.ok(!match("is:staged"));
});

test("negation flips a term", () => {
  assert.ok(match("-flag:reject"));
  assert.ok(!match("-person:anna"));
});

test("dates match by prefix, ranges and comparisons", () => {
  assert.ok(match("date:2024"));
  assert.ok(match("date:2024-06"));
  assert.ok(match("date:2024-06-15"));
  assert.ok(!match("date:2024-07"));
  assert.ok(match("date:2024-06-01..2024-06-30"));
  assert.ok(match("date:2023..2024"));
  assert.ok(match("date:<2025"));
  assert.ok(!match("date:>=2025"));
  assert.ok(!matchesTerms({ ...photo, captured_at: "" }, parseSearchQuery("date:2024").terms));
});

test("albums are looked up by name", () => {
  const ctx = { albumHashes: (n: string) => (n.toLowerCase() === "holiday 2024" ? new Set(["h1"]) : undefined) };
  assert.ok(match('album:"Holiday 2024"', ctx));
  assert.ok(!match("album:Other", ctx));
});

test("chips: describe and remove a term", () => {
  const q = 'rating:>=4 tag:beach sunset';
  const [rating] = parseSearchQuery(q).terms;
  assert.equal(describeTerm(rating), "Rating: ≥ 4");
  assert.equal(removeTerm(q, rating), "tag:beach sunset");
});

test("autocomplete finds and completes the term being typed", () => {
  assert.deepEqual(termBeingTyped("sunset person:an"), { key: "person", partial: "an", start: 7 });
  assert.equal(termBeingTyped("sunset"), null);
  assert.equal(completeTerm("sunset person:an", "person", "Anna Smith"), 'sunset person:"Anna Smith" ');
  assert.equal(completeTerm("-tag:be", "tag", "beach"), "-tag:beach ");
});
