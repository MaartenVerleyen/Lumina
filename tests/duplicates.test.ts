import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeIntoKeeper, type MergeablePhoto } from "../src/utils/duplicates.ts";

const photo = (over: Partial<MergeablePhoto> = {}): MergeablePhoto => ({
  rating: 0,
  flag: null,
  color_label: null,
  ai_caption: "",
  tags: [],
  people: [],
  ...over,
});

test("the kept copy takes over what the extras had", () => {
  const keep = photo({ rating: 2, tags: ["sea"], people: ["Bob"] });
  const merged = mergeIntoKeeper(keep, [
    photo({ rating: 4, flag: "pick", color_label: "red", ai_caption: "A beach", tags: ["sea", "holiday"], people: ["Anna"] }),
    photo({ flag: "reject" }),
  ]);
  assert.deepEqual(merged, {
    rating: 4,
    flag: "pick",
    color_label: "red",
    ai_caption: "A beach",
    tags: ["holiday", "sea"],
    people: ["Anna", "Bob"],
  });
});

test("what the kept copy already has wins, and a reject never spreads", () => {
  const keep = photo({ flag: "reject", color_label: "blue", ai_caption: "Mine" });
  const merged = mergeIntoKeeper(keep, [photo({ flag: "pick", color_label: "red", ai_caption: "Theirs" })]);
  assert.equal(merged.flag, "reject");
  assert.equal(merged.color_label, "blue");
  assert.equal(merged.ai_caption, "Mine");
  assert.equal(mergeIntoKeeper(photo(), [photo({ flag: "reject" })]).flag, null);
});
