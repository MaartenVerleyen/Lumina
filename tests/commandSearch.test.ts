import { test } from "node:test";
import assert from "node:assert/strict";
import { rankActions } from "../src/utils/commandSearch.ts";

const noop = () => {};
const actions = [
  { id: "faces", label: "Scan faces", group: "Faces", run: noop },
  { id: "review", label: "Review face matches", group: "Faces", keywords: "people suggestions", run: noop },
  { id: "pick", label: "Flag as pick", group: "Triage", shortcut: "P", run: noop },
  { id: "stop", label: "Stop face scan", group: "Faces", enabled: false, run: noop },
  { id: "map", label: "Map view", group: "View", run: noop },
];

test("every typed word must match; label prefix ranks first", () => {
  // Both match at a word start; the shorter label wins the tie
  assert.deepEqual(rankActions(actions, "face").map((a) => a.id), ["faces", "review"]);
  assert.deepEqual(rankActions(actions, "flag").map((a) => a.id), ["pick"]);
  assert.deepEqual(rankActions(actions, "scan face").map((a) => a.id), ["faces"]);
  assert.deepEqual(rankActions(actions, "map").map((a) => a.id), ["map"]);
});

test("keywords and groups are searchable, disabled actions are hidden", () => {
  assert.deepEqual(rankActions(actions, "people").map((a) => a.id), ["review"]);
  assert.deepEqual(rankActions(actions, "triage").map((a) => a.id), ["pick"]);
  assert.ok(!rankActions(actions, "stop").some((a) => a.id === "stop"));
  assert.equal(rankActions(actions, "").length, 4);
});
