// A library on a server, opened in the desktop app (client mode). The desktop's webview doesn't talk to the
// server itself: the app's Rust side holds the session token and does every request (src-tauri/src/remote.rs).
//   call       invoke("server_call", {server, command, args, client})
//   subscribe  the app relays each server's WebSocket events as `remote-event` {server, event, payload}
//   mediaUrl   the app's lumina-remote protocol: /{server}/{kind}/{id}, thumbnails cached on disk
// No Tauri imports here: index.ts passes them in, and the tests run this under Node.
import type { EngineEvent, MediaRef, Transport } from "./transport";
import { faceIdFromPath } from "./remote.ts";

// Commands the desktop always runs itself: they act on this computer (files, clipboard, a card reader, the
// app's own windows), and a server refuses them (lumina-server's NOT_ON_SERVER). The client's own commands
// are here too.
export const LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  "open_in_default_app",
  "reveal_in_file_manager",
  "create_library_subfolder",
  "get_app_data_dir",
  "copy_image_to_clipboard",
  "close_splashscreen",
  "restart_app",
  "list_import_sources",
  "preview_import",
  "start_import",
  "cancel_import",
  "export_photos",
  "cancel_export",
  "export_gallery",
  "backup_library",
  "export_library_csv",
  "start_ollama_service",
  "enable_ollama_flash_attention",
  "local_media_server",
  // The watcher of a library on this computer (a server watches its own)
  "watch_library",
]);

export function isLocalCommand(command: string): boolean {
  return LOCAL_COMMANDS.has(command) || command.startsWith("server_");
}

// "<server>/<kind>/<id>": what the lumina-remote protocol fetches
export function remoteMediaKey(server: string, ref: MediaRef): string {
  const id = ref.kind === "face" ? faceIdFromPath(ref.path) : ref.hash;
  return `${server}/${ref.kind}/${id}`;
}

export interface DesktopDeps {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  // Tauri's convertFileSrc(path, protocol)
  convertFileSrc(path: string, protocol: string): string;
}

export function createDesktopRemoteTransport(
  server: string,
  deps: DesktopDeps,
  events: RemoteEvents,
  clientId: string
): Transport {
  return {
    call: (command, args) => deps.invoke("server_call", { server, command, args: args ?? {}, client: clientId }),
    subscribe: (event, handler) => events.subscribe(event, handler),
    mediaUrl: (ref) => deps.convertFileSrc(remoteMediaKey(server, ref), "lumina-remote"),
  };
}

export interface RemoteEventMessage {
  server: string;
  event: string;
  payload: unknown;
}

// Every server's events arrive on one channel; a handler gets those of the server whose library is open
// (`current()` says which, at the moment the event arrives; All photos has several)
export interface RemoteEvents {
  subscribe<T>(event: string, handler: (event: EngineEvent<T>) => void): Promise<() => void>;
  deliver(message: RemoteEventMessage): void;
}

export function createRemoteEvents(current: () => string | null | readonly string[]): RemoteEvents {
  const handlers = new Map<string, Set<(event: EngineEvent<unknown>) => void>>();
  return {
    subscribe<T>(event: string, handler: (event: EngineEvent<T>) => void) {
      const h = handler as (event: EngineEvent<unknown>) => void;
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(h);
      return Promise.resolve(() => {
        set.delete(h);
      });
    },
    deliver(message) {
      const open = current();
      if (!message || !(Array.isArray(open) ? open.includes(message.server) : message.server === open)) return;
      for (const handler of handlers.get(message.event) ?? []) {
        try {
          handler({ payload: message.payload });
        } catch (e) {
          console.error(`Handler for ${message.event} failed`, e);
        }
      }
    },
  };
}

// A server this app is connected to (Settings → Servers)
export interface ServerInfo {
  id: string;
  url: string;
  // "cachy" for cachy.tailnet.ts.net
  label: string;
  user: string;
  role: string;
  signed_in: boolean;
}

// The library open in the window: a folder on this computer (server null) or a library of a server, by the
// server's id and the library's root there
export interface LibraryRef {
  server: string | null;
  root: string;
}

// Remembered as one string ("lumina_active_folder"): a local path as it is, a server's library as
// "lumina-server:<id>|<root>"
const REF_PREFIX = "lumina-server:";

export function libraryRefToString(ref: LibraryRef): string {
  return ref.server ? `${REF_PREFIX}${ref.server}|${ref.root}` : ref.root;
}

export function libraryRefFromString(value: string): LibraryRef {
  if (!value.startsWith(REF_PREFIX)) return { server: null, root: value };
  const rest = value.slice(REF_PREFIX.length);
  const bar = rest.indexOf("|");
  if (bar <= 0) return { server: null, root: "" };
  return { server: rest.slice(0, bar), root: rest.slice(bar + 1) };
}
