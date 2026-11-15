import { test } from "node:test";
import assert from "node:assert/strict";
import { dropRecent, keepKnownRecent, renameRecent } from "../src/utils/recentFolders.ts";

test("a forgotten folder leaves the recent list, whatever its spelling", () => {
  assert.deepEqual(keepKnownRecent(["D:\\Photos\\", "E:\\Old"], ["d:\\photos"]), ["D:\\Photos\\"]);
  assert.deepEqual(dropRecent(["D:\\Photos", "E:\\Old"], "e:\\old\\"), ["D:\\Photos"]);
});

test("a located folder is listed at its new place, once", () => {
  assert.deepEqual(renameRecent(["D:\\Old", "D:\\Other"], "D:\\Old", "D:\\New"), ["D:\\New", "D:\\Other"]);
  assert.deepEqual(renameRecent(["D:\\Old", "D:\\New"], "D:\\Old", "D:\\New"), ["D:\\New"]);
});
