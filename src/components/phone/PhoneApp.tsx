import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ChevronRight, CloudUpload, Download, Images, Loader2, Search, Share2, SquareLibrary, Trash2, UserRound, Users, X } from "lucide-react";
import { ALL_PHOTOS, ALL_PHOTOS_LOADED, allPhotosOffline, startAllPhotosFromKept, callLocal, onAndroid, openLibraryIsAll, openLibraryServer, allPhotosCanBackUp, allPhotosSources } from "../../api";
import { whereabouts } from "../../api/allPhotos";
import { refreshServers, useServers } from "../../hooks/useServers";
import { useLibraryState, type LibraryState } from "../../hooks/useLibraryState";
import type { MediaFilter, PhotoItem } from "../../types/lumina";
import { useAccess, useAccount } from "../auth/ServerGate";
import { usePhoneLayout } from "../../app/usePhoneLayout";
import ConfirmDialog from "../modals/ConfirmDialog";
import { NoLibrary } from "../views/EmptyStates";
import PhotoMap from "../views/PhotoMap";
import { WebUploadButton } from "../servers/WebUpload";
import AlbumsScreen from "./AlbumsScreen";
import BackupScreen, { BackupBanner, BackupRing } from "./BackupScreen";
import SettingsScreen from "./SettingsScreen";
import SearchScreen, { PeopleScreen } from "./SearchScreen";
import { ReviewPerson, UnnamedGroups } from "./FaceReview";
import type { PhoneFolder } from "./usePhoneFolders";
import PhoneGrid, { COLUMN_STEPS } from "./PhoneGrid";
import { saveToPhone, sharePhotos } from "./share";
import { freeUpScan, moveToTrash } from "./freeUp";
import { refreshBackup, usePhoneBackup } from "./usePhoneBackup";
import { checkForUpdate, useUpdate } from "./useUpdate";
import PhoneViewer from "./PhoneViewer";
import { withFaces } from "./faces";
import { useScreens, type Scope, type Tab } from "./navigation";
import luminaMark from "../../assets/lumina-mark.svg";

const TABS: { id: Tab; label: string; icon: typeof Images }[] = [
  { id: "photos", label: "Photos", icon: Images },
  { id: "search", label: "Search", icon: Search },
  { id: "people", label: "People", icon: Users },
  { id: "albums", label: "Albums", icon: SquareLibrary },
];

// The phone layout (docs/plans/android-app-ui.md): the phone app's screens, and the web client's on a phone.
// It shares the library state with the full layout (useLibraryState). What is open is a stack of screens over
// the tabs (navigation.ts): back, from the phone or the arrow at the top left, closes the top one.
export default function PhoneApp() {
  const lib = useLibraryState();
  const screens = useScreens();
  const { stack, top, tab, push, back } = screens;
  const libraryRef = useRef<HTMLDivElement>(null);
  const canEdit = useAccess().edit;

  // The phone app opens on All photos (the phone's photos with the server's) once it is signed in to a server
  const { servers } = useServers();
  const signedIn = servers.some((s) => s.signed_in);
  const openedAll = useRef(false);
  // Until the servers are listed the phone app doesn't know yet whether it will open All photos: loading
  const [serversKnown, setServersKnown] = useState(!onAndroid);
  useEffect(() => {
    if (onAndroid) void refreshServers().finally(() => setServersKnown(true));
  }, []);
  useEffect(() => {
    if (!onAndroid || !signedIn || openedAll.current) return;
    openedAll.current = true;
    // The folder may already say All photos (remembered from the last run) without its photos loaded. It opens
    // from the lists kept last time (at once, and without a connection), then loads them again for real.
    if (lib.folder !== ALL_PHOTOS || lib.photos.length === 0) {
      startAllPhotosFromKept();
      void lib.handleLoadFolderPath(ALL_PHOTOS).then(() => lib.handleLoadFolderPath(ALL_PHOTOS));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // Servers the last load couldn't reach: their photos show as last seen
  const [offline, setOffline] = useState<string[]>([]);
  useEffect(() => {
    const update = () => setOffline(allPhotosOffline());
    window.addEventListener(ALL_PHOTOS_LOADED, update);
    return () => window.removeEventListener(ALL_PHOTOS_LOADED, update);
  }, []);
  const offlineLabels = offline.map((id) => servers.find((s) => s.id === id)?.label ?? id).join(", ");

  // Newest first, like a phone's own gallery
  useEffect(() => {
    lib.setSortBy("DATE_DESC");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The grid's size (pinch), remembered on this device
  const [columns, setColumns] = useState(() => {
    const saved = Number(localStorage.getItem("lumina_phone_columns"));
    return COLUMN_STEPS.includes(saved) ? saved : 3;
  });
  const changeColumns = (n: number) => {
    setColumns(n);
    try {
      localStorage.setItem("lumina_phone_columns", String(n));
    } catch {}
  };

  // The grid shows what the topmost grid screen is narrowed to (a person, an album, a search); the library's
  // filters follow it, so going back shows the grid under it as it was
  const grid = [...stack].reverse().find((s) => s.kind === "grid") ?? null;
  const scope = grid?.kind === "grid" ? grid.scope : null;
  const scopeKey = JSON.stringify(scope && "folder" in scope ? { folder: scope.folder } : scope);
  useEffect(() => {
    const media = lib.mediaFilter;
    lib.clearAllFilters();
    lib.setMediaFilter(media);
    if (!scope) return;
    if ("person" in scope) lib.setPeopleFilter({ person: scope.person });
    else if ("album" in scope) lib.setActiveAlbumId(scope.album);
    else if ("event" in scope) lib.setActiveEvent(scope.event);
    else if ("query" in scope) lib.setSearchQuery(scope.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);
  const folderHashes = useMemo(() => (scope && "folder" in scope ? new Set(scope.hashes) : null), [scope]);
  const photos = useMemo(
    () => (folderHashes ? lib.visiblePhotos.filter((p) => folderHashes.has(p.hash)) : lib.visiblePhotos),
    [lib.visiblePhotos, folderHashes]
  );
  const openGrid = (title: string, to: Scope) => push({ kind: "grid", title, scope: to });
  const showPerson = (name: string) => openGrid(name, { person: name });

  // Selection (long-press) is a screen too: back ends it
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = top?.kind === "select";
  useEffect(() => {
    if (!selecting) setSelected(new Set());
  }, [selecting]);
  const select = (next: Set<string>) => {
    if (!selecting && next.size > 0) push({ kind: "select" });
    if (selecting && next.size === 0) back();
    setSelected(next);
  };
  const haptic = () => {
    if (onAndroid) void callLocal("phone_haptic").catch(() => {});
    else navigator.vibrate?.(15);
  };

  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await lib.handleLoadFolderPath(lib.folder, openLibraryIsAll() ? null : openLibraryServer());
    } finally {
      setRefreshing(false);
    }
  };
  const backup = usePhoneBackup();

  // The viewer, with its details over it or not
  const details = top?.kind === "details";
  const viewer = details ? stack[stack.length - 2] : top;
  const viewerIndex = viewer?.kind === "viewer" ? photos.findIndex((p) => p.hash === viewer.hash) : -1;
  const openViewer = (index: number) => push({ kind: "viewer", hash: photos[index].hash });
  // The viewer's "Show in its folder": the phone's folder that holds this photo
  const showFolderOf = async (photo: PhotoItem) => {
    const folders = await callLocal<PhoneFolder[]>("phone_folders", { server: backup.settings?.server ?? null }).catch(() => []);
    const f = folders.find((x) => x.hashes.includes(photo.hash));
    if (f) openGrid(f.name, { folder: f.name, hashes: f.hashes });
  };
  // Smart search can't see into photos only on this phone (the server analyses what it has): say how many
  const notSearched = useMemo(() => {
    if (!onAndroid || !lib.smartSearch || !lib.searchQuery.trim() || !openLibraryIsAll()) return 0;
    const sources = allPhotosSources();
    const canBackUp = allPhotosCanBackUp();
    return lib.photos.filter((p) => whereabouts(p, sources, canBackUp) === "not-backed-up").length;
  }, [lib.smartSearch, lib.searchQuery, lib.photos]);

  if (!lib.folder) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col overflow-y-auto">
          <NoLibrary lib={lib} gridContainerRef={libraryRef} />
        </div>
      </Shell>
    );
  }

  // The screen under the overlays (viewer, selection, full-screen pages): a tab's first screen, a grid, the map
  const shown = [...stack].reverse().find((s) => s.kind === "grid" || s.kind === "map" || s.kind === "tab") ?? null;
  const showsGrid = shown === null || shown.kind === "grid";
  const title = shown?.kind === "grid" ? shown.title : shown?.kind === "map" ? "Places" : TABS.find((t) => t.id === tab)!.label;
  const person = scope && "person" in scope ? scope.person : null;
  const toCheck = person && canEdit ? (lib.pendingFaceCounts[person] ?? 0) : 0;

  return (
    <Shell>
      <header
        className="shrink-0 bg-panel/95 border-b border-zinc-800/80 px-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.25rem)" }}
      >
        {selected.size > 0 ? (
          <SelectionBar
            photos={photos}
            selected={selected}
            onClear={() => select(new Set())}
            onBackedUp={() => select(new Set())}
            onRemoved={() => {
              select(new Set());
              void refresh();
            }}
          />
        ) : (
          <div className="h-12 flex items-center gap-1">
            {shown && shown.kind !== "tab" ? (
              <button onClick={back} className="p-2 rounded-full text-zinc-300 active:bg-white/10" aria-label="Back">
                <ArrowLeft className="w-5 h-5" />
              </button>
            ) : (
              <img src={luminaMark} alt="" className="w-6 h-6 mx-2 object-contain" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[15px] font-semibold text-zinc-100 truncate">{title}</div>
              {showsGrid && (
                <div className="text-[11px] text-zinc-500">
                  {photos.length.toLocaleString()} {photos.length === 1 ? "item" : "items"}
                  {lib.isScanningFolder && photos.length > 0 ? " · updating" : offline.length > 0 ? ` · offline: ${offlineLabels} as last seen` : ""}
                </div>
              )}
            </div>
            {onAndroid ? <BackupRing onClick={() => push({ kind: "backup" })} /> : <WebUploadButton />}
            {onAndroid ? <SettingsButton onClick={() => push({ kind: "settings" })} /> : <AccountButton />}
          </div>
        )}
        {/* Kept while selecting: the grid must not move under the finger that just selected */}
        {showsGrid && <MediaChips lib={lib} />}
      </header>

      <Errors lib={lib} />

      <main className="relative flex-1 min-h-0 flex flex-col">
        {/* Floats over the bottom of the screen: the grid doesn't move when it comes and goes */}
        {onAndroid && <BackupBanner onOpen={() => push({ kind: "backup" })} onFinished={() => void refresh()} />}
        {showsGrid && toCheck > 0 && (
          <button
            onClick={() => push({ kind: "review", name: person! })}
            className="mx-2 mt-2 flex items-center gap-2 rounded-xl bg-emerald-950/70 border border-emerald-700/40 px-3 py-2.5 text-left text-sm text-emerald-100 active:bg-emerald-900/70"
          >
            <span className="flex-1">
              {toCheck} more {toCheck === 1 ? "face" : "faces"} might be {person}
            </span>
            <span className="font-semibold text-emerald-300">Check</span>
            <ChevronRight className="w-4 h-4 text-emerald-300" />
          </button>
        )}
        {showsGrid && lib.smartSearch && lib.searchQuery.trim() && offline.length > 0 && (
          <div className="mx-2 mt-2 rounded-xl bg-indigo-950/70 border border-indigo-700/40 px-3 py-2 text-xs text-indigo-200">
            Smart search needs a connection to {offlineLabels}.
          </div>
        )}
        {showsGrid && notSearched > 0 && offline.length === 0 && (
          <div className="mx-2 mt-2 rounded-xl bg-indigo-950/70 border border-indigo-700/40 px-3 py-2 text-xs text-indigo-200">
            {notSearched.toLocaleString()} photos only on this phone aren't searched by what's in them until they're backed up.
          </div>
        )}
        {showsGrid &&
          (photos.length === 0 ? (
            <Empty
              busy={lib.progress !== null || lib.isScanningFolder || !serversKnown}
              filtered={!!scope || lib.mediaFilter !== "ALL"}
              onClear={scope ? back : () => lib.setMediaFilter("ALL")}
            />
          ) : (
            <PhoneGrid
              // A new grid starts at its top, not where the last one was scrolled to
              key={scopeKey}
              photos={photos}
              byDate={!lib.semanticScores && lib.gridSortBy.startsWith("DATE")}
              columns={columns}
              onColumns={changeColumns}
              selected={selected}
              onSelect={select}
              onOpen={openViewer}
              uploading={backup.uploading}
              marks={openLibraryIsAll()}
              refreshing={refreshing}
              onRefresh={refresh}
              onLongPress={haptic}
            />
          ))}
        {shown?.kind === "map" && (
          <div className="flex-1 min-h-0 flex flex-col">
            <PhotoMap
              photos={lib.photos}
              onSelectPhoto={(hash) => {
                if (photos.some((p) => p.hash === hash)) push({ kind: "viewer", hash });
              }}
            />
          </div>
        )}
        {shown?.kind === "tab" && shown.tab === "search" && (
          <SearchScreen
            lib={lib}
            onSearch={(query) => openGrid(`“${query}”`, { query })}
            onPerson={showPerson}
            onPeople={() => screens.openTab("people")}
            onMap={() => push({ kind: "map" })}
            onGroups={() => push({ kind: "groups" })}
          />
        )}
        {shown?.kind === "tab" && shown.tab === "people" && (
          <PeopleScreen lib={lib} onPerson={showPerson} onReview={(name) => push({ kind: "review", name })} onGroups={() => push({ kind: "groups" })} />
        )}
        {shown?.kind === "tab" && shown.tab === "albums" && (
          <AlbumsScreen lib={lib} onOpen={openGrid} />
        )}
      </main>

      <nav
        className="shrink-0 flex bg-panel/95 border-t border-zinc-800/80"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => screens.openTab(id)}
            className={`flex-1 h-14 flex flex-col items-center justify-center gap-0.5 text-[11px] ${
              tab === id ? "text-emerald-400" : "text-zinc-500"
            }`}
            aria-current={tab === id ? "page" : undefined}
          >
            <Icon className="w-5 h-5" />
            {label}
          </button>
        ))}
      </nav>

      {viewerIndex >= 0 && (
        <PhoneViewer
          photos={photos}
          index={viewerIndex}
          onIndex={(i) => photos[i] && !details && screens.replaceTop({ kind: "viewer", hash: photos[i].hash })}
          onClose={back}
          info={details}
          onInfo={(open) => {
            if (open && !details) push({ kind: "details" });
            else if (!open && details) back();
          }}
          onPerson={showPerson}
          onShowFolder={onAndroid ? (photo) => void showFolderOf(photo) : undefined}
          people={lib.people}
          onFaces={(changed) => {
            lib.setPhotos((prev) => withFaces(prev, changed));
            void lib.refreshPeople();
          }}
        />
      )}
      {top?.kind === "review" && <ReviewPerson lib={lib} name={top.name} onBack={back} />}
      {top?.kind === "groups" && <UnnamedGroups lib={lib} onBack={back} />}
      {top?.kind === "backup" && <BackupScreen onBack={back} onRemoved={() => void refresh()} />}
      {top?.kind === "settings" && <SettingsScreen onBack={back} />}
      <ConfirmDialog />
    </Shell>
  );
}

// The header while photos are selected: share them, back up the ones only on this phone
function SelectionBar({
  photos,
  selected,
  onClear,
  onBackedUp,
  onRemoved,
}: {
  photos: PhotoItem[];
  selected: Set<string>;
  onClear: () => void;
  // The backup has them: the selection ends, the banner under the header shows how it goes
  onBackedUp: () => void;
  // They left the phone (they show from the server now)
  onRemoved: () => void;
}) {
  const backupServer = usePhoneBackup().settings?.server ?? null;
  const [busy, setBusy] = useState<"share" | "backup" | "save" | "remove" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const chosen = photos.filter((p) => selected.has(p.hash));
  const sources = openLibraryIsAll() ? allPhotosSources() : null;
  const canBackUp = allPhotosCanBackUp();
  const onlyHere = onAndroid && sources ? chosen.filter((p) => whereabouts(p, sources, canBackUp) === "not-backed-up") : [];
  const onlyServer = onAndroid && sources ? chosen.filter((p) => whereabouts(p, sources, canBackUp) === "server-only") : [];
  // On the phone and on a server: they can leave the phone (Free up space for these)
  const onBoth = onAndroid && sources && backupServer ? chosen.filter((p) => whereabouts(p, sources, canBackUp) === "both") : [];
  const run = async (what: "share" | "backup" | "save" | "remove") => {
    setBusy(what);
    setMessage(null);
    try {
      if (what === "share") await sharePhotos(chosen);
      else if (what === "remove") {
        const scan = await freeUpScan(backupServer!, onBoth.map((p) => p.hash));
        if (scan.count === 0) setMessage("None of these is backed up by this phone's backup yet");
        else if (await moveToTrash(scan)) onRemoved();
      } else if (what === "save") {
        setMessage(`Downloading ${onlyServer.length}…`);
        const n = await saveToPhone(onlyServer);
        setMessage(`Saved ${n} to this phone`);
      } else {
        await callLocal("phone_backup_selected", { hashes: onlyHere.map((p) => p.hash) });
        refreshBackup();
        onBackedUp();
      }
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="h-12 flex items-center gap-1">
      <button onClick={onClear} className="p-2 rounded-full text-zinc-300 active:bg-white/10" aria-label="Clear the selection">
        <X className="w-5 h-5" />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold text-zinc-100">{selected.size} selected</div>
        {message && <div className="text-[11px] text-zinc-400 truncate">{message}</div>}
      </div>
      {onAndroid && (
        <button onClick={() => run("share")} disabled={busy !== null} className="p-2.5 rounded-full text-zinc-200 active:bg-white/10" aria-label="Share">
          {busy === "share" ? <Loader2 className="w-5 h-5 animate-spin" /> : <Share2 className="w-5 h-5" />}
        </button>
      )}
      {onBoth.length > 0 && (
        <button onClick={() => run("remove")} disabled={busy !== null} className="p-2.5 rounded-full text-zinc-200 active:bg-white/10" aria-label="Remove from this phone">
          {busy === "remove" ? <Loader2 className="w-5 h-5 animate-spin" /> : <Trash2 className="w-5 h-5" />}
        </button>
      )}
      {onlyServer.length > 0 && (
        <button onClick={() => run("save")} disabled={busy !== null} className="p-2.5 rounded-full text-sky-300 active:bg-white/10" aria-label="Download to this phone">
          {busy === "save" ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
        </button>
      )}
      {onlyHere.length > 0 && (
        <button onClick={() => run("backup")} disabled={busy !== null} className="p-2.5 rounded-full text-amber-300 active:bg-white/10" aria-label="Back up">
          {busy === "backup" ? <Loader2 className="w-5 h-5 animate-spin" /> : <CloudUpload className="w-5 h-5" />}
        </button>
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="h-dvh flex flex-col bg-surface text-zinc-200 overflow-hidden">{children}</div>;
}

const MEDIA: { id: MediaFilter; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "PHOTOS", label: "Photos" },
  { id: "VIDEOS", label: "Videos" },
];

function MediaChips({ lib }: { lib: LibraryState }) {
  if (lib.videosCount === 0 && lib.mediaFilter === "ALL") return null;
  return (
    <div className="flex gap-1.5 pb-2 px-1">
      {MEDIA.map((m) => (
        <button
          key={m.id}
          onClick={() => lib.setMediaFilter(m.id)}
          className={`px-3 py-1 rounded-full text-xs border ${
            lib.mediaFilter === m.id ? "bg-emerald-600/20 border-emerald-500/50 text-emerald-200" : "bg-zinc-900 border-zinc-800 text-zinc-400"
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function Errors({ lib }: { lib: LibraryState }) {
  const errors = lib.toasts.filter((t) => t.kind === "error");
  if (errors.length === 0) return null;
  const last = errors[errors.length - 1];
  return (
    <div role="alert" className="mx-2 mt-2 px-3 py-2 rounded-xl bg-red-950/95 border border-red-500/50 text-red-200 text-xs flex items-start gap-2">
      <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-px" />
      <span className="flex-1 break-words">{last.message}</span>
      <button onClick={() => errors.forEach((t) => lib.dismissToast(t.id))} aria-label="Dismiss" className="text-red-300">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function Empty({ busy, filtered, onClear }: { busy: boolean; filtered: boolean; onClear: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center text-sm text-zinc-400">
      {busy ? (
        <>
          <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
          Loading the library…
        </>
      ) : filtered ? (
        <>
          Nothing matches.
          <button onClick={onClear} className="px-4 py-2 rounded-full bg-zinc-800 text-zinc-200 text-xs font-semibold">
            Show all photos
          </button>
        </>
      ) : (
        "This library has no photos yet."
      )}
    </div>
  );
}

// The phone app: who is signed in (the first letter of the name), opening Settings; a dot when an update is out
function SettingsButton({ onClick }: { onClick: () => void }) {
  const { servers } = useServers();
  const user = servers.find((s) => s.signed_in)?.user ?? "";
  const { update } = useUpdate();
  useEffect(() => {
    void checkForUpdate();
  }, []);
  return (
    <button onClick={onClick} className="relative p-1.5 rounded-full active:bg-white/10" aria-label="Settings">
      {update && <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-panel" />}
      <span className="w-8 h-8 rounded-full bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center">
        {user ? user[0].toUpperCase() : <UserRound className="w-4 h-4" />}
      </span>
    </button>
  );
}

// The web client: who is logged in, a way to the full layout, and Log out
function AccountButton() {
  const account = useAccount();
  const layout = usePhoneLayout();
  const [open, setOpen] = useState(false);
  if (!account) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} className="p-2.5 rounded-full text-zinc-300 active:bg-white/10" aria-label="Account">
        <UserRound className="w-5 h-5" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/60 flex flex-col justify-end" onClick={() => setOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="rounded-t-2xl bg-raised border-t border-zinc-700/80 px-4 pt-4 flex flex-col gap-1"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
          >
            <div className="px-1 pb-3">
              <div className="font-semibold text-zinc-100">{account.user.name}</div>
              <div className="text-xs text-zinc-500 capitalize">{account.user.role}</div>
            </div>
            <button onClick={() => layout.setPreferFull(true)} className="w-full px-3 py-3 rounded-xl text-left text-sm text-zinc-200 active:bg-white/10">
              Use the full layout
            </button>
            <button onClick={account.logout} className="w-full px-3 py-3 rounded-xl text-left text-sm text-red-300 active:bg-white/10">
              Log out
            </button>
          </div>
        </div>
      )}
    </>
  );
}
