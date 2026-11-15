import { useEffect, useRef, useSyncExternalStore } from "react";
import { allPhotosSources, callLocal, openLibraryIsAll, openLibraryServer } from "../api";
import { onTransferFinished } from "./useTransfers";
import type { PhotoItem } from "../types/lumina";

// "On this device": which photos of the open server library have their original on this computer (downloaded,
// uploaded from here, or the same file in a library on this PC; see src-tauri/src/client_db.rs). Empty for a
// library on this computer, where every photo is. In All photos: the photos only a server has whose original
// was downloaded here all the same.

let onDevice: ReadonlySet<string> = new Set();
let forServer: string | null = null;
const listeners = new Set<() => void>();
function set(next: ReadonlySet<string>, server: string | null) {
  onDevice = next;
  forServer = server;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useIsOnDevice(hash: string): boolean {
  return useSyncExternalStore(subscribe, () => forServer !== null && onDevice.has(hash));
}

export function useOnDeviceSet(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => onDevice);
}

// Follows the open library's photos: asks the app again when photos come or go (not on every rating) or a
// transfer finishes a file
const ALL_PHOTOS_MARK = "*all*";

// All photos: the photos with no copy in a library on this PC, by the servers that have them
function serverOnlyByServer(photos: PhotoItem[]): Map<string, string[]> {
  const sources = allPhotosSources();
  const byServer = new Map<string, string[]>();
  for (const p of photos) {
    const found = (p.copies ?? []).map((k) => sources.get(k));
    if (found.length === 0 || found.some((s) => !s || s.server === null)) continue;
    const server = found[0]!.server!;
    byServer.set(server, [...(byServer.get(server) ?? []), p.hash]);
  }
  return byServer;
}

export function useOnDeviceTracking(photos: PhotoItem[]) {
  const server = openLibraryIsAll() ? ALL_PHOTOS_MARK : openLibraryServer();
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => {
    if (!server) {
      if (forServer !== null) set(new Set(), null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      const asks =
        server === ALL_PHOTOS_MARK
          ? [...serverOnlyByServer(photosRef.current)]
          : [[server, photosRef.current.map((p) => p.hash)] as [string, string[]]];
      void Promise.all(
        asks.map(([s, hashes]) => callLocal<string[]>("on_device", { server: s, hashes }).catch(() => [] as string[]))
      ).then((lists) => {
        if (!cancelled) set(new Set(lists.flat()), server);
      });
    };
    load();
    // Several files finishing in a row ask once
    const off = onTransferFinished(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 1500);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [server, photos.length, photos[0]?.hash]);
}
