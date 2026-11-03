// Every engine call, event and file the window shows goes through here, never to Tauri directly. In the
// desktop app that is the engine in the app; in a browser (the web client) it is the server the page came
// from. Later a desktop library can be on a server too (client mode), and `transportFor` picks the
// connection per library.
import { localTransport, type EngineEvent, type MediaRef, type Transport } from "./transport";
import { createRemoteAuth, createRemoteTransport, type RemoteUser } from "./remote";

export type { EngineEvent, MediaRef, Transport, RemoteUser };

// Inside the Tauri desktop app (rather than a browser)
export const inDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Sent when the server says the session has ended; the login screen listens for it
export const LOGGED_OUT_EVENT = "lumina-logged-out";

const serverTransport = inDesktopApp
  ? null
  : createRemoteTransport({ onUnauthorized: () => window.dispatchEvent(new Event(LOGGED_OUT_EVENT)) });

// Logging in and out of the server the web client came from (unused in the desktop app)
export const serverAuth = createRemoteAuth();

// Libraries that live on a server, by root; everything else is local
const remoteLibraries = new Map<string, Transport>();

export function transportFor(libraryRoot?: string | null): Transport {
  return (libraryRoot && remoteLibraries.get(libraryRoot)) || serverTransport || localTransport;
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
