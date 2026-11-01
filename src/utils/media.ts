import type { PhotoItem } from "../types/lumina";

// Videos in the library: how they are told apart from photos, shown and played

export const VIDEO_NAME = /\.(mp4|mov|m4v|3gp|avi|mts|m2ts|mpg|mpeg)$/i;

export function isVideo(p: Pick<PhotoItem, "media_type" | "name">): boolean {
  return p.media_type === "video" || (!p.media_type && VIDEO_NAME.test(p.name));
}

// "0:07", "4:32", "1:02:05"
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Containers and codecs WebView2 plays itself (HEVC through Windows' HEVC extension); the rest needs a
// converted copy
const PLAYABLE_CONTAINER = /\.(mp4|mov|m4v)$/i;
const PLAYABLE_CODECS = new Set(["avc1", "avc3", "hvc1", "hev1", "av01", "vp09"]);

export function isPlayableInWebView(p: Pick<PhotoItem, "name" | "video_codec">): boolean {
  return PLAYABLE_CONTAINER.test(p.name) && !!p.video_codec && PLAYABLE_CODECS.has(p.video_codec.toLowerCase());
}

// Codec fourcc as people know it
export function codecLabel(codec: string | null | undefined): string {
  switch ((codec ?? "").toLowerCase()) {
    case "hvc1":
    case "hev1":
      return "HEVC";
    case "avc1":
    case "avc3":
      return "H.264";
    case "av01":
      return "AV1";
    case "vp09":
      return "VP9";
    case "mp4v":
      return "MPEG-4";
    case "":
      return "";
    default:
      return codec!.toUpperCase();
  }
}

// Features that only make sense for still photos (they read pixels a video doesn't offer as a file)
export function photosOnly<T extends Pick<PhotoItem, "media_type" | "name">>(items: T[]): T[] {
  return items.filter((p) => !isVideo(p));
}
