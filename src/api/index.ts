// Every engine call, event and file the window shows goes through here, never to Tauri directly. In the
// desktop app that is the engine in the app; in a browser (the web client) it is the server the page came
// from. In the desktop app a library can be on a server too (client mode, desktopRemote.ts): calls, events
// and media then follow the open library, except the commands that are about this computer.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { localMediaServer, localTransport, type EngineEvent, type MediaRef, type Transport } from "./transport.ts";
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
import {
  copyDownEdits,
  engineOf,
  includedSources,
  localValuesOf,
  mergeHits,
  mergePeople,
  mergeSources,
  withLocalIds,
  mergeStatus,
  sourceKey,
  splitByHome,
  type Copies,
  type LocalValues,
  type Source,
} from "./allPhotos.ts";
import type { PersonItem, PhotoItem, SemanticHit, SemanticStatus } from "../types/lumina";

export type { EngineEvent, MediaRef, Transport, RemoteUser, Role, LibraryRef, ServerInfo, Source };
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

// The root that stands for All photos: every source at once (src/api/allPhotos.ts)
export const ALL_PHOTOS = "lumina:all-photos";

// The desktop app's connections to servers (client mode): the app's Rust side does the requests
const remoteEvents = createRemoteEvents(() => (openLibrary === ALL_PHOTOS ? allServers() : openServer));
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
    t = createDesktopRemoteTransport(server, { invoke, convertFileSrc, videoServer: localMediaServer }, remoteEvents, desktopClientId);
    desktopRemotes.set(server, t);
  }
  return t;
}

// A change event this window caused itself (it already shows that change)
export function isOwnChange(payload: { origin?: string } | null | undefined): boolean {
  if (serverTransport) return payload?.origin === serverTransport.clientId;
  return (!!openServer || openLibrary === ALL_PHOTOS) && payload?.origin === desktopClientId;
}

// Logging in and out of the server the web client came from (unused in the desktop app)
export const serverAuth = createRemoteAuth();

// A library on this computer (the desktop app's own): its user may do everything with it
export function openLibraryIsLocal(): boolean {
  return inDesktopApp && openServer === null && openLibrary !== ALL_PHOTOS;
}

// All photos is open: several libraries at once, here and on servers
export function openLibraryIsAll(): boolean {
  return openLibrary === ALL_PHOTOS;
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

export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // The basket is this device's, whatever library a photo is in
  if (command === "set_photo_basket") return (await setBasket(args?.hashes as string[], !!args?.inBasket)) as T;
  if (command === "watch_library") {
    watchAllPhotos = args?.root === ALL_PHOTOS;
    if (watchAllPhotos) return (await watchAllPhotosFolders()) as T;
  }
  if (inDesktopApp && isLocalCommand(command)) return localTransport.call<T>(command, args);
  const result = openLibrary === ALL_PHOTOS ? await callAll<T>(command, args ?? {}) : await transportFor().call<T>(command, args);
  return (command === "scan_folder" || command === "get_photos" ? await withBasket(result as PhotoItem[]) : result) as T;
}

// In the desktop app a handler hears its own engine and the open server library's server: hooks subscribe
// once, and the library they work on can change between the two
export function subscribe<T>(event: string, handler: (event: EngineEvent<T>) => void): Promise<() => void> {
  if (serverTransport) return serverTransport.subscribe<T>(event, handler);
  const offs = [localTransport.subscribe<T>(event, handler), remoteEvents.subscribe<T>(event, handler)];
  return Promise.all(offs).then((fs) => () => fs.forEach((f) => f()));
}

export function mediaUrl(ref: MediaRef): string {
  if (openLibrary === ALL_PHOTOS) {
    // A photo's files come from the engine of the copy the window shows; a face crop from its photo's
    const engine = ref.kind === "face" ? all.faces.get(ref.path) : engineOfShown(ref.hash);
    if (engine !== undefined) return engineTransport(engine).mediaUrl(ref);
  }
  return transportFor().mediaUrl(ref);
}

// ---------- The basket ----------

// The basket belongs to this device (docs/plans/one-view.md, decision 6): in the desktop app it is kept in
// client.db, in a browser in its local storage; a server never has it
const BASKET_KEY = "lumina_basket";
let basket: Set<string> | null = null;
let basketLoading: Promise<Set<string>> | null = null;

function loadBasket(): Promise<Set<string>> {
  if (basket) return Promise.resolve(basket);
  if (!basketLoading) {
    const stored = (): string[] => {
      try {
        return JSON.parse(localStorage.getItem(BASKET_KEY) || "[]");
      } catch {
        return [];
      }
    };
    basketLoading = (inDesktopApp ? callLocal<string[]>("device_basket") : Promise.resolve(stored()))
      .catch(() => [] as string[])
      .then((list) => (basket = new Set(list)));
  }
  return basketLoading;
}

async function setBasket(hashes: string[], inBasket: boolean): Promise<void> {
  const b = await loadBasket();
  for (const h of hashes) {
    if (inBasket) b.add(h);
    else b.delete(h);
  }
  if (inDesktopApp) {
    await callLocal("set_device_basket", { hashes, inBasket });
  } else {
    try {
      localStorage.setItem(BASKET_KEY, JSON.stringify([...b]));
    } catch {}
  }
}

async function withBasket(photos: PhotoItem[]): Promise<PhotoItem[]> {
  if (!Array.isArray(photos)) return photos;
  const b = await loadBasket();
  return photos.map((p) => (p.in_basket === b.has(p.hash) ? p : { ...p, in_basket: b.has(p.hash) }));
}

// ---------- All photos ----------

// Sent with the number of photos an edit left alone because they are shared read-only; App says so
export const READ_ONLY_EVENT = "lumina-read-only-photos";
// Sources taken off All photos (Settings → All photos), by sourceKey
const EXCLUDED_KEY = "lumina_all_photos_off";
// The web client's sources are all on the server the page came from
const WEB_SERVER = "web";

type Placed = Pick<PhotoItem, "subfolder" | "also_in" | "copies" | "home">;

interface AllState {
  sources: Map<string, Source>;
  copies: Map<string, Copies>;
  localValues: Map<string, LocalValues>;
  // Per photo where the merge put it (folder tree paths, copies), for photos fetched again
  placed: Map<string, Placed>;
  // Face crop path → engine
  faces: Map<string, string>;
  // Copies on this computer known there by another id (mergeSources), and the other way round
  localIds: Map<string, string>;
  fromLocal: Map<string, string>;
}

let all: AllState = {
  sources: new Map(),
  copies: new Map(),
  localValues: new Map(),
  placed: new Map(),
  faces: new Map(),
  localIds: new Map(),
  fromLocal: new Map(),
};

// The photo All photos shows for a copy this computer's engine names (its events use its own ids)
export function allPhotosIdOf(localHash: string): string {
  return all.fromLocal.get(localHash) ?? localHash;
}

function allServers(): string[] {
  return [...new Set([...all.sources.values()].map((s) => s.server).filter((s): s is string => s !== null))];
}

function engineTransport(engine: string): Transport {
  if (serverTransport) return serverTransport;
  return engine ? desktopRemote(engine) : localTransport;
}

function engineOfShown(hash: string): string | undefined {
  const c = all.copies.get(hash);
  const s = c ? all.sources.get(c.shown) : undefined;
  return s ? engineOf(s) : undefined;
}

export function excludedSources(): string[] {
  try {
    return JSON.parse(localStorage.getItem(EXCLUDED_KEY) || "[]");
  } catch {
    return [];
  }
}

export function setExcludedSources(keys: string[]) {
  try {
    localStorage.setItem(EXCLUDED_KEY, JSON.stringify(keys));
  } catch {}
}

const lastSegment = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() || root;

// Every library All photos could show: the folders opened on this computer and the libraries of each server
// the app is signed in to (in the web client, the libraries of its server)
export async function allPhotosCandidates(): Promise<Source[]> {
  type Listed = { root: string; name?: string; role?: Role };
  const fromServer = (server: string, label: string, list: Listed[], user?: RemoteUser | null): Source[] =>
    list.map((l) => {
      const role: Role | undefined = hasRole(user ?? null, "admin") ? "admin" : l.role ?? user?.role;
      const at = (wanted: Role) => hasRole(role ? { role } : null, wanted);
      const name = l.name || lastSegment(l.root);
      return { server, root: l.root, label: label ? `${label}: ${name}` : name, editable: at("editor"), uploadable: at("uploader") };
    });
  if (serverTransport) {
    const list = await serverTransport.call<Listed[]>("list_libraries");
    rememberLibraryRoles(list, null);
    const me = await serverAuth.me().catch(() => null);
    return fromServer(WEB_SERVER, "", list, me);
  }
  const local = await callLocal<{ root: string }[]>("local_libraries").catch(() => []);
  const sources: Source[] = local.map((l) => ({ server: null, root: l.root, label: l.root, editable: true, uploadable: false }));
  const servers = await callLocal<ServerInfo[]>("server_list").catch(() => [] as ServerInfo[]);
  for (const s of servers.filter((s) => s.signed_in)) {
    try {
      const list = await desktopRemote(s.id).call<Listed[]>("list_libraries");
      rememberLibraryRoles(list, s.id);
      sources.push(...fromServer(s.id, s.label, list, serverUsers.get(s.id) ?? ({ name: s.user, role: s.role } as RemoteUser)));
    } catch {
      // A server out of reach leaves its photos out until the next reload
    }
  }
  return sources;
}

// The libraries the view came from, by key (the grid's marks and the Where filter read them)
export function allPhotosSources(): Map<string, Source> {
  return all.sources;
}

// Whether photos can be backed up from here: a server library this account may upload to is in the view
export function allPhotosCanBackUp(): boolean {
  return [...all.sources.values()].some((s) => s.server !== null && s.uploadable);
}

// The window asked to watch All photos (watch_library): every folder on this computer in it is watched
let watchAllPhotos = false;

function watchAllPhotosFolders(): Promise<void> {
  const roots = [...all.sources.values()].filter((s) => s.server === null).map((s) => s.root);
  return callLocal("watch_libraries", { roots: watchAllPhotos ? roots : [] });
}

// `check`: the folders on this computer to scan on disk (new, changed and removed files); the others are
// listed as the database has them. Absent, every one is checked, as when a single folder opens. The scans go
// one after another (often one disk), beside each other's thumbnail passes.
async function loadAll(check?: string[]): Promise<PhotoItem[]> {
  const sources = includedSources(await allPhotosCandidates(), excludedSources());
  let localTurn: Promise<unknown> = Promise.resolve();
  const scanHere = (root: string) => {
    const scan = localTurn.then(() => callLocal<PhotoItem[]>("scan_folder", { folderPath: root, forceReprocess: false, keepOthers: true }));
    localTurn = scan.catch(() => {});
    return scan;
  };
  const lists = await Promise.all(
    sources.map(async (source) => {
      try {
        const checked = !check || check.some((root) => sameRoot(root, source.root));
        const photos =
          source.server !== null
            ? await engineTransport(source.server).call<PhotoItem[]>("scan_folder", { folderPath: source.root, forceReprocess: false })
            : checked
              ? await scanHere(source.root)
              : await callLocal<PhotoItem[]>("list_local_library", { root: source.root });
        return { source, photos };
      } catch (err) {
        console.error(`All photos: ${source.label} could not be listed`, err);
        return { source, photos: [] as PhotoItem[] };
      }
    })
  );
  // Second copies of a file here that a backup found on a server, under the server's id
  const sameAs = new Map(serverTransport ? [] : await callLocal<[string, string][]>("local_copy_ids").catch(() => []));
  const merged = mergeSources(lists, sameAs);
  const sourceMap = new Map(sources.map((s) => [sourceKey(s), s]));
  const placed = new Map<string, Placed>();
  const faces = new Map<string, string>();
  for (const p of merged.photos) {
    placed.set(p.hash, { subfolder: p.subfolder, also_in: p.also_in, copies: p.copies, home: p.home });
    const shown = sourceMap.get(merged.copies.get(p.hash)!.shown)!;
    for (const f of p.faces ?? []) if (f.face_thumb) faces.set(f.face_thumb, engineOf(shown));
  }
  const fromLocal = new Map([...merged.localIds].map(([id, own]) => [own, id]));
  all = { sources: sourceMap, copies: merged.copies, localValues: merged.localValues, placed, faces, localIds: merged.localIds, fromLocal };
  accessChanged();
  if (watchAllPhotos) await watchAllPhotosFolders().catch((err) => console.error("All photos: could not watch this computer's folders", err));
  await copyDown(merged.photos);
  return merged.photos;
}

// Copies on this computer of photos whose home is a server take the server's rating, flag, label and tags,
// so a library opened on its own shows the same (best effort: the next load tries again)
async function copyDown(photos: PhotoItem[]) {
  const homes = photos.filter((p) => {
    const home = p.home ? all.sources.get(p.home) : undefined;
    return !!home && home.server !== null && all.localValues.has(p.hash);
  });
  for (const edit of copyDownEdits(homes, all.localValues)) {
    try {
      await localTransport.call(edit.command, withLocalIds(edit.args, all.localIds));
    } catch (err) {
      console.error(`All photos: could not copy ${edit.command} to this computer`, err);
      return;
    }
  }
  for (const p of homes) all.localValues.set(p.hash, localValuesOf(p));
}

// A photo fetched again from its engine, placed as the merge placed it
function placeAgain(p: PhotoItem): PhotoItem {
  const placed = all.placed.get(p.hash);
  return placed ? { ...p, ...placed } : p;
}

// Edits a copy on this computer takes along when the home is a server
const FOLLOWED_BY_LOCAL_COPY = new Set(["set_photos_rating", "set_photo_flag", "set_photo_color_label", "add_tag_batch", "remove_tag_batch"]);

function afterLocalEdit(command: string, args: Record<string, unknown>, hashes: string[]) {
  for (const h of hashes) {
    const v = all.localValues.get(h);
    if (!v) continue;
    if (command === "set_photos_rating") v.rating = args.rating as number;
    else if (command === "set_photo_flag") v.flag = (args.flag ?? null) as PhotoItem["flag"];
    else if (command === "set_photo_color_label") v.color_label = (args.color ?? null) as PhotoItem["color_label"];
    else if (command === "add_tag_batch" && !v.tags.includes(args.tag as string)) v.tags.push(args.tag as string);
    else if (command === "remove_tag_batch") v.tags = v.tags.filter((t) => t !== args.tag);
  }
}

// Photos an edit left alone (shared, read-only): the window fetches their real values again, and says why
function readOnlyLeft(hashes: string[]) {
  if (hashes.length === 0) return;
  const byServer = new Map<string, string[]>();
  for (const h of hashes) {
    const engine = engineOfShown(h);
    if (!engine) continue;
    const list = byServer.get(engine) ?? [];
    list.push(h);
    byServer.set(engine, list);
  }
  for (const [server, list] of byServer) remoteEvents.deliver({ server, event: "photos-changed", payload: { hashes: list, by: "", origin: "" } });
  window.dispatchEvent(new CustomEvent(READ_ONLY_EVENT, { detail: hashes.length }));
}

async function editAll<T>(command: string, args: Record<string, unknown>, hashes: string[]): Promise<T> {
  const { byEngine, readOnly, alsoLocal } = splitByHome(hashes, all.copies, all.sources);
  const results = await Promise.all(
    [...byEngine].map(([engine, part]) => {
      const partArgs = { ...args, hashes: part };
      return engineTransport(engine).call<T>(command, engine === "" ? withLocalIds(partArgs, all.localIds) : partArgs);
    })
  );
  for (const [engine, part] of byEngine) if (engine === "") afterLocalEdit(command, args, part);
  if (FOLLOWED_BY_LOCAL_COPY.has(command) && alsoLocal.length > 0) {
    try {
      await localTransport.call(command, withLocalIds({ ...args, hashes: alsoLocal }, all.localIds));
      afterLocalEdit(command, args, alsoLocal);
    } catch (err) {
      console.error(`All photos: the copy on this computer didn't follow ${command}`, err);
    }
  }
  readOnlyLeft(readOnly);
  if (results.length > 0 && results.every((r) => typeof r === "number")) {
    return results.reduce((a, b) => (a as number) + (b as number), 0) as T;
  }
  return results[0] as T;
}

// One engine per server among the sources (and this computer's when a local folder is one)
function engines(): string[] {
  return [...new Set([...all.sources.values()].map(engineOf))];
}

async function callAll<T>(command: string, args: Record<string, unknown>): Promise<T> {
  switch (command) {
    case "scan_folder":
      return (await loadAll(args.check as string[] | undefined)) as T;
    case "get_photos": {
      const byEngine = new Map<string, string[]>();
      for (const h of (args.hashes as string[]) ?? []) {
        const engine = engineOfShown(h);
        // This computer's engine has no get_photos (nor sends photos-changed): its edits are in the window
        if (!engine) continue;
        const list = byEngine.get(engine) ?? [];
        list.push(h);
        byEngine.set(engine, list);
      }
      const lists = await Promise.all([...byEngine].map(([engine, hashes]) => engineTransport(engine).call<PhotoItem[]>("get_photos", { hashes })));
      const fresh = lists.flat().map(placeAgain);
      await copyDown(fresh);
      return fresh as T;
    }
    case "get_people": {
      const lists = await Promise.all(
        [...all.sources.values()].map(async (s) => {
          const people = await engineTransport(engineOf(s))
            .call<PersonItem[]>("get_people", { rootFolder: s.root })
            .catch(() => [] as PersonItem[]);
          for (const p of people) if (p.cover_thumb) all.faces.set(p.cover_thumb, engineOf(s));
          return people;
        })
      );
      return mergePeople(lists) as T;
    }
    case "semantic_status": {
      const list = await Promise.all(
        [...all.sources.values()].map((s) =>
          engineTransport(engineOf(s))
            .call<SemanticStatus>("semantic_status", { rootFolder: s.root })
            .catch(() => null)
        )
      );
      return mergeStatus(list.filter((s): s is SemanticStatus => !!s)) as T;
    }
    case "semantic_search": {
      const lists = await Promise.all(engines().map((e) => engineTransport(e).call<SemanticHit[]>(command, args).catch(() => [] as SemanticHit[])));
      return mergeHits(lists) as T;
    }
    // Albums, smart albums and trip names stay with their library; All photos lists them in a later step
    case "get_albums":
    case "get_saved_searches":
      return [] as T;
    case "get_trip_names":
      return {} as T;
  }
  if (Array.isArray(args.hashes)) return editAll<T>(command, args, args.hashes as string[]);
  if (typeof args.hash === "string") {
    const engine = engineOfShown(args.hash);
    const hash = engine === "" ? all.localIds.get(args.hash) ?? args.hash : args.hash;
    if (engine !== undefined) return engineTransport(engine).call<T>(command, { ...args, hash });
  }
  if ("rootFolder" in args || "folderPath" in args || "root" in args || Array.isArray(args.ops)) {
    throw new Error("Open the library on its own for this: All photos shows several libraries at once.");
  }
  return (serverTransport ?? localTransport).call<T>(command, args);
}

const sameRoot = (a: string, b: string) => {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
};

// Where an event came from: its server, or null for this computer's engine (the web client hears only its
// server). A folder on this PC and a server library can have the same path, so the root alone doesn't say.
function eventEngine(event: EngineEvent<unknown>): string | null {
  return serverTransport ? WEB_SERVER : event.server ?? null;
}

const fromSource = (s: Source, root: string, event: EngineEvent<unknown>) => s.server === eventEngine(event) && sameRoot(s.root, root);

// An event about the library at `root` concerns the window: it is the open library, or one of All photos'
export function isOpenLibraryRoot(root: string, event: EngineEvent<unknown>): boolean {
  if (openLibrary === ALL_PHOTOS) return [...all.sources.values()].some((s) => fromSource(s, root, event));
  return !!openLibrary && sameRoot(root, openLibrary) && (!!serverTransport || eventEngine(event) === openServer);
}

// All photos shows this photo from the library at `root` (a progress event from that library may update it)
export function allPhotosShownIn(hash: string, root: string, event: EngineEvent<unknown>): boolean {
  const c = all.copies.get(hash);
  const s = c ? all.sources.get(c.shown) : undefined;
  return !!s && fromSource(s, root, event);
}
