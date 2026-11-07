import type { FaceInstance, PhotoItem } from "../../types/lumina";

// Photos with the faces a naming command answered (per photo, as the server has them now). A photo's people are
// the names on its faces plus those given to the photo without a face; the old name of a renamed face goes.
export function withFaces(photos: PhotoItem[], changed: Record<string, FaceInstance[]>): PhotoItem[] {
  return photos.map((p) => {
    const faces = changed[p.hash];
    if (!faces) return p;
    const before = new Set((p.faces ?? []).map((f) => f.person_name?.toLowerCase()).filter(Boolean));
    const named = faces.map((f) => f.person_name?.trim()).filter((n): n is string => !!n);
    const kept = p.people.filter((n) => !before.has(n.toLowerCase()));
    return { ...p, faces, people: [...new Set([...kept, ...named])].sort() };
  });
}
