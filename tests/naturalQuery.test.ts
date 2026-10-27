import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretNatural } from "../src/utils/naturalQuery.ts";
import { matchesTerms } from "../src/utils/searchQuery.ts";

const ctx = {
  people: ["Emma", "Lucas", "Anna Smith", "Noah", "June"],
  places: ["Paris", "Lagos", "Antwerpen", "New York"],
  today: new Date(2026, 9, 27), // 27 Oct 2026
};
const parse = (q: string) => {
  const r = interpretNatural(q, ctx);
  return { terms: r.terms.map((t) => `${t.key}:${t.value}`), rest: r.rest, labels: r.parts.map((p) => p.label) };
};

test("people, dates and places from plain words", () => {
  assert.deepEqual(parse("emma and lucas at the beach summer 2024"), {
    terms: ["person:Emma", "person:Lucas", "date:2024-06-01..2024-08-31"],
    rest: "at the beach",
    labels: ["Emma", "Lucas", "summer 2024"],
  });
  assert.deepEqual(parse("photos of emma in paris").terms, ["person:Emma", "place:Paris"]);
  assert.equal(parse("photos of emma in paris").rest, "");
  assert.deepEqual(parse("emma or noah").terms, ["person:Emma|Noah"]);
  assert.deepEqual(parse("anna in new york").terms, ["person:Anna Smith", "place:New York"], "first name and two-word place");
});

test("Dutch", () => {
  assert.deepEqual(parse("emma en lucas aan zee in de zomer van 2023"), {
    terms: ["person:Emma", "person:Lucas", "date:2023-06-01..2023-08-31"],
    rest: "aan zee",
    labels: ["Emma", "Lucas", "summer 2023"],
  });
  assert.deepEqual(parse("kerst 2023").terms, ["date:2023-12-24..2023-12-26"]);
  assert.deepEqual(parse("vorig jaar in lagos").terms, ["date:2025", "place:Lagos"]);
  assert.deepEqual(parse("emma of noah").terms, ["person:Emma|Noah"]);
});

test("dates", () => {
  assert.deepEqual(parse("christmas").terms, ["date:*-12-24..*-12-26"]);
  assert.deepEqual(parse("june 2024").terms, ["person:June", "date:2024"], "a person called June wins over the month");
  assert.deepEqual(interpretNatural("juni 2024", { ...ctx, people: [] }).terms.map((t) => t.value), ["2024-06"]);
  assert.deepEqual(parse("last summer").terms, ["date:2026-06-01..2026-08-31"]);
  assert.deepEqual(parse("winter 2024").terms, ["date:2024-12-01..2025-02-28"]);
  assert.deepEqual(parse("last month").terms, ["date:2026-09"]);
  assert.deepEqual(parse("you may like it").terms, [], "'may' alone is not a month");
  assert.deepEqual(parse("dog playing outside"), { terms: [], rest: "dog playing outside", labels: [] });
});

test("any-year dates match the right days", () => {
  const photo = (captured_at: string) => ({
    hash: "x", name: "x.jpg", rating: 0, flag: null, color_label: null, people: [], tags: [], camera_model: "",
    location: "", captured_at, faces: [], ocr_text: "", ai_caption: "",
  });
  const t = (value: string) => [{ key: "date" as const, op: "=" as const, value, negate: false, raw: "" }];
  assert.equal(matchesTerms(photo("2019:12:25 10:00:00"), t("*-12-24..*-12-26")), true);
  assert.equal(matchesTerms(photo("2019:12:27 10:00:00"), t("*-12-24..*-12-26")), false);
  assert.equal(matchesTerms(photo("2021:01:15 10:00:00"), t("*-12-01..*-02-28")), true, "winter wraps the new year");
  assert.equal(matchesTerms(photo("2021:06:15 10:00:00"), t("*-12-01..*-02-28")), false);
  assert.equal(matchesTerms(photo("2018:06:02 10:00:00"), t("*-06")), true);
});

test("removing an understood part takes its little word along", async () => {
  const { removeUnderstood } = await import("../src/utils/naturalQuery.ts");
  assert.equal(removeUnderstood("lily and emma in antwerpen", "antwerpen"), "lily and emma");
  assert.equal(removeUnderstood("lily and emma in antwerpen", "emma"), "lily in antwerpen");
  assert.equal(removeUnderstood("emma at the beach summer 2024", "summer 2024"), "emma at the beach");
});
