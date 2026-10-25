import { test } from "node:test";
import assert from "node:assert/strict";
import { expandWithRawPairs, diskPathOf } from "../src/utils/rawPairs.ts";

// Mirrors what scan_folder returns: the RAW item's pair_raw_path is its own original path,
// the JPEG's pair_raw_path is the path of its partner RAW.
const photos = [
  { hash: "raw1", name: "IMG_0001.CR3", pair_raw_path: "D:\\Shoot\\IMG_0001.CR3" },
  { hash: "jpg1", name: "IMG_0001.JPG", pair_raw_path: "D:\\Shoot\\IMG_0001.CR3" },
  { hash: "jpg2", name: "IMG_0002.JPG", pair_raw_path: null },
  { hash: "heic1", name: "IMG_0003.HEIC", pair_raw_path: "D:\\Shoot\\IMG_0003.HEIC" },
];

test("selecting a JPEG also selects its RAW", () => {
  assert.deepEqual(expandWithRawPairs(["jpg1"], photos).sort(), ["jpg1", "raw1"]);
});

test("selecting a RAW also selects its JPEG", () => {
  assert.deepEqual(expandWithRawPairs(["raw1"], photos).sort(), ["jpg1", "raw1"]);
});

test("unpaired photos stay alone", () => {
  assert.deepEqual(expandWithRawPairs(["jpg2"], photos), ["jpg2"]);
  assert.deepEqual(expandWithRawPairs(["heic1"], photos), ["heic1"]);
});

test("path matching ignores case", () => {
  const mixedCase = [
    { hash: "raw1", name: "IMG_0001.CR3", pair_raw_path: "d:\\shoot\\img_0001.cr3" },
    { hash: "jpg1", name: "IMG_0001.JPG", pair_raw_path: "D:\\Shoot\\IMG_0001.CR3" },
  ];
  assert.deepEqual(expandWithRawPairs(["jpg1"], mixedCase).sort(), ["jpg1", "raw1"]);
});

test("diskPathOf returns each photo's own original file", () => {
  const preview = "C:\\AppData\\previews\\raw1_preview.jpg";
  assert.equal(
    diskPathOf({ name: "IMG_0001.CR3", path: preview, pair_raw_path: "D:\\Shoot\\IMG_0001.CR3" }),
    "D:\\Shoot\\IMG_0001.CR3"
  );
  // A paired JPEG must open the JPEG, not its RAW partner
  assert.equal(
    diskPathOf({ name: "IMG_0001.JPG", path: "D:\\Shoot\\IMG_0001.JPG", pair_raw_path: "D:\\Shoot\\IMG_0001.CR3" }),
    "D:\\Shoot\\IMG_0001.JPG"
  );
  assert.equal(diskPathOf({ name: "a.jpg", path: "D:\\a.jpg", pair_raw_path: null }), "D:\\a.jpg");
});

test("no duplicates when both halves are already selected", () => {
  assert.deepEqual(expandWithRawPairs(["jpg1", "raw1"], photos).sort(), ["jpg1", "raw1"]);
});
