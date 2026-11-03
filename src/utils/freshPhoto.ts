import type { PhotoItem } from "../types/lumina";

// A photo fresh from the server, merged into the one the window has. Burst groups, RAW pairs and Live Photos
// are worked out over the whole library, so those stay as the window's own listing had them.
export function mergeFreshPhoto(old: PhotoItem, fresh: PhotoItem): PhotoItem {
  return {
    ...fresh,
    duplicate_group: old.duplicate_group,
    live_video_hash: old.live_video_hash,
    live_video_path: old.live_video_path,
    live_photo_hash: old.live_photo_hash,
    pair_raw_path: fresh.pair_raw_path ?? old.pair_raw_path,
    thumb_rev: old.thumb_rev,
  };
}
