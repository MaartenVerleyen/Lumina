import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, notesSince, previousVersionOf, shouldShowWelcome } from "../src/utils/welcome.ts";

const NOTES = [
  { version: "3.8.0", items: [] },
  { version: "3.7.0", items: [] },
  { version: "3.6.0", items: [] },
];

test("version comparison", () => {
  assert.equal(compareVersions("3.10.0", "3.9.2"), 1);
  assert.equal(compareVersions("3.6", "3.6.0"), 0);
  assert.equal(compareVersions("3.6.0-beta", "3.6.0"), 0);
  assert.equal(compareVersions("2.9.9", "3.0.0"), -1);
});

test("where the user came from", () => {
  assert.equal(previousVersionOf(null, false), "");
  assert.equal(previousVersionOf(null, true), "unknown");
  assert.equal(previousVersionOf("3.5.0", true), "3.5.0");
});

test("notes between the previous and the current version", () => {
  const versions = (prev: string, cur: string) => notesSince(prev, cur, NOTES).map((n) => n.version);
  assert.deepEqual(versions("", "3.8.0"), [], "a fresh install gets the tour, not release notes");
  assert.deepEqual(versions("3.6.0", "3.8.0"), ["3.8.0", "3.7.0"]);
  assert.deepEqual(versions("3.7.0", "3.7.0"), []);
  assert.deepEqual(versions("unknown", "3.7.0"), ["3.7.0"]);
  assert.deepEqual(versions("3.6.0", "3.7.0"), ["3.7.0"], "notes for versions not installed yet stay hidden");
});

test("the tour comes back after an update", () => {
  assert.equal(shouldShowWelcome("3.6.0", null), true);
  assert.equal(shouldShowWelcome("3.6.0", "3.6.0"), false);
  assert.equal(shouldShowWelcome("3.7.0", "3.6.0"), true);
});
