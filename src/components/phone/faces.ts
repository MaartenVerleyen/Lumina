import type { Dispatch, SetStateAction } from "react";
import { call } from "../../api";
import { leanListsOn, needsDetails } from "../../api/leanList";
import type { FaceInstance, PhotoItem } from "../../types/lumina";

// Photos with the faces a naming command answered (per photo, as the server has them now). A photo's people are
// the names on its faces plus those given to the photo without a face; the old name of a renamed face goes.
// `known`: the faces a photo of a lean list had before (the viewer fetched them), which the list doesn't hold.
export function withFaces(photos: PhotoItem[], changed: Record<string, FaceInstance[]>, known?: Record<string, FaceInstance[]>): PhotoItem[] {
  return photos.map((p) => {
    const faces = changed[p.hash];
    if (!faces) return p;
    const old = needsDetails(p) ? (known?.[p.hash] ?? []) : (p.faces ?? []);
    const before = new Set(old.map((f) => f.person_name?.toLowerCase()).filter(Boolean));
    const named = faces.map((f) => f.person_name?.trim()).filter((n): n is string => !!n);
    const kept = p.people.filter((n) => !before.has(n.toLowerCase()));
    return { ...p, faces, people: [...new Set([...kept, ...named])].sort() };
  });
}

// A naming command's answer put into the photos. In the phone layout a photo's old faces aren't in its lean list:
// a name taken off may still be listed, so the photos whose faces weren't known are read again from the server,
// which knows their people (one small request).
export function applyFaces(
  lib: { setPhotos: Dispatch<SetStateAction<PhotoItem[]>> },
  changed: Record<string, FaceInstance[]>,
  known?: Record<string, FaceInstance[]>
) {
  lib.setPhotos((prev) => withFaces(prev, changed, known));
  const hashes = leanListsOn() ? Object.keys(changed).filter((h) => !known?.[h]) : [];
  if (hashes.length === 0) return;
  call<PhotoItem[]>("get_photos", { hashes })
    .then((fresh) => {
      const byHash = new Map(fresh.map((p) => [p.hash, p]));
      lib.setPhotos((prev) => prev.map((p) => byHash.get(p.hash) ?? p));
    })
    .catch(() => {});
}
