import { test } from "node:test";
import assert from "node:assert/strict";

// A stand-in for Tauri's window internals, before the transport module loads
(globalThis as Record<string, unknown>).window = {
  __TAURI_INTERNALS__: {
    convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`,
    invoke: async () => null,
  },
};
const { localMediaUrl } = await import("../src/api/transport.ts");

const server = { base: "http://127.0.0.1:41234", token: "t0k" };

test("Linux: videos and playable copies come from the local video server, with the token", () => {
  assert.equal(
    localMediaUrl({ kind: "original", hash: "h", path: "/home/me/Videos/Launch 1.MOV" }, server),
    "http://127.0.0.1:41234/video/t0k?path=%2Fhome%2Fme%2FVideos%2FLaunch%201.MOV",
  );
  assert.equal(
    localMediaUrl({ kind: "preview", hash: "h", path: "/data/transcodes/h.mp4" }, server),
    "http://127.0.0.1:41234/video/t0k?path=%2Fdata%2Ftranscodes%2Fh.mp4",
  );
});

test("photos, thumbnails and faces stay on asset://, and so does everything without the server", () => {
  assert.equal(localMediaUrl({ kind: "original", hash: "h", path: "/p/a.jpg" }, server), "asset://localhost/%2Fp%2Fa.jpg");
  assert.equal(localMediaUrl({ kind: "thumb", hash: "h", path: "/d/h.jpg" }, server), "asset://localhost/%2Fd%2Fh.jpg");
  assert.equal(localMediaUrl({ kind: "face", path: "/d/f.jpg" }, server), "asset://localhost/%2Fd%2Ff.jpg");
  assert.equal(localMediaUrl({ kind: "original", hash: "h", path: "C:\\v\\a.mp4" }, null), "asset://localhost/C%3A%5Cv%5Ca.mp4");
});
