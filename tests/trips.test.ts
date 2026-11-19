// The rule that makes trips and big days is the engine's now (lumina-core moments.rs, with its own tests);
// the apps only label them
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDateRange, tripLabel } from "../src/utils/trips.ts";

const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);

test("labels: a name given wins over the engine's title, which wins over the place", () => {
  const trip = { start: at(2024, 6, 12), end: at(2024, 6, 15), place: "Paris & Versailles", title: "" };
  assert.equal(tripLabel(trip), "Paris & Versailles · 12–15 Jun 2024");
  assert.equal(tripLabel({ ...trip, title: "Weekend in Paris" }), "Weekend in Paris · 12–15 Jun 2024");
  assert.equal(tripLabel({ ...trip, title: "Weekend in Paris" }, "Paris with the kids"), "Paris with the kids · 12–15 Jun 2024");
  assert.equal(tripLabel({ ...trip, place: "" }), "12–15 Jun 2024");
});

test("date ranges", () => {
  assert.equal(formatDateRange(at(2024, 6, 12), at(2024, 6, 12)), "12 Jun 2024");
  assert.equal(formatDateRange(at(2024, 6, 30), at(2024, 7, 2)), "30 Jun – 2 Jul 2024");
  assert.equal(formatDateRange(at(2023, 12, 28), at(2024, 1, 3)), "28 Dec 2023 – 3 Jan 2024");
});
