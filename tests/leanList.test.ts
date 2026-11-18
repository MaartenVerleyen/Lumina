import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromLeanList, leanArgs, needsDetails, setLeanLists, withDetails } from "../src/api/leanList.ts";
import { withPeopleNamed } from "../src/api/allPhotos.ts";
import { createRemoteTransport } from "../src/api/remote.ts";
import type { PhotoItem } from "../src/types/lumina.ts";

// The same cases lumina-server's lean.rs is checked against
const cases: { what: string; full: PhotoItem; lean: Partial<PhotoItem> }[] = JSON.parse(
  readFileSync(new URL("./fixtures/lean-cases.json", import.meta.url), "utf8")
);

test("a lean list's photos have no faces until their details are put in", () => {
  setLeanLists(true);
  try {
    const list = fromLeanList("scan_folder", cases.map((c) => ({ ...c.lean })) as PhotoItem[]);
    for (const [i, photo] of list.entries()) {
      const { what, full } = cases[i];
      assert.deepEqual(photo.faces, [], what);
      assert.ok(needsDetails(photo), what);
      // Every field the lean list has stays as it came
      for (const [key, value] of Object.entries(cases[i].lean)) assert.deepEqual(photo[key as keyof PhotoItem], value, `${what}: ${key}`);
      const details = Object.fromEntries(Object.entries(full).filter(([k]) => !(k in cases[i].lean)));
      const whole = withDetails(photo, details);
      assert.deepEqual(whole, full, what);
      assert.ok(!needsDetails(whole));
      // A photo that has its details stays as it is
      assert.equal(withDetails(whole, { faces: [] }), whole);
    }
    // Only scan_folder answers are lean, and only while the phone layout shows
    assert.deepEqual(leanArgs("scan_folder", { folderPath: "/lib" }), { folderPath: "/lib", lean: true });
    assert.deepEqual(leanArgs("get_photos", { hashes: [] }), { hashes: [] });
  } finally {
    setLeanLists(false);
  }
  assert.deepEqual(leanArgs("scan_folder", { folderPath: "/lib" }), { folderPath: "/lib" });
  const full = { ...cases[0].full };
  assert.equal(fromLeanList("scan_folder", [full])[0].faces, cases[0].full.faces);
});

test("All photos keeps a photo whose names read the same, and its faces not fetched yet", () => {
  setLeanLists(true);
  try {
    const [photo] = fromLeanList("scan_folder", [{ ...cases[0].lean }] as PhotoItem[]);
    assert.equal(withPeopleNamed(photo, (n) => n), photo, "no copy when nothing is named otherwise");
    const named = withPeopleNamed(photo, (n) => (n === "Anna" ? "Mum" : n));
    assert.deepEqual(named.people, ["Mum"]);
    assert.ok(needsDetails(named), "still to be fetched");
  } finally {
    setLeanLists(false);
  }
  const whole = cases[0].full;
  assert.equal(withPeopleNamed(whole, (n) => n), whole);
  assert.equal(withPeopleNamed(whole, (n) => (n === "Anna" ? "Mum" : n)).faces[0].person_name, "Mum");
});

test("the web client asks a server for the lean list while the phone layout shows", async () => {
  const asked: unknown[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify([cases[0].lean]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const t = createRemoteTransport({ fetch: fetch as typeof globalThis.fetch, keptLists: null });
  setLeanLists(true);
  try {
    const [photo] = await t.call<PhotoItem[]>("scan_folder", { folderPath: "/lib" });
    assert.deepEqual(asked[0], { folderPath: "/lib", lean: true });
    assert.ok(needsDetails(photo));
  } finally {
    setLeanLists(false);
    t.close();
  }
  await createRemoteTransport({ fetch: fetch as typeof globalThis.fetch, keptLists: null }).call("scan_folder", { folderPath: "/lib" });
  assert.deepEqual(asked[1], { folderPath: "/lib" });
});
