// Every engine call, event and file the window shows goes through here, never to Tauri directly. In the
// desktop app that is the engine in the app; in a browser (the web client) it is the server the page came
// from. Later a desktop library can be on a server too (client mode), and `transportFor` picks the
// connection per library.
import { localTransport, type EngineEvent, type MediaRef, type Transport } from "./transport.ts";
import { createRemoteAuth, createRemoteTransport, hasRole, type RemoteUser, type Role } from "./remote.ts";

export type { EngineEvent, MediaRef, Transport, RemoteUser, Role };
export { hasRole };

// Inside the Tauri desktop app (rather than a browser)
export const inDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Sent when the server says the session has ended; the login screen listens for it
export const LOGGED_OUT_EVENT = "lumina-logged-out";

const serverTransport = inDesktopApp
  ? null
  : createRemoteTransport({ onUnauthorized: () => window.dispatchEvent(new Event(LOGGED_OUT_EVENT)) });

// A change event this window caused itself (it already shows that change)
export function isOwnChange(payload: { origin?: string } | null | undefined): boolean {
  return !!serverTransport && payload?.origin === serverTransport.clientId;
}

// Logging in and out of the server the web client came from (unused in the desktop app)
export const serverAuth = createRemoteAuth();

// Libraries that live on a server, by root; everything else is local
const remoteLibraries = new Map<string, Transport>();

// A library on this computer (the desktop app's own): its user may do everything with it
export function isLocalLibrary(root: string | null | undefined): boolean {
  return inDesktopApp && !(root && remoteLibraries.has(root));
}

// The user's role on each server library, by root (list_libraries answers it), and the library open now.
// Rights follow the open library: one person can be an editor of one library and a guest of another.
const libraryRoles = new Map<string, Role>();
let openLibrary: string | null = null;
let accessVersion = 0;
const accessListeners = new Set<() => void>();
const accessChanged = () => {
  accessVersion++;
  for (const l of accessListeners) l();
};

export function rememberLibraryRoles(libraries: { root: string; role?: Role }[]) {
  for (const l of libraries) if (l.role) libraryRoles.set(l.root, l.role);
  accessChanged();
}

export function setOpenLibrary(root: string | null) {
  if (root === openLibrary) return;
  openLibrary = root;
  accessChanged();
}

// The role on the open server library (undefined: not known, or no server library open)
export function openLibraryRole(): Role | undefined {
  return openLibrary ? libraryRoles.get(openLibrary) : undefined;
}

export function openLibraryIsLocal(): boolean {
  return isLocalLibrary(openLibrary);
}

export function subscribeAccess(listener: () => void): () => void {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

export function accessSnapshot(): number {
  return accessVersion;
}

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
