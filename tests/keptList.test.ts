import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDifferences, type KeptList, type KeptLists } from "../src/api/keptList.ts";
import { createRemoteTransport } from "../src/api/remote.ts";

type P = { hash: string; v?: number };
const list: P[] = [
  { hash: "a", v: 1 },
  { hash: "b", v: 1 },
  { hash: "c", v: 1 },
];

// The same cases as lumina-core's list_changes tests: both sides must agree on what a server's differences mean
test("differences bring a kept list up to date", () => {
  assert.deepEqual(applyDifferences(list, { changed: [], removed: [] }), list);

  // b changed, c went, d came first, e and f after b (f after e)
  const changed = applyDifferences(list, {
    changed: [
      { after: null, photo: { hash: "d", v: 1 } },
      { after: "a", photo: { hash: "b", v: 2 } },
      { after: "b", photo: { hash: "e", v: 1 } },
      { after: "e", photo: { hash: "f", v: 1 } },
    ],
    removed: ["c"],
  });
  assert.deepEqual(changed, [
    { hash: "d", v: 1 },
    { hash: "a", v: 1 },
    { hash: "b", v: 2 },
    { hash: "e", v: 1 },
    { hash: "f", v: 1 },
  ]);

  // A photo that went and came back sits where the differences put it
  assert.deepEqual(applyDifferences(list, { changed: [{ after: null, photo: { hash: "c", v: 3 } }], removed: ["c"] }), [
    { hash: "c", v: 3 },
    { hash: "a", v: 1 },
    { hash: "b", v: 1 },
  ]);

  // Everything gone, and an empty list filled
  assert.deepEqual(applyDifferences(list, { changed: [], removed: ["a", "b", "c"] }), []);
  assert.deepEqual(applyDifferences([], { changed: [{ after: null, photo: { hash: "x" } }], removed: [] }), [{ hash: "x" }]);

  // A new photo after one this list doesn't have: not this list's differences
  assert.equal(applyDifferences(list, { changed: [{ after: "zz", photo: { hash: "g" } }], removed: [] }), null);
});

function memoryKeptLists() {
  const lists = new Map<string, KeptList>();
  const kept: KeptLists = {
    tag: async (key) => lists.get(key)?.tag ?? null,
    text: async (key) => lists.get(key)?.text ?? null,
    put: async (key, l) => void lists.set(key, l),
    clear: async () => lists.clear(),
  };
  return { kept, lists };
}

// A stand-in server: answers scan_folder as lumina-server's kept_listing does, and notes the headers it got
function standIn(answers: ((h: Record<string, string>) => Response)[]) {
  const got: Record<string, string>[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    got.push(h);
    return answers.shift()!(h);
  }) as typeof globalThis.fetch;
  return { fetch, got };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("a library's list is kept with its tag; the server then says 'still that one' or sends what differs", async () => {
  const { kept, lists } = memoryKeptLists();
  const server = standIn([
    // First visit: the whole list, with a tag
    () => new Response(JSON.stringify(list), { headers: { etag: '"1"' } }),
    // Nothing changed
    () => new Response(null, { status: 304, headers: { etag: '"1"' } }),
    // b was rated: only b, from list "1"
    () =>
      new Response(JSON.stringify({ changed: [{ after: "a", photo: { hash: "b", v: 5 } }], removed: [] }), {
        headers: { etag: '"2"', "X-Lumina-Differences": '"1"' },
      }),
    // Differences from a list this browser doesn't have: the whole list is asked for again
    () =>
      new Response(JSON.stringify({ changed: [{ after: "zz", photo: { hash: "q" } }], removed: [] }), {
        headers: { etag: '"3"', "X-Lumina-Differences": '"2"' },
      }),
    () => new Response(JSON.stringify([{ hash: "q" }]), { headers: { etag: '"3"' } }),
  ]);
  const t = createRemoteTransport({ fetch: server.fetch, keptLists: kept });
  const args = { folderPath: "/srv/lumina/Library" };

  assert.deepEqual(await t.call("scan_folder", args), list);
  assert.equal(server.got[0]["If-None-Match"], undefined);
  await settle();
  assert.equal(lists.get("|/srv/lumina/Library")?.tag, '"1"');

  assert.deepEqual(await t.call("scan_folder", args), list);
  assert.equal(server.got[1]["If-None-Match"], '"1"');
  assert.equal(server.got[1]["X-Lumina-Differences"], "1");

  assert.deepEqual(await t.call("scan_folder", args), [
    { hash: "a", v: 1 },
    { hash: "b", v: 5 },
    { hash: "c", v: 1 },
  ]);
  await settle();
  assert.equal(lists.get("|/srv/lumina/Library")?.tag, '"2"');

  assert.deepEqual(await t.call("scan_folder", args), [{ hash: "q" }]);
  assert.equal(server.got[3]["If-None-Match"], '"2"');
  assert.equal(server.got[4]["If-None-Match"], undefined);
  await settle();
  assert.equal(lists.get("|/srv/lumina/Library")?.tag, '"3"');
});

test("an answer without a tag (a guest's) is not kept, and a 401 forgets what was kept", async () => {
  const { kept, lists } = memoryKeptLists();
  lists.set("|/other", { tag: '"9"', text: "[]" });
  let ended = 0;
  const server = standIn([
    () => new Response(JSON.stringify(list)),
    () => new Response(JSON.stringify({ error: "Signed out" }), { status: 401 }),
  ]);
  const t = createRemoteTransport({ fetch: server.fetch, keptLists: kept, onUnauthorized: () => ended++ });
  assert.deepEqual(await t.call("scan_folder", { folderPath: "/lib" }), list);
  await settle();
  assert.equal(lists.has("|/lib"), false);
  await assert.rejects(t.call("get_albums"), (e) => e === "Signed out");
  await settle();
  assert.equal(lists.size, 0);
  assert.equal(ended, 1);
});
