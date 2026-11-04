import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteTransport, faceIdFromPath, mediaPath, RECONNECTED } from "../src/api/remote.ts";

test("media URLs name the file by id, never by the server's path", () => {
  assert.equal(mediaPath({ kind: "thumb", hash: "abc123", path: "/data/thumbnails/abc123.jpg" }), "/media/thumb/abc123");
  assert.equal(mediaPath({ kind: "original", hash: "abc123", path: "/photos/a.jpg" }), "/media/original/abc123");
  assert.equal(mediaPath({ kind: "preview", hash: "abc123", path: "/data/transcodes/abc123.mp4" }), "/media/preview/abc123");
  assert.equal(mediaPath({ kind: "face", path: "/data/faces/abc123_12_34.jpg" }), "/media/face/abc123_12_34");
  assert.equal(faceIdFromPath("C:\\Users\\me\\AppData\\faces\\f1_2_3.jpg"), "f1_2_3");
  // An id can't climb out of its route
  assert.equal(mediaPath({ kind: "thumb", hash: "../../etc/passwd", path: "" }), "/media/thumb/..%2F..%2Fetc%2Fpasswd");
});

test("a server elsewhere gets its origin in front", () => {
  const t = createRemoteTransport({ base: "https://cachy.example.ts.net", fetch: async () => new Response("null") });
  assert.equal(t.mediaUrl({ kind: "thumb", hash: "h", path: "" }), "https://cachy.example.ts.net/media/thumb/h");
});

function fakeFetch(answer: () => Response | Promise<Response>) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

test("call posts the arguments with the X-Lumina header and returns the answer", async () => {
  const { fetch, requests } = fakeFetch(() => new Response(JSON.stringify([{ id: 1, name: "Trip" }])));
  const t = createRemoteTransport({ fetch });
  const albums = await t.call<{ id: number; name: string }[]>("get_albums", { rootFolder: "/photos" });
  assert.deepEqual(albums, [{ id: 1, name: "Trip" }]);
  assert.equal(requests[0].url, "/api/rpc/get_albums");
  assert.equal(requests[0].init?.method, "POST");
  assert.equal((requests[0].init?.headers as Record<string, string>)["X-Lumina"], "1");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { rootFolder: "/photos" });
  // A command that answers nothing (null), and one without arguments
  const empty = fakeFetch(() => new Response("null"));
  assert.equal(await createRemoteTransport({ fetch: empty.fetch }).call("watch_library"), null);
  assert.equal(empty.requests[0].init?.body, "{}");
});

test("errors come back as the server's own text, as a plain string (as from Tauri)", async () => {
  const server = fakeFetch(() => new Response(JSON.stringify({ error: "AI analysis cancelled" }), { status: 500 }));
  await assert.rejects(createRemoteTransport({ fetch: server.fetch }).call("ai_analyze_photo"), (e) => e === "AI analysis cancelled");

  const proxy = fakeFetch(() => new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
  await assert.rejects(createRemoteTransport({ fetch: proxy.fetch }).call("get_albums"), (e) => e === "The server answered 502 Bad Gateway");

  const offline = (async () => {
    throw new TypeError("NetworkError when attempting to fetch resource.");
  }) as typeof globalThis.fetch;
  await assert.rejects(
    createRemoteTransport({ fetch: offline }).call("get_albums"),
    (e) => typeof e === "string" && e.startsWith("Can't reach the server"),
  );
});

test("a 401 tells the app the session ended", async () => {
  let ended = 0;
  const { fetch } = fakeFetch(() => new Response(JSON.stringify({ error: "Not logged in" }), { status: 401 }));
  const t = createRemoteTransport({ fetch, onUnauthorized: () => ended++ });
  await assert.rejects(t.call("get_albums"), (e) => e === "Not logged in");
  assert.equal(ended, 1);
});

// A WebSocket stand-in the tests drive by hand
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
  receive(event: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ event, payload }) });
  }
}

test("events arrive through one shared WebSocket, to every subscriber of that event", async () => {
  FakeSocket.all = [];
  const t = createRemoteTransport({
    base: "https://cachy.example.ts.net",
    fetch: async () => new Response("null"),
    WebSocket: FakeSocket as unknown as typeof WebSocket,
  });
  const got: string[] = [];
  const offA = await t.subscribe<{ done: boolean }>("scan-progress", (e) => got.push(`a:${e.payload.done}`));
  await t.subscribe<{ done: boolean }>("scan-progress", (e) => got.push(`b:${e.payload.done}`));
  await t.subscribe("thumb-batch-ready", () => got.push("thumbs"));
  assert.equal(FakeSocket.all.length, 1, "one socket for all subscriptions");
  assert.equal(FakeSocket.all[0].url, "wss://cachy.example.ts.net/api/events");
  const ws = FakeSocket.all[0];
  ws.receive("scan-progress", { done: true });
  ws.receive("other-event", {});
  offA();
  ws.receive("scan-progress", { done: false });
  assert.deepEqual(got, ["a:true", "b:true", "b:false"]);
  t.close();
  assert.equal(ws.closed, true);
});

test("a dropped WebSocket reconnects while anyone listens", async () => {
  FakeSocket.all = [];
  const t = createRemoteTransport({
    base: "http://127.0.0.1:8080",
    fetch: async () => new Response("null"),
    WebSocket: FakeSocket as unknown as typeof WebSocket,
  });
  const off = await t.subscribe("scan-progress", () => {});
  let reconnected = 0;
  const offReconnected = await t.subscribe(RECONNECTED, () => reconnected++);
  assert.equal(FakeSocket.all[0].url, "ws://127.0.0.1:8080/api/events");
  FakeSocket.all[0].onopen?.();
  assert.equal(reconnected, 0, "the first connection is not a reconnect");
  FakeSocket.all[0].onclose?.();
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(FakeSocket.all.length, 2, "a new socket after the first pause");
  FakeSocket.all[1].onopen?.();
  assert.equal(reconnected, 1, "the window hears that it missed events");
  off();
  offReconnected();
  assert.equal(FakeSocket.all[1].closed, true, "the last subscriber leaving closes it");
  t.close();
});
