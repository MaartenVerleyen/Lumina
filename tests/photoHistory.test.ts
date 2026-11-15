import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseChanges, describeChange } from "../src/utils/photoHistory.ts";

test("a change reads as who did what, a removed account as someone", () => {
  assert.equal(describeChange({ user: "anna", what: "set_photos_rating" }), "anna changed the stars");
  assert.equal(describeChange({ user: "", what: "add_tag_batch" }), "Someone added a tag");
  assert.equal(describeChange({ user: "bob", what: "some_new_command" }), "bob some new command");
});

test("the same change by the same person in a row shows once, newest first", () => {
  const rows = collapseChanges([
    { at: 30, user: "anna", what: "set_photos_rating" },
    { at: 20, user: "anna", what: "set_photos_rating" },
    { at: 15, user: "anna", what: "set_photo_rotation" },
    { at: 12, user: "anna", what: "set_photos_rotation_exact" },
    { at: 10, user: "bob", what: "set_photos_rating" },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.user, r.what, r.at, r.times]),
    [
      ["anna", "set_photos_rating", 30, 2],
      ["anna", "set_photo_rotation", 15, 2],
      ["bob", "set_photos_rating", 10, 1],
    ]
  );
});
