import { allPhotosServerOf, callLocal, openLibraryIsAll, openLibraryServer } from "../../api";
import type { PhotoItem } from "../../types/lumina";
import { isVideo } from "../../utils/media";

// The phone app's ways for photos to leave Lumina (transfers.rs): Android's share sheet, the phone's gallery,
// another app. A photo of the phone goes as it is; a server's original is downloaded first.

// Where the photo is: on this phone, or the server to download it from
export function serverOf(p: PhotoItem): string | null {
  if (p.path.startsWith("phone:")) return null;
  return openLibraryIsAll() ? allPhotosServerOf(p.hash) : openLibraryServer();
}

function itemOf(p: PhotoItem) {
  const server = serverOf(p);
  if (!p.path.startsWith("phone:") && !server) throw new Error(`${p.name} isn't on this phone or a server`);
  return { hash: p.hash, path: p.path, server, video: isVideo(p) };
}

export async function sharePhotos(photos: PhotoItem[]): Promise<void> {
  await callLocal("share_photos", { items: photos.map(itemOf) });
}

// Server photos into the phone's gallery (Pictures/Lumina); answers how many
export async function saveToPhone(photos: PhotoItem[]): Promise<number> {
  return callLocal<number>("save_to_phone", { items: photos.filter((p) => !p.path.startsWith("phone:")).map(itemOf) });
}

export async function openWith(photo: PhotoItem): Promise<void> {
  await callLocal("open_with", { item: itemOf(photo) });
}
