import { test } from "node:test";
import assert from "node:assert/strict";
import { hasClosedEyes, isSoftFocus, cullScore, type CullingPhoto } from "../src/utils/culling.ts";

const face = (size: number, eyes: number | null, sharp: number | null) => ({
  bbox_w: size,
  bbox_h: size,
  eyes_open: eyes,
  face_sharpness: sharp,
});
const photo = (faces: ReturnType<typeof face>[], sharpness = 100): CullingPhoto => ({ width: 1920, height: 1280, sharpness, faces });

test("closed eyes: any face big enough to judge", () => {
  assert.equal(hasClosedEyes(photo([face(0.2, 0.004, 300)])), false);
  assert.equal(hasClosedEyes(photo([face(0.2, 0.004, 300), face(0.1, -0.02, 300)])), true);
  assert.equal(hasClosedEyes(photo([face(0.01, -0.02, 300)])), false, "a face in the far background is too small");
  assert.equal(hasClosedEyes(photo([face(0.2, null, 300)])), false, "not measured yet");
  assert.equal(hasClosedEyes(photo([face(0.2, -0.011, 300)])), false, "normal sensitivity");
  assert.equal(hasClosedEyes(photo([face(0.2, -0.011, 300)]), { eyes: "high", focus: "normal" }), true);
  assert.equal(hasClosedEyes(photo([face(0.2, -0.02, 300)]), { eyes: "off", focus: "normal" }), false);
});

test("soft focus: judged on the main face only", () => {
  assert.equal(isSoftFocus(photo([face(0.3, 0.01, 20)])), true);
  assert.equal(isSoftFocus(photo([face(0.3, 0.01, 300), face(0.1, 0.01, 5)])), false, "a soft face in the background is fine");
  assert.equal(isSoftFocus(photo([face(0.02, 0.01, 5)])), false, "too small to judge");
  assert.equal(isSoftFocus(photo([])), false, "no faces: the photo's own sharpness is shown elsewhere");
  assert.equal(isSoftFocus(photo([face(0.3, 0.01, 60)]), { eyes: "normal", focus: "high" }), true);
  // An unsure detection (here a dog's face) is not judged
  assert.equal(isSoftFocus(photo([{ ...face(0.3, 0.01, 20), confidence: 0.57 }])), false);
  assert.equal(hasClosedEyes(photo([{ ...face(0.3, -0.02, 300), confidence: 0.57 }])), false);
});

test("best of a burst: open eyes beat sharpness, then the sharpest face wins", () => {
  const blink = photo([face(0.3, -0.02, 900)]);
  const soft = photo([face(0.3, 0.01, 20)]);
  const good = photo([face(0.3, 0.01, 300)]);
  const better = photo([face(0.3, 0.01, 600)]);
  const ranked = [blink, soft, good, better].sort((a, b) => cullScore(b) - cullScore(a));
  assert.deepEqual(ranked, [better, good, soft, blink]);
  // Without faces the photo's own sharpness decides
  assert.ok(cullScore(photo([], 500)) > cullScore(photo([], 50)));
});
