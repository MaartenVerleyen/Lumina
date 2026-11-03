import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VIDEO_NAME } from "../utils/media.ts";

// An engine event as handlers receive it (the same shape as Tauri's, so handlers read `event.payload`)
export interface EngineEvent<T> {
  payload: T;
}

// A file the window shows. It says what the file is, not only where it is: an engine on this PC serves
// every kind straight from its path; a server (Lumina 5) serves each kind by id, so the client never needs
// the server's paths.
export type MediaRef =
  // Grid thumbnail of a photo or video
  | { kind: "thumb"; hash: string; path: string }
  // The photo or video at full size as the window shows it (RAW/HEIC: their 1920 px preview; a Live
  // Photo's clip has its own hash)
  | { kind: "original"; hash: string; path: string }
  // A playable copy the engine made of a video the webview can't play
  | { kind: "preview"; hash: string; path: string }
  // A face crop or a person's cover (named after the face id)
  | { kind: "face"; path: string };

// Where the engine for a library runs. Only the local engine exists so far; a server connection
// implements the same three calls over HTTP and a WebSocket.
export interface Transport {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  subscribe<T>(event: string, handler: (event: EngineEvent<T>) => void): Promise<() => void>;
  mediaUrl(ref: MediaRef): string;
}

// Linux: WebKitGTK can't stream video from asset:// URLs (tauri#3725), so the app serves local videos from
// 127.0.0.1 (src-tauri/src/media_server.rs). Elsewhere the app answers null and videos stay on asset://.
export interface LocalMediaServer {
  base: string;
  token: string;
}
let mediaServer: LocalMediaServer | null = null;
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  invoke<LocalMediaServer | null>("local_media_server")
    .then((s) => (mediaServer = s))
    .catch(() => {});
}

export function localMediaUrl(ref: MediaRef, server: LocalMediaServer | null): string {
  const video = ref.kind === "preview" || (ref.kind === "original" && VIDEO_NAME.test(ref.path));
  if (server && video) return `${server.base}/video/${server.token}?path=${encodeURIComponent(ref.path)}`;
  return convertFileSrc(ref.path);
}

export const localTransport: Transport = {
  call: (command, args) => invoke(command, args),
  subscribe: (event, handler) => listen(event, handler),
  mediaUrl: (ref) => localMediaUrl(ref, mediaServer),
};
