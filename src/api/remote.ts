// The engine on a Lumina server, reached over HTTP and one WebSocket (the web client, and later the desktop's
// client mode). The same three calls as the local engine:
//   call       POST /api/rpc/{command} with the arguments the desktop sends to Tauri
//   subscribe  one shared WebSocket on /api/events for every event, reconnecting by itself
//   mediaUrl   /media/{thumb|original|preview|face}/{id}: by id, so the client never needs the server's paths
// No Tauri imports here: the browser loads this, and the tests run it under Node.
import type { EngineEvent, MediaRef, Transport } from "./transport";

export interface RemoteOptions {
  // The server's origin ("https://cachy.example.ts.net"); empty for the page's own origin
  base?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  // A request answered 401: the session ended (logged out elsewhere, password changed, 90 days idle)
  onUnauthorized?: () => void;
  // Fixed in tests; a random one per window otherwise
  clientId?: string;
}

// Sent by the client itself when its event socket connects again after a drop (the web client here, the
// desktop app from src-tauri/src/remote.rs): events from while it was down are lost, so the open library,
// people and albums are fetched again
export const RECONNECTED = "events-reconnected";

// Lowest to highest. A guest sees only albums shared with them; a viewer everything, read-only; an uploader
// can also upload (phase 3); an editor rates, tags, names faces and makes albums; an admin does everything.
export const ROLES = ["guest", "viewer", "uploader", "editor", "admin"] as const;
export type Role = (typeof ROLES)[number];

export interface RemoteUser {
  name: string;
  role: Role;
}

// At least this role (an unknown role counts as the lowest)
export function hasRole(user: Pick<RemoteUser, "role"> | null | undefined, wanted: Role): boolean {
  return !!user && ROLES.indexOf(user.role) >= ROLES.indexOf(wanted);
}

// Commands and media ids may only be plain words: never let one change the URL's path
function segment(id: string): string {
  return encodeURIComponent(id);
}

// A face crop is named after its face id ("<hash>_12_34.jpg"), which is what the server looks it up by
export function faceIdFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.replace(/\.jpg$/i, "");
}

export function mediaPath(ref: MediaRef): string {
  switch (ref.kind) {
    case "thumb":
      return `/media/thumb/${segment(ref.hash)}`;
    case "original":
      return `/media/original/${segment(ref.hash)}`;
    case "preview":
      return `/media/preview/${segment(ref.hash)}`;
    case "face":
      return `/media/face/${segment(faceIdFromPath(ref.path))}`;
  }
}

// The error text of a failed answer: the server's {"error": "..."}, or a plain description. The frontend
// matches error texts (`String(err).includes(...)`), so it is always a plain string, as from Tauri.
export async function errorText(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    if (body && typeof body.error === "string") return body.error;
  } catch {
    // not JSON (a proxy's error page, say)
  }
  return `The server answered ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""}`;
}

// Requests that change something carry this header; a page on another site can't send it with the cookie
const HEADERS = { "Content-Type": "application/json", "X-Lumina": "1" };

export function createRemoteTransport(options: RemoteOptions = {}): Transport & { close(): void; clientId: string } {
  const base = options.base ?? "";
  // This window's name in change events (photos-changed, ...): it already shows its own changes
  const clientId = options.clientId ?? Math.random().toString(36).slice(2, 12);
  const headers = { ...HEADERS, "X-Lumina-Client": clientId };
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const Socket = options.WebSocket ?? (typeof WebSocket === "undefined" ? undefined : WebSocket);

  async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    let resp: Response;
    try {
      resp = await doFetch(`${base}/api/rpc/${segment(command)}`, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify(args ?? {}),
      });
    } catch (e) {
      return Promise.reject(`Can't reach the server (${String(e)})`);
    }
    if (!resp.ok) {
      if (resp.status === 401) options.onUnauthorized?.();
      return Promise.reject(await errorText(resp));
    }
    const text = await resp.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  // One WebSocket for every subscription. It opens with the first subscriber, reconnects with a growing
  // pause (1 s, 2 s, 4 s ... at most 30 s) while anyone listens, and closes when the last one leaves.
  const handlers = new Map<string, Set<(event: EngineEvent<unknown>) => void>>();
  let socket: WebSocket | null = null;
  let retryDelay = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let connectedBefore = false;

  function deliver(event: string, payload: unknown) {
    for (const handler of handlers.get(event) ?? []) {
      try {
        handler({ payload });
      } catch (e) {
        console.error(`Handler for ${event} failed`, e);
      }
    }
  }

  function socketUrl(): string {
    if (base) return base.replace(/^http/, "ws") + "/api/events";
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/api/events`;
  }

  function listening(): boolean {
    for (const set of handlers.values()) if (set.size > 0) return true;
    return false;
  }

  function connect() {
    if (closed || socket || !Socket || !listening()) return;
    const ws = new Socket(socketUrl());
    socket = ws;
    ws.onopen = () => {
      retryDelay = 1000;
      // What happened while the socket was down never comes: the window looks again (see RECONNECTED)
      if (connectedBefore) deliver(RECONNECTED, null);
      connectedBefore = true;
    };
    ws.onmessage = (msg: MessageEvent) => {
      let data: { event?: unknown; payload?: unknown };
      try {
        data = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (typeof data.event !== "string") return;
      deliver(data.event, data.payload);
    };
    ws.onclose = () => {
      socket = null;
      if (closed || !listening()) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    };
  }

  function subscribe<T>(event: string, handler: (event: EngineEvent<T>) => void): Promise<() => void> {
    const h = handler as (event: EngineEvent<unknown>) => void;
    let set = handlers.get(event);
    if (!set) handlers.set(event, (set = new Set()));
    set.add(h);
    connect();
    return Promise.resolve(() => {
      set.delete(h);
      if (!listening()) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        socket?.close();
        socket = null;
      }
    });
  }

  return {
    call,
    subscribe,
    clientId,
    mediaUrl: (ref) => base + mediaPath(ref),
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    },
  };
}

// The session: who is logged in (null when nobody is), logging in and out
export function createRemoteAuth(options: Pick<RemoteOptions, "base" | "fetch"> = {}) {
  const base = options.base ?? "";
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return {
    async me(): Promise<RemoteUser | null> {
      const resp = await doFetch(`${base}/api/auth/me`, { credentials: "same-origin" });
      if (resp.status === 401) return null;
      if (!resp.ok) throw new Error(await errorText(resp));
      return resp.json();
    },
    async login(name: string, password: string): Promise<RemoteUser> {
      const resp = await doFetch(`${base}/api/auth/login`, {
        method: "POST",
        credentials: "same-origin",
        headers: HEADERS,
        body: JSON.stringify({ name, password }),
      });
      if (!resp.ok) throw new Error(await errorText(resp));
      return resp.json();
    },
    async logout(): Promise<void> {
      await doFetch(`${base}/api/auth/logout`, { method: "POST", credentials: "same-origin", headers: HEADERS });
    },
  };
}

// Uploads a backup to restore (admin page). XMLHttpRequest rather than fetch, for the upload's progress.
export function uploadBackup(
  file: Blob,
  onProgress: (sent: number, total: number) => void,
  base = ""
): Promise<{ file: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/api/admin/restore`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Lumina", "1");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onload = () => {
      let body: { error?: string; file?: string; bytes?: number } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON (a proxy's error page)
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.file) resolve({ file: body.file, bytes: body.bytes ?? 0 });
      else reject(body.error ?? `The server answered ${xhr.status}`);
    };
    xhr.onerror = () => reject("Can't reach the server");
    xhr.send(file);
  });
}
