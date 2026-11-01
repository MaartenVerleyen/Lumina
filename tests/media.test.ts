import { test } from "node:test";
import assert from "node:assert/strict";
import { codecLabel, expandWithLivePairs, formatDuration, isLiveClip, isPlayableInWebView, isVideo, photosOnly } from "../src/utils/media.ts";

test("videos are told apart by media type, or by name for rows from before videos", () => {
  assert.equal(isVideo({ media_type: "video", name: "IMG_1.MOV" }), true);
  assert.equal(isVideo({ media_type: "photo", name: "IMG_1.JPG" }), false);
  assert.equal(isVideo({ name: "clip.mts" }), true);
  assert.equal(isVideo({ name: "IMG_1.HEIC" }), false);
});

test("durations read like a player's", () => {
  assert.equal(formatDuration(7_400), "0:07");
  assert.equal(formatDuration(272_000), "4:32");
  assert.equal(formatDuration(3_725_000), "1:02:05");
  assert.equal(formatDuration(null), "");
  assert.equal(formatDuration(undefined), "");
});

test("MP4 and MOV with H.264, HEVC, AV1 or VP9 play in the app; the rest needs converting", () => {
  assert.equal(isPlayableInWebView({ name: "IMG_1.MOV", video_codec: "hvc1" }), true);
  assert.equal(isPlayableInWebView({ name: "a.mp4", video_codec: "avc1" }), true);
  assert.equal(isPlayableInWebView({ name: "old.mp4", video_codec: "mp4v" }), false);
  assert.equal(isPlayableInWebView({ name: "00015.MTS", video_codec: null }), false);
  assert.equal(isPlayableInWebView({ name: "PICT.AVI", video_codec: "avc1" }), false);
});

test("codec names", () => {
  assert.equal(codecLabel("hvc1"), "HEVC");
  assert.equal(codecLabel("avc1"), "H.264");
  assert.equal(codecLabel("mp4v"), "MPEG-4");
  assert.equal(codecLabel(null), "");
});

test("photo-only features skip videos", () => {
  const items = [
    { hash: "a", name: "a.jpg", media_type: "photo" },
    { hash: "b", name: "b.mov", media_type: "video" },
  ];
  assert.deepEqual(photosOnly(items).map((p) => p.hash), ["a"]);
});

test("a Live Photo's photo and clip go together", () => {
  const items = [
    { hash: "photo", live_video_hash: "clip", live_photo_hash: null },
    { hash: "clip", live_video_hash: null, live_photo_hash: "photo" },
    { hash: "other", live_video_hash: null, live_photo_hash: null },
  ];
  assert.deepEqual(expandWithLivePairs(["photo"], items).sort(), ["clip", "photo"]);
  assert.deepEqual(expandWithLivePairs(["clip"], items).sort(), ["clip", "photo"]);
  assert.deepEqual(expandWithLivePairs(["other"], items), ["other"]);
  assert.equal(isLiveClip(items[1]), true);
  assert.equal(isLiveClip(items[0]), false);
});
