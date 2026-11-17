// What changed between two lists of the same photos. Every edit makes a new list with a few photos replaced
// (a rating, a tag), and the window works a lot out from the list: the sort, the layout, the timeline, the
// folder tree. With the changed photos known, whatever they can't have changed is kept as it was.
import { useMemo, useRef } from "react";
import { timed } from "../api/timings.ts";

// A photo before and after
export type Change<T> = readonly [before: T, after: T];

// More changed photos than this aren't followed one by one
const MOST = 200;

let last: { prev: unknown; next: unknown; changes: unknown } | null = null;

// The photos that differ between two lists holding the same photos in the same order. null when the lists
// differ in more than that (a photo came, went or moved) or in more photos than are worth following.
export function changesBetween<T extends { hash: string }>(prev: readonly T[], next: readonly T[]): Change<T>[] | null {
  // Several parts of the window ask about the same two lists
  if (last && last.prev === prev && last.next === next) return last.changes as Change<T>[] | null;
  const changes = differences(prev, next);
  last = { prev, next, changes };
  return changes;
}

function differences<T extends { hash: string }>(prev: readonly T[], next: readonly T[]): Change<T>[] | null {
  if (prev.length !== next.length) return null;
  const changes: Change<T>[] = [];
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] === next[i]) continue;
    if (prev[i].hash !== next[i].hash || changes.length === MOST) return null;
    changes.push([prev[i], next[i]]);
  }
  return changes;
}

// The list with each changed photo it holds replaced by its new self, in the same place. The same list when
// it holds none of them.
export function replaced<T>(list: T[], changes: readonly Change<T>[]): T[] {
  let out = list;
  const put = (i: number, after: T) => {
    if (out === list) out = list.slice();
    out[i] = after;
  };
  if (changes.length <= 8) {
    for (const [before, after] of changes) {
      const i = list.indexOf(before);
      if (i >= 0) put(i, after);
    }
    return out;
  }
  const swaps = new Map(changes);
  for (let i = 0; i < list.length; i++) {
    const after = swaps.get(list[i]);
    if (after !== undefined) put(i, after);
  }
  return out;
}

export function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

// What a kept result was worked out from
export interface Kept<T, V> {
  photos: readonly T[];
  deps: readonly unknown[];
  value: V;
}

// The kept value, when it still holds for `photos`: nothing else it depends on changed (`deps`), and none of
// the photos that changed since did so in a way that matters to it (`unaffected`). Else undefined.
export function stillHolds<T extends { hash: string }, V>(
  kept: Kept<T, V> | null,
  photos: readonly T[],
  deps: readonly unknown[],
  unaffected: (before: T, after: T) => boolean
): Kept<T, V> | undefined {
  if (!kept || !sameDeps(kept.deps, deps)) return undefined;
  const changes = changesBetween(kept.photos, photos);
  return changes && changes.every(([before, after]) => unaffected(before, after)) ? kept : undefined;
}

// useMemo over the photo list that keeps its value through changes that can't affect it: `unaffected` says so
// for one changed photo. `deps` is everything else the value is worked out from.
export function useKeptWhile<T extends { hash: string }, V>(
  photos: readonly T[],
  compute: () => V,
  unaffected: (before: T, after: T) => boolean,
  deps: readonly unknown[],
  label = "kept step"
): V {
  const kept = useRef<Kept<T, V> | null>(null);
  return useMemo(() => {
    const holds = stillHolds(kept.current, photos, deps, unaffected);
    const value = holds ? holds.value : timed(`view: ${label}`, compute);
    kept.current = { photos, deps, value };
    return value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos, ...deps]);
}
