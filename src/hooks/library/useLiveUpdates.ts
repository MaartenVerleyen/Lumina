import { useEffect } from "react";
import { call, isOwnChange, subscribe } from "../../api";
import type { PhotoItem } from "../../types/lumina";
import type { LibraryCore } from "./core";
import { mergeFreshPhoto } from "../../utils/freshPhoto";

// Changes other users make on the server (ratings, tags, people, ...) reach this window as photos-changed
// events: the photos named are fetched again, a few events at a time. So do thumbnails, faces and captions
// the server makes itself. Only a library on a server sends these.
export function useLiveUpdates(core: LibraryCore) {
  const { setPhotos } = core;
  useEffect(() => {
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = async () => {
      timer = null;
      const hashes = Array.from(pending);
      pending = new Set();
      try {
        const fresh = await call<PhotoItem[]>("get_photos", { hashes });
        const byHash = new Map(fresh.map((p) => [p.hash, p]));
        setPhotos((prev) => prev.map((p) => (byHash.has(p.hash) ? mergeFreshPhoto(p, byHash.get(p.hash)!) : p)));
      } catch {
        // The next change fetches them again
      }
    };
    const off = subscribe<{ hashes: string[]; origin?: string }>("photos-changed", (e) => {
      if (isOwnChange(e.payload)) return;
      for (const h of e.payload.hashes ?? []) pending.add(h);
      if (!timer) timer = setTimeout(flush, 250);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off.then((f) => f());
    };
  }, [setPhotos]);
}
