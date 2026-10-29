import { test } from "node:test";
import assert from "node:assert/strict";
import { captureTime, highlightScore, highlightCandidates, isReceivedPhoto, onThisDay, type HighlightPhoto } from "../src/utils/highlights.ts";
import { DEFAULT_CULLING } from "../src/utils/culling.ts";

let n = 0;
const photo = (over: Partial<HighlightPhoto> = {}): HighlightPhoto => ({
  hash: `h${n++}`,
  rating: 0,
  flag: null,
  tags: [],
  people: [],
  captured_at: "2024-06-15 12:00:00",
  subfolder: "2024",
  width: 1920,
  height: 1280,
  sharpness: 300,
  faces: [],
  ...over,
});

test("capture time", () => {
  assert.equal(captureTime("2024:06:15 18:30:00"), Date.UTC(2024, 5, 15, 18, 30, 0) / 1000);
  assert.equal(captureTime("2024-06-15"), Date.UTC(2024, 5, 15) / 1000);
  assert.equal(captureTime(""), null);
  assert.equal(captureTime("0000:00:00 00:00:00"), null);
});

test("what counts in the score", () => {
  const plain = highlightScore(photo(), DEFAULT_CULLING)!;
  assert.ok(highlightScore(photo({ rating: 5 }), DEFAULT_CULLING)! > plain);
  assert.ok(highlightScore(photo({ flag: "pick" }), DEFAULT_CULLING)! > plain);
  assert.ok(highlightScore(photo({ people: ["Anna"] }), DEFAULT_CULLING)! > plain);
  const blink = photo({ faces: [{ bbox_w: 0.2, bbox_h: 0.2, eyes_open: -0.03, face_sharpness: 300 }] });
  const open = photo({ faces: [{ bbox_w: 0.2, bbox_h: 0.2, eyes_open: 0.01, face_sharpness: 300 }] });
  assert.ok(highlightScore(open, DEFAULT_CULLING)! > highlightScore(blink, DEFAULT_CULLING)!);
  // Never highlights
  for (const p of [
    photo({ flag: "reject" }),
    photo({ staged_target: "_Trash" }),
    photo({ subfolder: "_Trash" }),
    photo({ damaged: true }),
    photo({ tags: ["screenshot"] }),
  ]) {
    assert.equal(highlightScore(p, DEFAULT_CULLING), null);
  }
  assert.equal(highlightCandidates([photo(), photo({ flag: "reject" })], DEFAULT_CULLING).length, 1);
});

test("best of focuses on starred people and leaves out received photos", () => {
  const focus = { starred: new Set(["anna"]) };
  const score = (over: Partial<HighlightPhoto>) => highlightScore(photo(over), DEFAULT_CULLING, focus)!;
  const face = { bbox_w: 0.2, bbox_h: 0.2, eyes_open: 0.01, face_sharpness: 300 };
  const withAnna = score({ people: ["Anna"], faces: [face] });
  const withFriend = score({ people: ["Bob"], faces: [face] });
  const landscape = score({});
  assert.ok(withAnna > landscape && landscape > withFriend);
  // A rated photo of friends doesn't beat an unrated one of Anna
  assert.ok(withAnna > score({ people: ["Bob"], faces: [face], rating: 3 }));
  // Received through WhatsApp: down, unless a starred person is in it
  assert.ok(score({ name: "IMG-20230615-WA0001.jpg" }) < landscape);
  assert.ok(score({ subfolder: "WhatsApp Images" }) < landscape);
  assert.ok(score({ name: "IMG-20230615-WA0001.jpg", people: ["Anna"], faces: [face] }) > landscape);
  assert.equal(isReceivedPhoto({ name: "IMG_20230615_183000.jpg", subfolder: "2023", tags: [] }), false);
  // The scan's "whatsapp" tag counts too (e.g. a renamed file in a "WhatsApp Images" folder elsewhere)
  assert.equal(isReceivedPhoto({ name: "photo.jpg", subfolder: "2023", tags: ["whatsapp"] }), true);
  // Without a focus the score is unchanged
  assert.equal(highlightScore(photo({ people: ["Bob"] }), DEFAULT_CULLING), highlightScore(photo({ people: ["Bob"] }), DEFAULT_CULLING, undefined));
});

test("on this day: earlier years, newest first, best first", () => {
  const today = new Date(2026, 5, 15);
  const groups = onThisDay(
    [
      photo({ captured_at: "2024:06:15 10:00:00", hash: "a" }),
      photo({ captured_at: "2024:06:15 11:00:00", hash: "b", rating: 5 }),
      photo({ captured_at: "2019-06-15 09:00:00", hash: "c" }),
      photo({ captured_at: "2026-06-15 09:00:00", hash: "today" }),
      photo({ captured_at: "2024:06:16 10:00:00", hash: "next-day" }),
      photo({ captured_at: "2023:06:15 10:00:00", hash: "rejected", flag: "reject" }),
    ],
    today,
    DEFAULT_CULLING
  );
  assert.deepEqual(groups.map((g) => [g.yearsAgo, g.photos.map((p) => p.hash)]), [
    [2, ["b", "a"]],
    [7, ["c"]],
  ]);
});
