import { useState } from "react";
import { callLocal } from "../api";
import { open as openDialog } from "../api/platform";
import { confirmDialog } from "../confirm";

// The folders opened on this PC (its libraries), with their photo counts and whether the folder is still there;
// Forget and Locate… for them. Used by the Library menu and the start screen.
export interface LocalLibrary {
  root: string;
  photos: number;
  missing: boolean;
}

export function useLocalLibraries(onError?: (message: string) => void) {
  const [libraries, setLibraries] = useState<LocalLibrary[] | null>(null);
  const at = (path: string) => libraries?.find((l) => l.root === path);

  const reload = () =>
    callLocal<LocalLibrary[]>("local_libraries")
      .then((list) => setLibraries([...list].sort((a, b) => a.root.localeCompare(b.root, undefined, { sensitivity: "base" }))))
      .catch(() => setLibraries(null));

  // True when the folder was forgotten
  async function forget(path: string): Promise<boolean> {
    const lib = at(path);
    const count = lib ? `${lib.photos.toLocaleString()} photo${lib.photos === 1 ? "" : "s"}` : "its photos";
    const moved = lib?.missing ? " Renamed or moved the folder? Use Locate… instead: everything is kept." : "";
    const ok = await confirmDialog(
      `Lumina forgets "${path}": the ratings, tags, names and album places of ${count} go, and it leaves All photos. The files stay in the folder; opening it again starts afresh.${moved}`,
      { title: "Forget this folder", okLabel: "Forget", kind: "danger" }
    );
    if (!ok) return false;
    try {
      await callLocal("forget_local_library", { root: path });
      return true;
    } catch (e) {
      onError?.(`Couldn't forget the folder: ${e}`);
      return false;
    } finally {
      void reload();
    }
  }

  // A library renamed or moved outside Lumina: point it to its new place, and everything known about its photos
  // goes along. The new folder, or null when nothing changed.
  async function locate(path: string): Promise<string | null> {
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
    const picked = await openDialog({ directory: true, multiple: false, title: `Where is "${name}" now?` });
    if (!picked || Array.isArray(picked)) return null;
    try {
      await callLocal<number>("locate_local_library", { root: path, newRoot: picked });
      return picked;
    } catch (e) {
      onError?.(`Couldn't move the library to ${picked}: ${e}`);
      return null;
    } finally {
      void reload();
    }
  }

  return { libraries, at, reload, forget, locate };
}
