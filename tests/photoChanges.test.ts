import { test } from "node:test";
import assert from "node:assert/strict";
import { changesBetween, replaced, sameList, stillHolds, type Kept } from "../src/utils/photoChanges.ts";
import { sameLayoutPhotos } from "../src/utils/gridLayout.ts";

interface P {
  hash: string;
  rating: number;
  captured_at: string;
}
const photo = (hash: string, rating = 0, captured_at = "2024-06-01 10:00:00"): P => ({ hash, rating, captured_at });

test("the photos that changed between two lists of the same photos", () => {
  const before = [photo("a"), photo("b"), photo("c")];
  assert.deepEqual(changesBetween(before, [...before]), []);
  const rated = { ...before[1], rating: 4 };
  const after = [before[0], rated, before[2]];
  assert.deepEqual(changesBetween(before, after), [[before[1], rated]]);
  // Asked again about the same two lists: the same answer
  assert.equal(changesBetween(before, after), changesBetween(before, after));
});

test("a photo that came, went or moved is no such change", () => {
  const [a, b, c] = [photo("a"), photo("b"), photo("c")];
  assert.equal(changesBetween([a, b, c], [a, b]), null);
  assert.equal(changesBetween([a, b], [a, b, c]), null);
  assert.equal(changesBetween([a, b, c], [a, c, b]), null);
  assert.equal(changesBetween([a, b, c], [a, photo("x"), c]), null);
});

test("too many changes are not followed one by one", () => {
  const before = Array.from({ length: 300 }, (_, i) => photo(String(i)));
  assert.equal(changesBetween(before, before.map((p) => ({ ...p, rating: 1 }))), null);
  assert.equal(changesBetween(before, before.map((p, i) => (i < 200 ? { ...p, rating: 1 } : p)))?.length, 200);
});

test("a list takes the new selves of the photos it holds, in their places", () => {
  const [a, b, c, d] = [photo("a"), photo("b"), photo("c"), photo("d")];
  const [b2, d2] = [{ ...b, rating: 5 }, { ...d, rating: 1 }];
  const sorted = [c, a, b];
  const out = replaced(sorted, [
    [b, b2],
    [d, d2],
  ]);
  assert.deepEqual(out, [c, a, b2]);
  assert.notEqual(out, sorted);
  assert.deepEqual(sorted, [c, a, b], "the list before is left as it was");
  // None of them in the list: the list itself
  assert.equal(replaced(sorted, [[d, d2]]), sorted);
  // Many at once go the other way round, with the same result
  const many = Array.from({ length: 40 }, (_, i) => photo(`m${i}`));
  const changes = many.map((p) => [p, { ...p, rating: 3 }] as const);
  assert.deepEqual(replaced([...many].reverse(), changes), changes.map(([, after]) => after).reverse());
});

test("a kept value holds while nothing it reads changed", () => {
  const before = [photo("a"), photo("b")];
  const kept: Kept<P, string> = { photos: before, deps: ["DATE", 3], value: "worked out" };
  const sameDate = (x: P, y: P) => x.captured_at === y.captured_at;
  const rated = [before[0], { ...before[1], rating: 5 }];
  assert.equal(stillHolds(kept, rated, ["DATE", 3], sameDate), kept);
  // Something it reads changed, in a photo or beside the photos
  const dated = [before[0], { ...before[1], captured_at: "2020-01-01 00:00:00" }];
  assert.equal(stillHolds(kept, dated, ["DATE", 3], sameDate), undefined);
  assert.equal(stillHolds(kept, rated, ["NAME", 3], sameDate), undefined);
  assert.equal(stillHolds(kept, [...before, photo("c")], ["DATE", 3], sameDate), undefined);
  assert.equal(stillHolds(null, rated, ["DATE", 3], sameDate), undefined);
});

// What useLibraryView does with these: a sorted, filtered list followed through edits is the list worked out anew
test("a sorted list followed through edits is the list sorted anew", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let photos = Array.from({ length: 400 }, (_, i) => photo(`h${i}`, Math.floor(rnd() * 6), `20${10 + Math.floor(rnd() * 15)}-0${1 + Math.floor(rnd() * 9)}-11 10:00:00`));
  const passes = (p: P) => p.rating >= 2;
  const order = (x: P, y: P) => (x.captured_at < y.captured_at ? 1 : x.captured_at > y.captured_at ? -1 : x.hash < y.hash ? -1 : 1);
  const anew = (list: P[]) => list.filter(passes).sort(order);
  let kept: Kept<P, P[]> = { photos, deps: [], value: anew(photos) };
  let followed = 0;
  for (let step = 0; step < 300; step++) {
    const at = Math.floor(rnd() * photos.length);
    // Mostly a field the list doesn't read; sometimes its filter (rating) or its order (date)
    const kind = rnd();
    const edit = (p: P): P & { tag?: number } =>
      kind < 0.6 ? { ...p, tag: step } : kind < 0.85 ? { ...p, rating: Math.floor(rnd() * 6) } : { ...p, captured_at: `2019-0${1 + Math.floor(rnd() * 9)}-11 10:00:00` };
    photos = photos.map((p, i) => (i === at ? edit(p) : p));
    const holds = stillHolds(kept, photos, [], (before, after) => {
      const shown = passes(before);
      return shown === passes(after) && (!shown || order(before, after) === 0 || before.captured_at === after.captured_at);
    });
    let value: P[];
    if (holds) {
      value = replaced(holds.value, changesBetween(holds.photos, photos) ?? []);
      followed++;
    } else {
      value = anew(photos);
    }
    kept = { photos, deps: [], value };
    assert.deepEqual(value, anew(photos), `step ${step}`);
    assert.ok(value.every((p) => photos.includes(p)), "the list holds the photos' new selves");
  }
  assert.ok(followed > 100 && followed < 300, `${followed} of 300 edits followed`);
});

test("lists and layouts that are the same", () => {
  assert.ok(sameList(["a", "b"], ["a", "b"]));
  assert.ok(!sameList(["a", "b"], ["b", "a"]));
  assert.ok(!sameList(["a"], undefined));
  assert.ok(sameList(undefined, undefined));
  const shape = (width: number, height: number, rotation = 0, captured_at = "2024-06-01 10:00:00") => ({ width, height, rotation, captured_at, rating: 0 });
  const a = [shape(4000, 3000), shape(3000, 4000)];
  assert.ok(sameLayoutPhotos(a, [a[0], { ...a[1], rating: 5 }]));
  assert.ok(!sameLayoutPhotos(a, [a[0], { ...a[1], rotation: 90 }]));
  assert.ok(!sameLayoutPhotos(a, [a[0], { ...a[1], captured_at: "2024-07-01 10:00:00" }]));
  assert.ok(!sameLayoutPhotos(a, [a[0]]));
});
