// Every engine call, event and file the window shows goes through here, never to Tauri directly. In the
// desktop app that is the engine in the app; in a browser (the web client) it is the server the page came
// from. In the desktop app a library can be on a server too (client mode, desktopRemote.ts): calls, events
// and media then follow the open library, except the commands that are about this computer.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { localTransport, type EngineEvent, type MediaRef, type Transport } from "./transport.ts";
import {
  createDesktopRemoteTransport,
  createRemoteEvents,
  isLocalCommand,
  libraryRefFromString,
  libraryRefToString,
  type LibraryRef,
  type RemoteEventMessage,
  type ServerInfo,
} from "./desktopRemote.ts";
import { createRemoteAuth, createRemoteTransport, hasRole, RECONNECTED, uploadBackup, type RemoteUser, type Role } from "./remote.ts";

export type { EngineEvent, MediaRef, Transport, RemoteUser, Role, LibraryRef, ServerInfo };
export { libraryRefFromString, libraryRefToString };
export { hasRole, RECONNECTED, uploadBackup };

// Opens the admin page (from the account menu; App shows it)
export const OPEN_ADMIN_EVENT = "lumina-open-admin";

// Inside the Tauri desktop app (rather than a browser)
export const inDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Sent when the server says the session has ended; the login screen listens for it
export const LOGGED_OUT_EVENT = "lumina-logged-out";

const serverTransport = inDesktopApp
  ? null
  : createRemoteTransport({ onUnauthorized: () => window.dispatchEvent(new Event(LOGGED_OUT_EVENT)) });

// The library open in the window: on this computer (server null) or on a server the desktop app is
// connected to. Calls, events and media follow it.
let openLibrary: string | null = null;
let openServer: string | null = null;

// The desktop app's connections to servers (client mode): the app's Rust side does the requests
const remoteEvents = createRemoteEvents(() => openServer);
const desktopClientId = Math.random().toString(36).slice(2, 12);
const desktopRemotes = new Map<string, Transport>();
if (inDesktopApp) {
  localTransport
    .subscribe<RemoteEventMessage>("remote-event", (e) => remoteEvents.deliver(e.payload))
    .catch(() => {});
}

function desktopRemote(server: string): Transport {
  let t = desktopRemotes.get(server);
  if (!t) {
    t = createDesktopRemoteTransport(server, { invoke, convertFileSrc }, remoteEvents, desktopClientId);
    desktopRemotes.set(server, t);
  }
  return t;
}

// A change event this window caused itself (it already shows that change)
export function isOwnChange(payload: { origin?: string } | null | undefined): boolean {
  if (serverTransport) return payload?.origin === serverTransport.clientId;
  return !!openServer && payload?.origin === desktopClientId;
}

// Logging in and out of the server the web client came from (unused in the desktop app)
export const serverAuth = createRemoteAuth();

// A library on this computer (the desktop app's own): its user may do everything with it
export function openLibraryIsLocal(): boolean {
  return inDesktopApp && openServer === null;
}

// The server whose library is open in the desktop app (null: a library on this computer, or the web client)
export function openLibraryServer(): string | null {
  return openServer;
}

// The user's role on each server library (list_libraries answers it), by server and root. Rights follow the
// open library: one person can be an editor of one library and a guest of another.
const libraryRoles = new Map<string, Role>();
const roleKey = (server: string | null, root: string) => `${server ?? ""}|${root}`;
// Who the desktop app is signed in as, per server
const serverUsers = new Map<string, RemoteUser>();
let accessVersion = 0;
const accessListeners = new Set<() => void>();
const accessChanged = () => {
  accessVersion++;
  for (const l of accessListeners) l();
};

export function rememberLibraryRoles(libraries: { root: string; role?: Role }[], server: string | null = openServer) {
  for (const l of libraries) if (l.role) libraryRoles.set(roleKey(server, l.root), l.role);
  accessChanged();
}

export function rememberServerUser(server: string, user: RemoteUser | null) {
  if (user) serverUsers.set(server, user);
  else serverUsers.delete(server);
  accessChanged();
}

// The account the desktop app uses on the open library's server
export function openServerUser(): RemoteUser | undefined {
  return openServer ? serverUsers.get(openServer) : undefined;
}

export function setOpenLibrary(root: string | null, server: string | null = null) {
  if (!root) server = null;
  if (root === openLibrary && server === openServer) return;
  openLibrary = root;
  openServer = server;
  accessChanged();
}

// The role on the open server library (undefined: not known, or no server library open)
export function openLibraryRole(): Role | undefined {
  return openLibrary ? libraryRoles.get(roleKey(openServer, openLibrary)) : undefined;
}

export function subscribeAccess(listener: () => void): () => void {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

export function accessSnapshot(): number {
  return accessVersion;
}

export function transportFor(): Transport {
  if (serverTransport) return serverTransport;
  return openServer ? desktopRemote(openServer) : localTransport;
}

// The desktop app's own engine, whatever library is open (servers, uploads, downloads, local copies)
export function callLocal<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return localTransport.call<T>(command, args);
}

export function subscribeLocal<T>(event: string, handler: (event: EngineEvent<T>) => void): Promise<() => void> {
  return localTransport.subscribe<T>(event, handler);
}

// A command for a library on a given server, whatever library is open
export function callServer<T>(server: string, command: string, args?: Record<string, unknown>): Promise<T> {
  return desktopRemote(server).call<T>(command, args);
}

export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (inDesktopApp && isLocalCommand(command)) return localTransport.call<T>(command, args);
  return transportFor().call<T>(command, args);
}

// In the desktop app a handler hears its own engine and the open server library's server: hooks subscribe
// once, and the library they work on can change between the two
export function subscribe<T>(event: string, handler: (event: EngineEvent<T>) => void): Promise<() => void> {
  if (serverTransport) return serverTransport.subscribe<T>(event, handler);
  const offs = [localTransport.subscribe<T>(event, handler), remoteEvents.subscribe<T>(event, handler)];
  return Promise.all(offs).then((fs) => () => fs.forEach((f) => f()));
}

export function mediaUrl(ref: MediaRef): string {
  return transportFor().mediaUrl(ref);
}
