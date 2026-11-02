// Every engine call, event and file the window shows goes through here, never to Tauri directly. Today
// that is always the engine in this app; later a library can be on a server (client mode, or a folder
// shared with you), and `transportFor` picks the connection per library.
import { localTransport, type EngineEvent, type MediaRef, type Transport } from "./transport";

export type { EngineEvent, MediaRef, Transport };

// Libraries that live on a server, by root; everything else is local
const remoteLibraries = new Map<string, Transport>();

export function transportFor(libraryRoot?: string | null): Transport {
  return (libraryRoot && remoteLibraries.get(libraryRoot)) || localTransport;
}

export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return transportFor().call<T>(command, args);
}

export function subscribe<T>(event: string, handler: (event: EngineEvent<T>) => void): Promise<() => void> {
  return transportFor().subscribe<T>(event, handler);
}

export function mediaUrl(ref: MediaRef): string {
  return transportFor().mediaUrl(ref);
}
