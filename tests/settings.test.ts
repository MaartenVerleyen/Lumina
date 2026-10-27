import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.ts";

test("defaults when nothing is saved", () => {
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
});

test("saved values win, invalid ones fall back field by field", () => {
  const s = parseSettings({ simpleMode: true, gridStyle: "mosaic", cardDetails: "always", autoAdvance: "yes", extra: 1 });
  assert.equal(s.simpleMode, true);
  assert.equal(s.gridStyle, DEFAULT_SETTINGS.gridStyle);
  assert.equal(s.cardDetails, "always");
  assert.equal(s.autoAdvance, DEFAULT_SETTINGS.autoAdvance);
  assert.equal("extra" in s, false);
});

test("the old per-setting keys are read once, before anything was saved", () => {
  const legacy: Record<string, string> = {
    lumina_simple_mode: "true",
    lumina_grid_style: "square",
    lumina_card_details: "always",
  };
  const migrated = parseSettings(null, (k) => legacy[k] ?? null);
  assert.equal(migrated.simpleMode, true);
  assert.equal(migrated.gridStyle, "square");
  assert.equal(migrated.cardDetails, "always");
  // Once settings are saved, the old keys no longer matter
  assert.equal(parseSettings({}, (k) => legacy[k] ?? null).gridStyle, DEFAULT_SETTINGS.gridStyle);
});
