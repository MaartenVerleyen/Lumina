// The web client's copy of each library's photo list, kept in the browser (IndexedDB) with the tag the server
// gave it, like the desktop's offline.rs. The tag goes along with the next request for that list: a server whose
// list is still that one answers "304 Not Modified" in a few bytes, and after a change it sends only what differs
// (lumina-server's listing.rs), which is worked into the copy here.
// Every step may fail (a private window, storage full, no IndexedDB under Node): then the list is asked for whole.

export interface KeptList {
  tag: string;
  text: string;
}

// The tag is kept apart from the list: it goes with every request, the list (tens of megabytes in a large
// library) is read only when the server says it is still the one, or sends what differs from it
export interface KeptLists {
  tag(key: string): Promise<string | null>;
  text(key: string): Promise<string | null>;
  put(key: string, list: KeptList): Promise<void>;
  clear(): Promise<void>;
}

const DB = "lumina-kept-lists";
const STORE = "lists";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function browserKeptLists(): KeptLists | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => {
      opened = null;
      throw e;
    });
    return opened;
  };
  const store = async (mode: IDBTransactionMode) => (await db()).transaction(STORE, mode).objectStore(STORE);
  const read = async (key: string) => {
    try {
      const found = await request((await store("readonly")).get(key));
      return typeof found === "string" ? found : null;
    } catch {
      return null;
    }
  };
  return {
    tag: (key) => read(`tag:${key}`),
    text: (key) => read(`list:${key}`),
    async put(key, list) {
      try {
        // One transaction: never a tag without its list
        const s = await store("readwrite");
        s.put(list.text, `list:${key}`);
        await request(s.put(list.tag, `tag:${key}`));
      } catch (e) {
        console.warn("Couldn't keep the photo list in this browser", e);
      }
    },
    async clear() {
      try {
        await request((await store("readwrite")).clear());
      } catch {
        // nothing kept, or no storage: nothing to clear
      }
    },
  };
}

interface Differences {
  changed: { after: string | null; photo: { hash: string } }[];
  removed: string[];
}

// The list with the server's differences worked in, the same way as lumina-core's list_changes::apply:
//   {"changed": [{"after": hash or null, "photo": {...}}, ...], "removed": [hash, ...]}
// A changed photo the list has takes the old one's place; one it doesn't have goes after the photo named by
// `after` (null: first; a new photo may come after another new one). Null when they don't fit this list: the
// caller then asks for the whole list.
export function applyDifferences<T extends { hash: string }>(list: T[], differences: Differences): T[] | null {
  if (!Array.isArray(list) || !differences || !Array.isArray(differences.changed) || !Array.isArray(differences.removed)) return null;
  const removed = new Set(differences.removed);
  const stays = new Set(list.map((p) => p.hash).filter((h) => !removed.has(h)));
  const replaced = new Map<string, T>();
  const comesAfter = new Map<string | null, T[]>();
  let fresh = 0;
  for (const change of differences.changed) {
    const photo = change?.photo as T | undefined;
    if (!photo || typeof photo.hash !== "string") return null;
    if (stays.has(photo.hash)) {
      replaced.set(photo.hash, photo);
    } else {
      const key = change.after ?? null;
      comesAfter.set(key, [...(comesAfter.get(key) ?? []), photo]);
      fresh++;
    }
  }
  const out: T[] = [];
  let placed = 0;
  const write = (first: T, isNew: boolean) => {
    const next: [T, boolean][] = [[first, isNew]];
    while (next.length > 0) {
      const [photo, newOne] = next.pop()!;
      out.push(photo);
      if (newOne) placed++;
      const following = comesAfter.get(photo.hash);
      if (following) {
        comesAfter.delete(photo.hash);
        for (let i = following.length - 1; i >= 0; i--) next.push([following[i], true]);
      }
    }
  };
  const first = comesAfter.get(null) ?? [];
  comesAfter.delete(null);
  for (const photo of first) write(photo, true);
  for (const photo of list) {
    if (stays.has(photo.hash)) write(replaced.get(photo.hash) ?? photo, false);
  }
  return placed === fresh ? out : null;
}
