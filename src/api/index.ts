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
  decodeCentroid,
  groupAcrossSources,
  mergeSources,
  nameOn,
  suggestSamePeople,
  type Centroid,
  type NameSuggestion,
  shownPersonName,
  withLocalIds,
  withPeopleNamed,
  type PersonName,
  type PersonPart,
  mergeStatus,
  sourceKey,
  splitByHome,
  type Copies,
  type LocalValues,
  type Source,
} from "./allPhotos.ts";
import type { FaceCluster, PersonItem, PhotoItem, SemanticHit, SemanticStatus, SimilarFaceCandidate } from "../types/lumina";

export type { EngineEvent, MediaRef, Transport, RemoteUser, Role, LibraryRef, ServerInfo, Source };
export { libraryRefFromString, libraryRefToString };
export { hasRole, RECONNECTED, uploadBackup };

// Opens the admin page (from the account menu; App shows it)
export const OPEN_ADMIN_EVENT = "lumina-open-admin";

// Inside the Tauri desktop app (rather than a browser)
export const inDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// The app on an Android phone (docs/plans/android.md): the same app as the desktop's, a client of a server,
// in the phone layout
export const onAndroid = inDesktopApp && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

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
  // A photo of the phone itself (the phone app's "This phone"): through the lumina-phone protocol (phone.rs)
  if (ref.kind !== "face" && ref.path.startsWith("phone:")) {
    // Its videos play from the app's video server on 127.0.0.1: Android's player doesn't read the app's protocols
    const server = localMediaServer();
    if (server && ref.kind !== "thumb" && ref.path.startsWith("phone:v:")) {
      return `${server.base}/phone/${server.token}?key=v${ref.path.slice(8)}`;
    }
    return convertFileSrc(`${ref.kind === "thumb" ? "thumb" : "original"}/${ref.path.slice(6).replace(":", "")}`, "lumina-phone");
  }
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
  localIds: Map<string, string[]>;
  fromLocal: Map<string, string>;
  // Each server's names of this account's own for its people (get_person_names), by person
  names: Map<string, Map<string, PersonName>>;
  // Each person the window shows, by the name it shows: the sources they come from (get_people)
  parts: Map<string, PersonPart[]>;
  // Albums and smart albums of every engine, under numbers of All photos' own
  albums: Map<number, { engine: string; id: number }>;
  searches: Map<number, { engine: string; id: number }>;
  // The people each photo shows, for People's counts (a photo in two places counts once)
  people: Map<string, string[]>;
}

let all: AllState = {
  sources: new Map(),
  copies: new Map(),
  localValues: new Map(),
  placed: new Map(),
  faces: new Map(),
  localIds: new Map(),
  fromLocal: new Map(),
  names: new Map(),
  parts: new Map(),
  albums: new Map(),
  searches: new Map(),
  people: new Map(),
};

// The phone app's source for the phone's own photos (src-tauri/src/phone.rs)
export const PHONE_ROOT = "phone";

// The server a photo All photos shows comes from (null: this computer or phone)
export function allPhotosServerOf(hash: string): string | null {
  const engine = engineOfShown(hash);
  return engine ? engine : null;
}

// This account may change the photo (name its faces, rate it): All photos knows a home for it. A library open on
// its own leaves it to the engine, which refuses what the account's role can't do.
export function canEditPhoto(hash: string): boolean {
  return openLibrary !== ALL_PHOTOS || !!all.copies.get(hash)?.home;
}

// Sent when All photos has listed its libraries again: albums, smart albums and people are asked again
export const ALL_PHOTOS_LOADED = "lumina-all-photos-loaded";

// Sent when photos weren't added to an album because they aren't in its library: { count, where }
export const ALBUM_SKIPPED_EVENT = "lumina-album-skipped";

// "cachy" for a server's sources ("cachy: Library"), "This PC" for this computer's
function engineLabel(engine: string): string {
  if (engine === "") return "This PC";
  const s = [...all.sources.values()].find((x) => x.server === engine);
  if (!s) return engine;
  return s.label.includes(": ") ? s.label.slice(0, s.label.lastIndexOf(": ")) : s.label;
}

// This account may change people and albums there (this computer's always)
function engineEditable(engine: string): boolean {
  return engine === "" || [...all.sources.values()].some((s) => engineOf(s) === engine && s.editable);
}

// How the window names an engine's people (this computer's by their own names)
function showOn(engine: string): (name: string) => string {
  return engine === "" ? (name) => name : (name) => shownPersonName(name, all.names.get(engine), engineLabel(engine));
}

// The sources of a person All photos shows (People → the person's menu)
export function allPhotosPersonParts(name: string): PersonPart[] {
  return all.parts.get(name.toLowerCase()) ?? [];
}

// A name of this account's own for a server's person, on the server and in the window's copy of them
async function setOwnName(engine: string, person: string, shownAs: string | null, apart: boolean): Promise<void> {
  await engineTransport(engine).call("set_person_name", { person, shownAs, apart });
  const names = all.names.get(engine) ?? new Map<string, PersonName>();
  names.set(person.toLowerCase(), { person, shown_as: shownAs, apart });
  all.names.set(engine, names);
}

// "Not the same person" (apart) and "The same person again": kept with this account on each server
export async function setPersonApart(name: string, apart: boolean): Promise<void> {
  for (const p of allPhotosPersonParts(name)) {
    if (p.engine !== "") await setOwnName(p.engine, p.name, p.shownAs, apart);
  }
}

// ---------- Suggested names (milestone 5) ----------

const DISMISSED_KEY = "lumina_same_person_dismissed";
const suggestionKey = (s: NameSuggestion) => `${s.from.engine}|${s.from.name}~${s.to.engine}|${s.to.name}`.toLowerCase();

function dismissedSuggestions(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

// People of two libraries whose faces look alike under different names ("Looks like Maarten on this PC")
export async function allPhotosNameSuggestions(): Promise<NameSuggestion[]> {
  if (openLibrary !== ALL_PHOTOS) return [];
  await allLoading;
  const lists = await Promise.all(
    engines().map(async (engine) => {
      const list = await engineTransport(engine)
        .call<{ name: string; centroid: string }[]>("person_centroids")
        .catch(() => [] as { name: string; centroid: string }[]);
      const show = showOn(engine);
      return list.map((c): Centroid => ({ engine, name: show(c.name), vector: decodeCentroid(c.centroid) }));
    })
  );
  const dismissed = dismissedSuggestions();
  return suggestSamePeople(lists.flat()).filter((s) => !dismissed.has(suggestionKey(s)));
}

// "Same person": the person takes the other's name, as a name of this account's own on a server (nothing
// changes for anyone else), or renamed when on this PC
export async function acceptNameSuggestion(s: NameSuggestion): Promise<void> {
  const part = allPhotosPersonParts(s.from.name).find((p) => p.engine === s.from.engine);
  if (!part) return;
  if (part.engine === "") await localTransport.call("rename_person", { oldName: part.name, newName: s.to.name });
  else await setOwnName(part.engine, part.name, s.to.name, false);
}

export function dismissNameSuggestion(s: NameSuggestion) {
  const dismissed = dismissedSuggestions();
  dismissed.add(suggestionKey(s));
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
  } catch {}
}

// "Use their name again": the names of this account's own for this person go
export async function dropOwnNames(name: string): Promise<void> {
  for (const p of allPhotosPersonParts(name)) {
    if (p.shownAs) await setOwnName(p.engine, p.name, null, p.apart);
  }
}

// All photos has listed this photo (a thumbnail pass may report one it hasn't yet)
export function allPhotosKnows(hash: string): boolean {
  return all.copies.has(hash);
}

// Near-duplicates across libraries found again (after a thumbnail pass made new fingerprints)
export function allPhotosRegroup(photos: PhotoItem[]): PhotoItem[] {
  return groupAcrossSources(photos, (p) => all.copies.get(p.hash)?.shown ?? "");
}

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
// The phone app keeps the last list of each server library (offline.rs): it opens from them (startAllPhotosFromKept)
// and shows a server out of reach as it was last seen. The phone's own list isn't kept: Android lists it without
// a connection, and sooner than a kept copy of it reads.
let fromKept = false;
let offlineServers: string[] = [];

// The next All photos load takes the kept lists where there are some (the window then loads again, for real)
export function startAllPhotosFromKept() {
  fromKept = true;
}

// The phone's photos (phone.rs): a template of what they have in common and a row each, made into photos here
type PhoneRow = [
  hash: string,
  name: string,
  subfolder: string,
  path: string,
  sizeKb: number,
  width: number,
  height: number,
  capturedAt: string,
  durationMs: number | null,
  latitude: number | null,
  longitude: number | null,
  location: string,
  cameraModel: string,
  lensModel: string | null,
  focalLength: string | null,
  aperture: string | null,
  shutterSpeed: string | null,
  iso: string | null,
];

async function phonePhotos(): Promise<PhotoItem[]> {
  const { template, rows } = await callLocal<{ template: PhotoItem; rows: PhoneRow[] }>("phone_photos");
  return rows.map(([hash, name, subfolder, path, size_kb, width, height, captured_at, duration_ms, latitude, longitude, location, camera_model, lens_model, focal_length, aperture, shutter_speed, iso]) => ({
    ...template,
    // Lists of its own: nothing shares them between photos
    tags: [],
    people: [],
    faces: [],
    hash,
    name,
    subfolder,
    path,
    thumb_path: path,
    size_kb,
    width,
    height,
    captured_at,
    media_type: path.startsWith("phone:v:") ? "video" : "photo",
    duration_ms,
    latitude,
    longitude,
    location,
    camera_model,
    lens_model,
    focal_length,
    aperture,
    shutter_speed,
    iso,
  }));
}

// The content ids of the photos a server holds (its thumbnails are what Keep all thumbnails keeps)
export function allPhotosOnServer(server: string): string[] {
  const keys = new Set([...all.sources.values()].filter((s) => s.server === server).map(sourceKey));
  return [...all.copies.entries()].filter(([, c]) => c.copies.some((k) => keys.has(k))).map(([hash]) => hash);
}

// The servers the last load couldn't reach, whose photos show as last seen
export function allPhotosOffline(): string[] {
  return offlineServers;
}

async function kept<T>(key: string): Promise<T | null> {
  const found = await callLocal<{ value: T } | null>("offline_load", { key }).catch(() => null);
  return found ? found.value : null;
}

function keep(key: string, value: unknown) {
  if (onAndroid) void callLocal("offline_save", { key, value }).catch(() => {});
}

// A list from the server, kept for next time; the kept one when the server can't be reached (or when starting
// from the kept lists)
async function keptOr<T>(key: string, server: string, fetch: () => Promise<T>, useKept: boolean): Promise<T> {
  // A server that didn't answer once in this load isn't waited for again (each try takes the connect timeout)
  const out = offlineServers.includes(server);
  if (onAndroid && (useKept || out)) {
    const old = await kept<T>(key);
    if (old !== null) return old;
    if (out) throw new Error(`${server} is out of reach`);
  }
  try {
    const fresh = await fetch();
    keep(key, fresh);
    return fresh;
  } catch (err) {
    const old = onAndroid ? await kept<T>(key) : null;
    if (old === null) throw err;
    if (!offlineServers.includes(server)) offlineServers = [...offlineServers, server];
    return old;
  }
}

export async function allPhotosCandidates(useKept = false): Promise<Source[]> {
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
  // The phone app: the phone's own photos and videos (its camera roll), looked at here, backed up to a server
  if (onAndroid) sources.unshift({ server: null, root: PHONE_ROOT, label: "This phone", editable: false, uploadable: false });
  const servers = await callLocal<ServerInfo[]>("server_list").catch(() => [] as ServerInfo[]);
  for (const s of servers.filter((s) => s.signed_in)) {
    try {
      const list = await keptOr(`libraries:${s.id}`, s.id, () => desktopRemote(s.id).call<Listed[]>("list_libraries"), useKept);
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

// Whether All photos holds a folder on this PC (the web client's never does): only then do "on the server"
// marks and the Where filter say anything
export function allPhotosHasLocal(): boolean {
  return [...all.sources.values()].some((s) => s.server === null);
}

// Whether photos can be backed up from here: a server library this account may upload to is in the view
export function allPhotosCanBackUp(): boolean {
  return [...all.sources.values()].some((s) => s.server !== null && s.uploadable);
}

// The window asked to watch All photos (watch_library): every folder on this computer in it is watched
let watchAllPhotos = false;

function watchAllPhotosFolders(): Promise<void> {
  // The phone's photos aren't a folder: phone.rs tells the window when they change
  const roots = [...all.sources.values()].filter((s) => s.server === null && s.root !== PHONE_ROOT).map((s) => s.root);
  return callLocal("watch_libraries", { roots: watchAllPhotos ? roots : [] });
}

// `check`: the folders on this computer to scan on disk (new, changed and removed files); the others are
// listed as the database has them. Absent, every one is checked, as when a single folder opens. The scans go
// one after another (often one disk), beside each other's thumbnail passes.
// The load running now: lists of albums, people and trips wait for it (they ask its sources)
let allLoading: Promise<unknown> = Promise.resolve();

function loadAll(check?: string[]): Promise<PhotoItem[]> {
  const loading = loadAllNow(check);
  allLoading = loading.catch(() => {});
  return loading;
}

async function loadAllNow(check?: string[]): Promise<PhotoItem[]> {
  const useKept = fromKept;
  fromKept = false;
  offlineServers = [];
  const sources = includedSources(await allPhotosCandidates(useKept), excludedSources());
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
        const server = source.server;
        const photos =
          server !== null
            ? await keptOr(
                `photos:${server}|${source.root}`,
                server,
                () => engineTransport(server).call<PhotoItem[]>("scan_folder", { folderPath: source.root, forceReprocess: false }),
                useKept
              )
            : source.root === PHONE_ROOT
              ? await phonePhotos()
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
  const sourceMap = new Map(sources.map((s) => [sourceKey(s), s]));
  // A server's people as this account names them
  const servers = [...new Set(sources.map((s) => s.server).filter((s): s is string => s !== null))];
  const names = new Map(
    await Promise.all(
      servers.map(async (server) => {
        const list = await keptOr(`names:${server}`, server, () => engineTransport(server).call<PersonName[]>("get_person_names"), useKept).catch(
          () => [] as PersonName[]
        );
        return [server, new Map(list.map((n) => [n.person.toLowerCase(), n]))] as const;
      })
    )
  );
  all = { ...all, sources: sourceMap, names };
  const named = lists.map((l) => (l.source.server === null ? l : { ...l, photos: l.photos.map((p) => withPeopleNamed(p, showOn(engineOf(l.source)))) }));
  const mergedSources = mergeSources(named, sameAs);
  // Near-duplicates of two libraries share a burst group too
  const merged = { ...mergedSources, photos: groupAcrossSources(mergedSources.photos, (p) => mergedSources.copies.get(p.hash)?.shown ?? "") };
  const placed = new Map<string, Placed>();
  const faces = new Map<string, string>();
  for (const p of merged.photos) {
    placed.set(p.hash, { subfolder: p.subfolder, also_in: p.also_in, copies: p.copies, home: p.home });
    const shown = sourceMap.get(merged.copies.get(p.hash)!.shown)!;
    for (const f of p.faces ?? []) if (f.face_thumb) faces.set(f.face_thumb, engineOf(shown));
  }
  const fromLocal = new Map([...merged.localIds].flatMap(([id, own]) => own.map((h): [string, string] => [h, id])));
  const people = new Map(merged.photos.map((p) => [p.hash, p.people]));
  all = { ...all, sources: sourceMap, copies: merged.copies, localValues: merged.localValues, placed, faces, localIds: merged.localIds, fromLocal, people };
  accessChanged();
  if (watchAllPhotos) await watchAllPhotosFolders().catch((err) => console.error("All photos: could not watch this computer's folders", err));
  await copyDown(merged.photos);
  window.dispatchEvent(new Event(ALL_PHOTOS_LOADED));
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

// A command's person names as that engine knows them ("Maarten" is cachy's "Me" for this account)
function namedFor(engine: string, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const key of ["name", "personName"]) if (typeof out[key] === "string") out[key] = nameOn(engine, out[key] as string, all.parts);
  return out;
}

async function editAll<T>(command: string, args: Record<string, unknown>, hashes: string[]): Promise<T> {
  const { byEngine, readOnly, alsoLocal } = splitByHome(hashes, all.copies, all.sources);
  const results = await Promise.all(
    [...byEngine].map(([engine, part]) => {
      const partArgs = namedFor(engine, { ...args, hashes: part });
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

// One engine per server among the sources (and this computer's when a local folder is one), this computer's
// first and the servers by name, so the numbers albums get below stay the same between loads
// The engines holding a library in the view. The phone's own photos aren't in an engine (phone.rs lists them): the
// phone's engine has no library, and its smart search would wait for models the phone hasn't got
function engines(): string[] {
  return [...new Set([...all.sources.values()].filter((s) => s.root !== PHONE_ROOT).map(engineOf))].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}

// A face an engine suggests, as the window shows it: its photo by All photos' id, its crop served by that engine,
// the person it has now by their shown name (face ids stay the engine's: faceCommand reads them either way)
function fromEngineFace(engine: string, c: SimilarFaceCandidate): SimilarFaceCandidate {
  if (c.face_thumb) all.faces.set(c.face_thumb, engine);
  return {
    ...c,
    hash: engine === "" ? all.fromLocal.get(c.hash) ?? c.hash : c.hash,
    current_person: c.current_person ? showOn(engine)(c.current_person) : c.current_person,
  };
}

// A face's engine: the one of the copy whose faces the window shows, when this account may change it there
function faceEngine(faceId: string): { engine: string | undefined; id: string } {
  const own = faceId.split("_")[0];
  const id = all.fromLocal.get(own) ?? own;
  return { engine: all.copies.get(id)?.home ? engineOfShown(id) : undefined, id };
}

// Commands about faces (faceIds, or one faceId): each engine gets its faces, under its names for people
async function faceCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const ids: string[] = Array.isArray(args.faceIds) ? (args.faceIds as string[]) : [args.faceId as string];
  const byEngine = new Map<string, string[]>();
  const readOnly = new Set<string>();
  for (const faceId of ids) {
    const { engine, id } = faceEngine(faceId);
    if (engine === undefined) {
      readOnly.add(id);
      continue;
    }
    byEngine.set(engine, [...(byEngine.get(engine) ?? []), faceId]);
  }
  const results = await Promise.all(
    [...byEngine].map(async ([engine, part]) => {
      const engineArgs = namedFor(engine, Array.isArray(args.faceIds) ? { ...args, faceIds: part } : args);
      return [engine, await engineTransport(engine).call<unknown>(command, engineArgs)] as const;
    })
  );
  readOnlyLeft([...readOnly]);
  // Faces per photo, as some commands answer: by All photos' ids, with the names the window shows
  if (results.length > 0 && results.every(([, r]) => r && typeof r === "object" && !Array.isArray(r))) {
    const merged: Record<string, unknown> = {};
    for (const [engine, r] of results) {
      const show = showOn(engine);
      for (const [hash, faces] of Object.entries(r as Record<string, unknown>)) {
        merged[all.fromLocal.get(hash) ?? hash] = Array.isArray(faces)
          ? faces.map((f) => (f?.person_name ? { ...f, person_name: show(f.person_name) } : f))
          : faces;
      }
    }
    return merged as T;
  }
  return results[0]?.[1] as T;
}

// An album or smart album of an engine under a number of All photos' own
function foreignId(engine: string, id: number): number {
  return Math.max(0, engines().indexOf(engine)) * 1_000_000 + id;
}

async function listCollections<T extends { id: number; hashes?: string[] }>(
  command: string,
  into: Map<number, { engine: string; id: number }>
): Promise<(T & { source: string; readOnly: boolean })[]> {
  into.clear();
  const lists = await Promise.all(
    engines().map(async (engine) => {
      const list = await engineTransport(engine).call<T[]>(command).catch(() => [] as T[]);
      return list.map((item) => {
        const id = foreignId(engine, item.id);
        into.set(id, { engine, id: item.id });
        const hashes = item.hashes && engine === "" ? item.hashes.map((h) => all.fromLocal.get(h) ?? h) : item.hashes;
        return { ...item, id, ...(hashes ? { hashes } : {}), source: engineLabel(engine), readOnly: !engineEditable(engine), engine, realId: item.id };
      });
    })
  );
  return lists.flat();
}

// Where a new album or smart album of All photos goes: the first server this account may edit, else this PC
function collectionHome(): string {
  return engines().find((e) => e !== "" && engineEditable(e)) ?? (serverTransport ? engines()[0] : "");
}

// Album commands by All photos' number: the album's engine, with the photos that are in its library
async function albumCommand<T>(command: string, args: Record<string, unknown>, map: Map<number, { engine: string; id: number }>): Promise<T> {
  const target = map.get(args.id as number);
  if (!target) throw new Error("That album isn't in All photos any more: open its library on its own");
  if (!Array.isArray(args.hashes)) return engineTransport(target.engine).call<T>(command, { ...args, id: target.id });
  const inLibrary: string[] = [];
  let skipped = 0;
  for (const h of args.hashes as string[]) {
    const there = all.copies.get(h)?.copies.some((k) => {
      const s = all.sources.get(k);
      return !!s && engineOf(s) === target.engine;
    });
    if (there) inLibrary.push(h);
    else skipped++;
  }
  if (skipped > 0) window.dispatchEvent(new CustomEvent(ALBUM_SKIPPED_EVENT, { detail: { count: skipped, where: engineLabel(target.engine) } }));
  if (inLibrary.length === 0) return [] as T;
  const engineArgs = { ...args, id: target.id, hashes: inLibrary };
  const result = await engineTransport(target.engine).call<T>(command, target.engine === "" ? withLocalIds(engineArgs, all.localIds) : engineArgs);
  return (Array.isArray(result) && target.engine === "" ? result.map((h: string) => all.fromLocal.get(h) ?? h) : result) as T;
}

async function callAll<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (command !== "scan_folder") await allLoading;
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
      const lists = await Promise.all(
        [...byEngine].map(async ([engine, hashes]) =>
          (await engineTransport(engine).call<PhotoItem[]>("get_photos", { hashes })).map((p) => withPeopleNamed(p, showOn(engine)))
        )
      );
      const fresh = lists.flat().map(placeAgain);
      for (const p of fresh) all.people.set(p.hash, p.people);
      await copyDown(fresh);
      return fresh as T;
    }
    case "get_people": {
      const parts = new Map<string, PersonPart[]>();
      const lists = await Promise.all(
        [...all.sources.values()].map(async (s) => {
          const engine = engineOf(s);
          const people = await engineTransport(engine)
            .call<PersonItem[]>("get_people", { rootFolder: s.root })
            .catch(() => [] as PersonItem[]);
          const show = showOn(engine);
          return people.map((p) => {
            if (p.cover_thumb) all.faces.set(p.cover_thumb, engine);
            const shown = show(p.name);
            const own = all.names.get(engine)?.get(p.name.toLowerCase());
            const list = parts.get(shown.toLowerCase()) ?? [];
            if (!list.some((x) => x.engine === engine)) {
              list.push({ engine, label: engineLabel(engine), name: p.name, editable: engineEditable(engine), shownAs: own?.shown_as ?? null, apart: !!own?.apart });
            }
            parts.set(shown.toLowerCase(), list);
            return { ...p, name: shown };
          });
        })
      );
      all.parts = parts;
      // A person's photos as the view shows them: a photo in two places counts once
      const counts = new Map<string, number>();
      for (const names of all.people.values()) for (const n of new Set(names.map((x) => x.toLowerCase()))) counts.set(n, (counts.get(n) ?? 0) + 1);
      return mergePeople(lists).map((p) => ({ ...p, photo_count: counts.get(p.name.toLowerCase()) || p.photo_count })) as T;
    }
    // A person of several sources: renamed where this account may edit, given a name of its own elsewhere
    // (a merge is a rename to a name that exists)
    case "rename_person": {
      const newName = String(args.newName ?? "").trim();
      for (const p of allPhotosPersonParts(String(args.oldName ?? ""))) {
        if (p.editable) await engineTransport(p.engine).call("rename_person", { oldName: p.name, newName });
        else await setOwnName(p.engine, p.name, newName, p.apart);
      }
      const old = String(args.oldName ?? "").toLowerCase();
      for (const [hash, names] of all.people) {
        if (names.some((n) => n.toLowerCase() === old)) all.people.set(hash, [...new Set(names.map((n) => (n.toLowerCase() === old ? newName : n)))]);
      }
      return newName as T;
    }
    case "set_person_hidden":
    case "set_person_starred": {
      for (const p of allPhotosPersonParts(String(args.name ?? ""))) {
        if (p.editable) await engineTransport(p.engine).call(command, { ...args, name: p.name });
      }
      return undefined as T;
    }
    // Suggested faces are worked out by each engine for its own people, over all its libraries; a person of
    // several engines adds them up under the name the window shows
    case "get_pending_face_match_counts": {
      const counts: Record<string, number> = {};
      await Promise.all(
        engines()
          .filter(engineEditable)
          .map(async (engine) => {
            const part = await engineTransport(engine)
              .call<Record<string, number>>(command, { rootFolder: null })
              .catch(() => ({}) as Record<string, number>);
            const show = showOn(engine);
            for (const [name, n] of Object.entries(part)) counts[show(name)] = (counts[show(name)] ?? 0) + n;
          })
      );
      return counts as T;
    }
    case "find_similar_faces": {
      const parts = allPhotosPersonParts(String(args.personName ?? "")).filter((p) => p.editable);
      const lists = await Promise.all(
        parts.map(async (p) => {
          const found = await engineTransport(p.engine).call<SimilarFaceCandidate[]>(command, { ...args, personName: p.name, rootFolder: null });
          return found.map((c) => fromEngineFace(p.engine, c));
        })
      );
      return lists.flat().sort((a, b) => b.similarity - a.similarity) as T;
    }
    case "get_unknown_face_clusters": {
      const lists = await Promise.all(
        engines()
          .filter(engineEditable)
          .map(async (engine) => {
            const clusters = await engineTransport(engine)
              .call<FaceCluster[]>(command, { rootFolder: null })
              .catch(() => [] as FaceCluster[]);
            return clusters.map((c) => ({
              ...c,
              samples: c.samples.map((s) => fromEngineFace(engine, s)),
            }));
          })
      );
      return lists.flat().sort((a, b) => b.size - a.size) as T;
    }
    // Albums and smart albums of every library, each in its own
    case "get_albums":
      return (await listCollections("get_albums", all.albums)) as T;
    case "get_saved_searches":
      return (await listCollections("get_saved_searches", all.searches)) as T;
    case "create_album":
    case "save_search": {
      const engine = command === "create_album" ? collectionHome() : serverTransport ? collectionHome() : "";
      const id = await engineTransport(engine).call<number>(command, args);
      const own = foreignId(engine, id);
      (command === "create_album" ? all.albums : all.searches).set(own, { engine, id });
      return own as T;
    }
    case "rename_album":
    case "delete_album":
    case "add_to_album":
    case "remove_from_album":
    case "share_album":
    case "get_album_shares":
      return albumCommand<T>(command, args, all.albums);
    case "delete_saved_search":
    case "share_search":
    case "get_search_shares":
      return albumCommand<T>(command, args, all.searches);
    case "semantic_status": {
      const list = await Promise.all(
        [...all.sources.values()].filter((s) => s.root !== PHONE_ROOT).map((s) =>
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
    // Trip names of every library (a new one is kept where the window's own commands go)
    case "get_trip_names": {
      const maps = await Promise.all(engines().map((e) => engineTransport(e).call<Record<string, string>>(command).catch(() => ({}))));
      return Object.assign({}, ...maps.reverse()) as T;
    }
  }
  if (Array.isArray(args.faceIds) || typeof args.faceId === "string") return faceCommand<T>(command, args);
  if (Array.isArray(args.hashes)) return editAll<T>(command, args, args.hashes as string[]);
  if (typeof args.hash === "string") {
    // A change to a photo with no copy this account may change: the note, not the server's refusal
    if (all.copies.get(args.hash) && !all.copies.get(args.hash)!.home && !/^(get_|find_|existing_|make_playable|ensure_)/.test(command)) {
      readOnlyLeft([args.hash]);
      return undefined as T;
    }
    const engine = engineOfShown(args.hash);
    const hash = engine === "" ? all.localIds.get(args.hash)?.[0] ?? args.hash : args.hash;
    if (engine !== undefined) return engineTransport(engine).call<T>(command, namedFor(engine, { ...args, hash }));
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
