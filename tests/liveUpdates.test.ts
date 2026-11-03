import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFreshPhoto } from "../src/utils/freshPhoto.ts";
import { createRemoteTransport, hasRole } from "../src/api/remote.ts";
import type { PhotoItem } from "../src/types/lumina.ts";

const photo = (over: Partial<PhotoItem>) => ({ hash: "h", name: "a.jpg", rating: 0, tags: [], people: [], ...over }) as PhotoItem;

test("a photo another user changed takes the server's fields, but keeps the library-wide links", () => {
  const mine = photo({ rating: 1, tags: [], duplicate_group: 7, live_video_hash: "clip", thumb_rev: 3, pair_raw_path: "/p/a.dng" });
  const fresh = photo({ rating: 4, tags: ["beach"], duplicate_group: null, live_video_hash: null, pair_raw_path: null });
  const merged = mergeFreshPhoto(mine, fresh);
  assert.equal(merged.rating, 4);
  assert.deepEqual(merged.tags, ["beach"]);
  assert.equal(merged.duplicate_group, 7, "burst groups are worked out over the whole library");
  assert.equal(merged.live_video_hash, "clip");
  assert.equal(merged.thumb_rev, 3);
  assert.equal(merged.pair_raw_path, "/p/a.dng");
});

test("roles rank guest < viewer < uploader < editor < admin", () => {
  assert.equal(hasRole({ role: "editor" }, "viewer"), true);
  assert.equal(hasRole({ role: "editor" }, "editor"), true);
  assert.equal(hasRole({ role: "editor" }, "admin"), false);
  assert.equal(hasRole({ role: "viewer" }, "editor"), false);
  assert.equal(hasRole({ role: "guest" }, "viewer"), false);
  assert.equal(hasRole(null, "guest"), false);
});

test("every call names its window, so the window can skip the echo of its own changes", async () => {
  const seen: Record<string, string>[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    seen.push(init?.headers as Record<string, string>);
    return new Response("null");
  }) as typeof globalThis.fetch;
  const t = createRemoteTransport({ fetch, clientId: "window-1" });
  await t.call("set_photos_rating", { hashes: ["h"], rating: 3 });
  assert.equal(t.clientId, "window-1");
  assert.equal(seen[0]["X-Lumina-Client"], "window-1");
  const other = createRemoteTransport({ fetch });
  assert.notEqual(other.clientId, "window-1");
  assert.ok(other.clientId.length >= 6);
});
