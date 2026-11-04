import { useEffect, useRef, useSyncExternalStore } from "react";
import { callLocal, openLibraryServer } from "../api";
import { onTransferFinished } from "./useTransfers";
import type { PhotoItem } from "../types/lumina";

// "On this device": which photos of the open server library have their original on this computer (downloaded,
// uploaded from here, or the same file in a library on this PC; see src-tauri/src/client_db.rs). Empty for a
// library on this computer, where every photo is.

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
export function useOnDeviceTracking(photos: PhotoItem[]) {
  const server = openLibraryServer();
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => {
    if (!server) {
      if (forServer !== null) set(new Set(), null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      callLocal<string[]>("on_device", { server, hashes: photosRef.current.map((p) => p.hash) })
        .then((list) => {
          if (!cancelled) set(new Set(list), server);
        })
        .catch(() => {});
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
