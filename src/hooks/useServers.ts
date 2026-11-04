import { useEffect, useSyncExternalStore } from "react";
import {
  callLocal,
  callServer,
  inDesktopApp,
  rememberLibraryRoles,
  rememberServerUser,
  subscribeLocal,
  type RemoteUser,
  type Role,
  type ServerInfo,
} from "../api";

// The servers the desktop app is connected to (client mode) and their libraries, shared by every component
// that lists them: the welcome screen, the library menu and Settings → Servers

export interface ServerLibrary {
  root: string;
  name: string;
  photos: number;
  role?: Role;
}

export interface ServersState {
  servers: ServerInfo[];
  // Per server: its libraries, or why they couldn't be listed
  libraries: Record<string, ServerLibrary[] | { error: string }>;
}

let state: ServersState = { servers: [], libraries: {} };
const listeners = new Set<() => void>();
function set(next: Partial<ServersState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

let loading: Promise<void> | null = null;

export function refreshServers(): Promise<void> {
  if (!inDesktopApp) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      const servers = await callLocal<ServerInfo[]>("server_list");
      set({ servers });
      const libraries: ServersState["libraries"] = {};
      await Promise.all(
        servers.map(async (s) => {
          if (!s.signed_in) {
            rememberServerUser(s.id, null);
            return;
          }
          try {
            const [me, list] = await Promise.all([
              callLocal<RemoteUser>("server_me", { server: s.id }),
              callServer<ServerLibrary[]>(s.id, "list_libraries"),
            ]);
            rememberServerUser(s.id, me);
            rememberLibraryRoles(list, s.id);
            libraries[s.id] = list;
          } catch (e) {
            libraries[s.id] = { error: String(e) };
          }
        })
      );
      // Signing in or out while this ran: the list from server_list may be older than the libraries
      set({ servers: await callLocal<ServerInfo[]>("server_list"), libraries });
    } catch (e) {
      console.error("Couldn't list the servers", e);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export async function connectServer(url: string, name: string, password: string): Promise<ServerInfo> {
  const info = await callLocal<ServerInfo>("server_login", { url, name, password });
  await refreshServers();
  return info;
}

export async function signOutServer(server: string) {
  await callLocal("server_logout", { server });
  await refreshServers();
}

export async function removeServer(server: string) {
  await callLocal("server_remove", { server });
  await refreshServers();
}

let watching = false;
function watch() {
  if (watching || !inDesktopApp) return;
  watching = true;
  refreshServers();
  // The server ended a session (password changed, account removed), or an admin shared an album or changed
  // a role: list again
  subscribeLocal("remote-signed-out", () => refreshServers());
  subscribeLocal<{ event: string }>("remote-event", (e) => {
    if (e.payload.event === "shares-changed" || e.payload.event === "roles-changed") refreshServers();
  });
}

export function useServers(): ServersState {
  useEffect(watch, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state
  );
}
