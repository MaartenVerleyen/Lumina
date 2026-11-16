import { useEffect } from "react";
import { call, isOwnChange, subscribe } from "../../api";
import type { PhotoItem } from "../../types/lumina";
import type { LibraryCore } from "./core";
import { mergeFreshPhoto } from "../../utils/freshPhoto";

// Changes other users make on the server (ratings, tags, people, ...) reach this window as photos-changed
// events: the photos named are fetched again, a few events at a time. So do thumbnails, faces and captions
// the server makes itself. Only a library on a server sends these.
// Changes that follow a fetch within STEADY_WITHIN are fetched once per STEADY_EVERY
const STEADY_WITHIN = 3000;
const STEADY_EVERY = 1500;

export function useLiveUpdates(core: LibraryCore) {
  const { setPhotos } = core;
  useEffect(() => {
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastFlush = 0;
    const flush = async () => {
      timer = null;
      lastFlush = Date.now();
      const hashes = Array.from(pending);
      pending = new Set();
      try {
        const fresh = await call<PhotoItem[]>("get_photos", { hashes });
        const byHash = new Map(fresh.map((p) => [p.hash, p]));
        setPhotos((prev) => {
          // Photos of another library, or filtered out here: the list stays the one it was, and nothing draws again
          if (!prev.some((p) => byHash.has(p.hash))) return prev;
          return prev.map((p) => (byHash.has(p.hash) ? mergeFreshPhoto(p, byHash.get(p.hash)!) : p));
        });
      } catch {
        // Not fetched (the server out of reach for a moment): they go with the next change, or the next look
        // after the connection is back
        for (const h of hashes) pending.add(h);
      }
    };
    const off = subscribe<{ hashes: string[]; origin?: string }>("photos-changed", (e) => {
      if (isOwnChange(e.payload)) return;
      for (const h of e.payload.hashes ?? []) pending.add(h);
      // A single change shows at once. While they keep coming (the server making thumbnails, finding faces,
      // writing captions) they are collected for longer: every fetch redraws the whole grid.
      if (!timer) timer = setTimeout(flush, Date.now() - lastFlush < STEADY_WITHIN ? STEADY_EVERY : 250);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off.then((f) => f());
    };
  }, [setPhotos]);
}
