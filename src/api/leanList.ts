// The phone layout's photo lists (docs/plans/lean-photo-list.md): a server's library comes without the details the
// phone shows only for an opened photo, or not at all (faces, camera settings, the folder, ...: lumina-server's
// lean.rs). Both transports to a server ask for that form while the phone layout shows (remote.ts for the web
// client, desktopRemote.ts for the phone app).
//
// A photo of a lean list gets `faces` as one shared empty list, so code that reads a photo's faces finds none instead
// of failing; `needsDetails` tells it from a photo with no faces, and `withDetails` puts the fetched ones in.
import type { FaceInstance, PhotoItem } from "../types/lumina";

const NO_FACES: FaceInstance[] = Object.freeze([]) as unknown as FaceInstance[];

let lean = false;

export function setLeanLists(on: boolean) {
  lean = on;
}

export function leanListsOn(): boolean {
  return lean;
}

// scan_folder's arguments, with the lean form asked for while the phone layout shows
export function leanArgs(command: string, args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return lean && command === "scan_folder" ? { ...args, lean: true } : args;
}

// A list as it came: a lean one's photos get the shared empty faces (in place: adding one field costs little, a new
// object per photo a lot)
export function fromLeanList<T>(command: string, result: T): T {
  if (!lean || command !== "scan_folder" || !Array.isArray(result)) return result;
  for (const photo of result as Partial<PhotoItem>[]) {
    if (photo && photo.faces === undefined) photo.faces = NO_FACES;
  }
  return result;
}

// Whether a photo came from a lean list and its details (get_photo_details) haven't been put in yet
export function needsDetails(photo: Pick<PhotoItem, "faces">): boolean {
  return photo.faces === NO_FACES;
}

// What get_photo_details answers for one photo
export type PhotoDetails = Pick<
  PhotoItem,
  | "faces"
  | "camera_model"
  | "lens_model"
  | "focal_length"
  | "aperture"
  | "shutter_speed"
  | "iso"
  | "sharpness"
  | "dhash"
  | "duplicate_group"
  | "damaged"
  | "in_basket"
  | "staged_target"
  | "subfolder"
  | "live_video_path"
>;

// The photo with its details (a photo that has them already stays as it is)
export function withDetails<P extends PhotoItem>(photo: P, details: Partial<PhotoDetails> | undefined): P {
  if (!details || !needsDetails(photo)) return photo;
  return { ...photo, ...details, faces: details.faces ?? [] };
}
