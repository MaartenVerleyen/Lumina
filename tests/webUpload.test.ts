import { test } from "node:test";
import assert from "node:assert/strict";
import { contentHash, fullHash, uploadFile, CHUNK } from "../src/api/webUpload.ts";

// The bytes the Rust test uses (src-tauri/src/transfer_tests.rs): i * 7 % 251
function data(len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * 7) % 251;
  return out;
}

test("the browser's content hash is the engine's", async () => {
  // Values from the engine (content_hashes_the_web_client_must_match): small, middle-sized and large files
  assert.equal(await contentHash(new Blob([data(1000)])), "bd91fa512b0279ff");
  assert.equal(await contentHash(new Blob([data(100_000)])), "0e9c6db44d423af1");
  assert.equal(await contentHash(new Blob([data(300_000)])), "a234c95ba48f1e05");
  assert.equal(await fullHash(new Blob([data(1000)])), "90efbe734bb8adacfe512443dc45cae7efdde5d1848157b29cf1489d25af0933");
});

test("an upload resumes where the server stands and follows a 409", async () => {
  const file = new File([data(CHUNK + 10)], "a.jpg", { lastModified: 1_700_000_000_000 });
  const calls: string[] = [];
  let stored = 0;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const path = String(url);
    calls.push(`${init.method} ${path}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === "/api/upload") {
      const body = JSON.parse(String(init.body));
      assert.equal(body.modified, 1_700_000_000);
      // An earlier try got the first chunk there, but the server says 0: the 409 puts it right
      stored = CHUNK;
      return json({ id: "u1", received: 0 });
    }
    if (path === "/api/upload/u1") {
      const offset = Number((init.headers as Record<string, string>)["Upload-Offset"]);
      if (offset !== stored) return json({ error: "wrong offset", offset: stored }, 409);
      stored += (init.body as Blob).size;
      return json({ received: stored });
    }
    if (path === "/api/upload/u1/finish") return json({ hash: "abc" });
    return json({ error: "unknown" }, 404);
  }) as unknown as typeof fetch;
  const progress: number[] = [];
  const photo = await uploadFile(file, { hash: "h", full_hash: "f" }, { fetch: fakeFetch, onProgress: (n) => progress.push(n) });
  assert.deepEqual(photo, { hash: "abc" });
  assert.deepEqual(calls, ["POST /api/upload", "PUT /api/upload/u1", "PUT /api/upload/u1", "POST /api/upload/u1/finish"]);
  assert.equal(progress.at(-1), CHUNK + 10);
});
