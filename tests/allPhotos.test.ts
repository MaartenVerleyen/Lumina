import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyDownEdits,
  includedSources,
  mergeHits,
  mergePeople,
  mergeSources,
  nameOn,
  shownPersonName,
  withPeopleNamed,
  sourceKey,
  splitByHome,
  withLocalIds,
  whereabouts,
  type Source,
} from "../src/api/allPhotos.ts";
import type { PersonItem, PhotoItem } from "../src/types/lumina.ts";

const photo = (hash: string, extra: Partial<PhotoItem> = {}): PhotoItem =>
  ({
    hash,
    name: `${hash}.jpg`,
    subfolder: "Root",
    path: `/${hash}.jpg`,
    thumb_path: "",
    size_kb: 1,
    width: 1,
    height: 1,
    thumb_ready: true,
    rating: 0,
    flag: null,
    color_label: null,
    rotation: 0,
    in_basket: false,
    tags: [],
    people: [],
    faces: [],
    ai_caption: "",
    ocr_text: "",
    captured_at: "",
    camera_model: "",
    location: "",
    dhash: "",
    sharpness: 0,
    damaged: false,
    ...extra,
  }) as PhotoItem;

// The household of the brief: D:\Photos on this PC, cachy's library (editor), and a library shared read-only
const pc: Source = { server: null, root: "D:\\Photos", label: "D:\\Photos", editable: true, uploadable: false };
const cachy: Source = { server: "cachy", root: "/photos", label: "cachy: photos", editable: true, uploadable: true };
const shared: Source = { server: "dads", root: "/lib", label: "dads: lib", editable: false, uploadable: false };
const sources = new Map([pc, cachy, shared].map((s) => [sourceKey(s), s]));

test("a photo in two places shows once, with the server's values, and sits in both folders", () => {
  const merged = mergeSources([
    { source: pc, photos: [photo("both", { rating: 2, subfolder: "2024", tags: ["sea"] }), photo("mine")] },
    { source: cachy, photos: [photo("both", { rating: 4, subfolder: "uploads / maarten" }), photo("theirs")] },
  ]);
  assert.equal(merged.photos.length, 3);
  const both = merged.photos.find((p) => p.hash === "both")!;
  assert.equal(both.rating, 4);
  assert.equal(both.home, sourceKey(cachy));
  assert.equal(both.subfolder, "cachy: photos / uploads / maarten");
  assert.deepEqual(both.also_in, ["D:\\Photos / 2024"]);
  assert.deepEqual(both.copies, [sourceKey(pc), sourceKey(cachy)]);
  // The copy on this PC is remembered as it is, to bring it in step
  assert.deepEqual(merged.localValues.get("both"), { rating: 2, flag: null, color_label: null, tags: ["sea"] });
  assert.equal(merged.photos.find((p) => p.hash === "mine")!.subfolder, "D:\\Photos");
});

test("a photo only shared with you has no home; your own copy of it is the home", () => {
  const merged = mergeSources([
    { source: shared, photos: [photo("look"), photo("kept")] },
    { source: pc, photos: [photo("kept", { rating: 3 })] },
  ]);
  assert.equal(merged.photos.find((p) => p.hash === "look")!.home, null);
  assert.equal(merged.copies.get("look")!.shown, sourceKey(shared));
  const kept = merged.photos.find((p) => p.hash === "kept")!;
  assert.equal(kept.home, sourceKey(pc));
  assert.equal(kept.rating, 3);
});

test("a second copy of a file on this PC joins the server's photo it was backed up as", () => {
  // "dup" is a path-salted id: the same content as "both" sits in another folder here
  const merged = mergeSources(
    [
      { source: pc, photos: [photo("dup", { rating: 1, subfolder: "Copy" })] },
      { source: cachy, photos: [photo("both", { rating: 4 })] },
    ],
    new Map([["dup", "both"]])
  );
  assert.equal(merged.photos.length, 1);
  assert.equal(merged.photos[0].hash, "both");
  assert.deepEqual(merged.photos[0].copies, [sourceKey(pc), sourceKey(cachy)]);
  assert.deepEqual(merged.localIds.get("both"), ["dup"]);
  assert.equal(merged.localValues.get("both")!.rating, 1);
  // This computer's engine is asked about its own id
  assert.deepEqual(withLocalIds({ hashes: ["both", "other"], rating: 4 }, merged.localIds), { hashes: ["dup", "other"], rating: 4 });
});

test("a file in two folders on this PC and on the server: an edit reaches both copies here", () => {
  const scans: Source = { server: null, root: "E:\\Scans", label: "E:\\Scans", editable: true, uploadable: false };
  const merged = mergeSources(
    [
      { source: pc, photos: [photo("both")] },
      { source: scans, photos: [photo("dup")] },
      { source: cachy, photos: [photo("both")] },
    ],
    new Map([["dup", "both"]])
  );
  assert.equal(merged.photos.length, 1);
  assert.deepEqual(merged.localIds.get("both"), ["both", "dup"]);
  assert.deepEqual(withLocalIds({ hashes: ["both"], rating: 3 }, merged.localIds).hashes, ["both", "dup"]);
});

test("burst groups of two libraries don't run into each other", () => {
  const merged = mergeSources([
    { source: pc, photos: [photo("a", { duplicate_group: 1 })] },
    { source: cachy, photos: [photo("b", { duplicate_group: 1 })] },
  ]);
  const groups = merged.photos.map((p) => p.duplicate_group);
  assert.notEqual(groups[0], groups[1]);
});

test("an edit goes to each photo's home, its copy here follows, and shared photos are left alone", () => {
  const merged = mergeSources([
    { source: pc, photos: [photo("both"), photo("mine")] },
    { source: cachy, photos: [photo("both"), photo("theirs")] },
    { source: shared, photos: [photo("look")] },
  ]);
  const split = splitByHome(["both", "mine", "theirs", "look"], merged.copies, sources);
  assert.deepEqual(split.byEngine.get("cachy"), ["both", "theirs"]);
  assert.deepEqual(split.byEngine.get(""), ["mine"]);
  assert.equal(split.byEngine.has("dads"), false);
  assert.deepEqual(split.readOnly, ["look"]);
  assert.deepEqual(split.alsoLocal, ["both"]);
});

test("copies here take the server's rating, flag, label and tags, in a few grouped calls", () => {
  const local = new Map([
    ["a", { rating: 2, flag: null, color_label: null, tags: ["sea", "old"] }],
    ["b", { rating: 2, flag: null, color_label: null, tags: [] }],
    ["c", { rating: 5, flag: "pick" as const, color_label: "red" as const, tags: [] }],
  ]);
  const edits = copyDownEdits(
    [
      photo("a", { rating: 4, tags: ["sea", "new"] }),
      photo("b", { rating: 4, flag: "pick" }),
      photo("c", { rating: 5, flag: "pick", color_label: "red" }),
    ],
    local
  );
  assert.deepEqual(edits, [
    { command: "set_photos_rating", args: { hashes: ["a", "b"], rating: 4 } },
    { command: "set_photo_flag", args: { hashes: ["b"], flag: "pick" } },
    { command: "add_tag_batch", args: { hashes: ["a"], tag: "new" } },
    { command: "remove_tag_batch", args: { hashes: ["a"], tag: "old" } },
  ]);
  assert.deepEqual(copyDownEdits([photo("x", { rating: 3 })], local), []);
});

test("the same name in two libraries is one person, with the photos of both", () => {
  const person = (name: string, photo_count: number, extra: Partial<PersonItem> = {}): PersonItem => ({
    id: 1,
    name,
    photo_count,
    cover_thumb: "",
    hidden: false,
    starred: false,
    ...extra,
  });
  const merged = mergePeople([
    [person("Emma", 10, { cover_thumb: "faces/e.jpg" }), person("Me", 4)],
    [person("emma", 5, { starred: true }), person("Maarten", 2)],
  ]);
  assert.deepEqual(
    merged.map((p) => [p.name, p.photo_count, p.cover_thumb, p.starred]),
    [
      ["Emma", 15, "faces/e.jpg", true],
      ["Me", 4, "", false],
      ["Maarten", 2, "", false],
    ]
  );
});

test("smart search hits from two engines count once, with the best score", () => {
  assert.deepEqual(
    mergeHits([
      [{ hash: "a", score: 0.3 }, { hash: "b", score: 0.2 }],
      [{ hash: "a", score: 0.5 }],
    ]),
    [
      { hash: "a", score: 0.5 },
      { hash: "b", score: 0.2 },
    ]
  );
});

test("marks: not backed up only where there is a server to back up to", () => {
  const at = (...keys: Source[]) => ({ copies: keys.map(sourceKey) });
  assert.equal(whereabouts(at(pc), sources, true), "not-backed-up");
  assert.equal(whereabouts(at(pc), sources, false), "this-pc");
  assert.equal(whereabouts(at(pc, cachy), sources, true), "both");
  assert.equal(whereabouts(at(cachy), sources, true), "server-only");
  assert.equal(whereabouts(at(shared), sources, false), "server-only");
});

test("a library switched off in Settings is left out", () => {
  assert.deepEqual(includedSources([pc, cachy, shared], [sourceKey(shared)]), [pc, cachy]);
});

test("a name of your own and a person kept apart, as this account sees a server's people", () => {
  const names = new Map([
    ["me", { person: "Me", shown_as: "Maarten", apart: false }],
    ["emma", { person: "Emma", shown_as: null, apart: true }],
  ]);
  assert.equal(shownPersonName("Me", names, "cachy"), "Maarten");
  assert.equal(shownPersonName("Emma", names, "cachy"), "Emma (cachy)");
  assert.equal(shownPersonName("Bob", names, "cachy"), "Bob");
  const shown = withPeopleNamed(
    photo("a", { people: ["Me"], faces: [{ face_id: "a_1_1", person_name: "Me" }, { face_id: "a_5_5", person_name: null }] as PhotoItem["faces"] }),
    (n) => shownPersonName(n, names, "cachy")
  );
  assert.deepEqual(shown.people, ["Maarten"]);
  assert.deepEqual(shown.faces.map((f) => f.person_name), ["Maarten", null]);
  // A command about "Maarten" reaches cachy as "Me"; this PC knows them as Maarten
  const parts = new Map([
    [
      "maarten",
      [
        { engine: "cachy", label: "cachy", name: "Me", editable: false, shownAs: "Maarten", apart: false },
        { engine: "", label: "This PC", name: "Maarten", editable: true, shownAs: null, apart: false },
      ],
    ],
  ]);
  assert.equal(nameOn("cachy", "Maarten", parts), "Me");
  assert.equal(nameOn("", "Maarten", parts), "Maarten");
  assert.equal(nameOn("cachy", "Someone new", parts), "Someone new");
});
