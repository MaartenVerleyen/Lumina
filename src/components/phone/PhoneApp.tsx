import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, CloudUpload, Download, Images, Loader2, Search, Share2, SquareLibrary, UserRound, X } from "lucide-react";
import { ALL_PHOTOS, callLocal, onAndroid, openLibraryIsAll, openLibraryServer, allPhotosCanBackUp, allPhotosSources } from "../../api";
import { whereabouts } from "../../api/allPhotos";
import { refreshServers, useServers } from "../../hooks/useServers";
import { useLibraryState, type LibraryState } from "../../hooks/useLibraryState";
import { describePeopleExpr } from "../../utils/peopleQuery";
import type { MediaFilter, PhotoItem } from "../../types/lumina";
import { useAccount } from "../auth/ServerGate";
import { usePhoneLayout } from "../../app/usePhoneLayout";
import ConfirmDialog from "../modals/ConfirmDialog";
import { NoLibrary } from "../views/EmptyStates";
import { WebUploadButton } from "../servers/WebUpload";
import AlbumsScreen from "./AlbumsScreen";
import BackupScreen, { BackupBanner, BackupRing } from "./BackupScreen";
import SettingsScreen from "./SettingsScreen";
import SearchScreen from "./SearchScreen";
import type { PhoneFolder } from "./usePhoneFolders";
import PhoneGrid, { COLUMN_STEPS } from "./PhoneGrid";
import { saveToPhone, sharePhotos } from "./share";
import { refreshBackup, usePhoneBackup } from "./usePhoneBackup";
import PhoneViewer from "./PhoneViewer";
import luminaMark from "../../assets/lumina-mark.svg";

type Tab = "photos" | "search" | "albums";

const TABS: { id: Tab; label: string; icon: typeof Images }[] = [
  { id: "photos", label: "Photos", icon: Images },
  { id: "search", label: "Search", icon: Search },
  { id: "albums", label: "Albums", icon: SquareLibrary },
];

// The phone app's pages over the tabs: Backup (the header's backup button) and Settings (its account button)
type PageId = "backup" | "settings";

// The phone layout (docs/plans/android-app-ui.md): the phone app's screens, and the web client's on a phone.
// It shares the library state with the full layout (useLibraryState).
export default function PhoneApp() {
  const lib = useLibraryState();
  const [tab, setTab] = useState<Tab>("photos");
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  // A folder of the phone opened from Albums: the grid shows its photos
  const [phoneFolder, setPhoneFolder] = useState<{ name: string; hashes: Set<string> } | null>(null);
  const libraryRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PageId | null>(null);
  const openPage = (id: PageId) => {
    history.pushState({ luminaPage: id }, "");
    setPage(id);
  };
  const closePage = () => {
    if (history.state?.luminaPage) history.back();
    else setPage(null);
  };

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
    // The folder may already say All photos (remembered from the last run) without its photos loaded
    if (lib.folder !== ALL_PHOTOS || lib.photos.length === 0) void lib.handleLoadFolderPath(ALL_PHOTOS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

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

  // Selection (long-press); the back gesture ends it
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const select = (next: Set<string>) => {
    if (selected.size === 0 && next.size > 0) history.pushState({ luminaSelect: true }, "");
    if (selected.size > 0 && next.size === 0 && history.state?.luminaSelect) history.back();
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
  const viewerOpen = useRef(false);
  viewerOpen.current = viewerIndex !== null;
  const pageOpen = useRef(false);
  pageOpen.current = page !== null;

  // The phone's back button (or swipe) closes the viewer, or ends a selection, instead of leaving the page
  useEffect(() => {
    const onPop = () => {
      if (pageOpen.current) setPage(null);
      else if (viewerOpen.current) setViewerIndex(null);
      else setSelected(new Set());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const openViewer = (index: number) => {
    if (viewerIndex === null) history.pushState({ luminaViewer: true }, "");
    setViewerIndex(index);
  };
  const closeViewer = () => {
    if (history.state?.luminaViewer) history.back();
    else setViewerIndex(null);
  };

  const photos = useMemo(
    () => (phoneFolder ? lib.visiblePhotos.filter((p) => phoneFolder.hashes.has(p.hash)) : lib.visiblePhotos),
    [lib.visiblePhotos, phoneFolder]
  );
  const scope = phoneFolder?.name ?? scopeOf(lib);
  const clearScope = () => {
    setPhoneFolder(null);
    lib.clearAllFilters();
  };
  const showPerson = (name: string) => {
    clearScope();
    lib.setPeopleFilter({ person: name });
    setTab("photos");
  };
  const openFolder = (f: Pick<PhoneFolder, "name" | "hashes">) => {
    lib.clearAllFilters();
    setPhoneFolder({ name: f.name, hashes: new Set(f.hashes) });
    setTab("photos");
  };
  // The viewer's "Show in its folder": the phone's folder that holds this photo
  const showFolderOf = async (photo: PhotoItem) => {
    const folders = await callLocal<PhoneFolder[]>("phone_folders", { server: backup.settings?.server ?? null }).catch(() => []);
    const f = folders.find((x) => x.hashes.includes(photo.hash));
    if (!f) return;
    closeViewer();
    openFolder(f);
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

  return (
    <Shell>
      <header
        className="shrink-0 bg-panel/95 border-b border-zinc-800/80 px-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.25rem)" }}
      >
        {selected.size > 0 ? (
          <SelectionBar photos={photos} selected={selected} onClear={() => select(new Set())} onBackedUp={() => select(new Set())} />
        ) : (
          <div className="h-12 flex items-center gap-1">
            {scope && tab === "photos" ? (
              <button
                onClick={clearScope}
                className="p-2 rounded-full text-zinc-300 active:bg-white/10"
                aria-label="Show all photos"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            ) : (
              <img src={luminaMark} alt="" className="w-6 h-6 mx-2 object-contain" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[15px] font-semibold text-zinc-100 truncate">{(tab === "photos" && scope) || TABS.find((t) => t.id === tab)!.label}</div>
              {tab === "photos" && (
                <div className="text-[11px] text-zinc-500">
                  {photos.length} {photos.length === 1 ? "item" : "items"}
                </div>
              )}
            </div>
            {onAndroid ? <BackupRing onClick={() => openPage("backup")} /> : <WebUploadButton />}
            {onAndroid ? <SettingsButton onClick={() => openPage("settings")} /> : <AccountButton />}
          </div>
        )}
        {/* Kept while selecting: the grid must not move under the finger that just selected */}
        {tab === "photos" && <MediaChips lib={lib} />}
      </header>

      <Errors lib={lib} />

      <main className="relative flex-1 min-h-0 flex flex-col">
        {/* Floats over the bottom of the screen: the grid doesn't move when it comes and goes */}
        {onAndroid && <BackupBanner onOpen={() => openPage("backup")} onFinished={() => void refresh()} />}
        {tab === "photos" && notSearched > 0 && (
          <div className="mx-2 mt-2 rounded-xl bg-indigo-950/70 border border-indigo-700/40 px-3 py-2 text-xs text-indigo-200">
            {notSearched.toLocaleString()} photos only on this phone aren't searched by what's in them until they're backed up.
          </div>
        )}
        {tab === "photos" &&
          (photos.length === 0 ? (
            <Empty busy={lib.progress !== null || lib.isScanningFolder || !serversKnown} filtered={!!scope || lib.mediaFilter !== "ALL"} onClear={lib.clearAllFilters} />
          ) : (
            <PhoneGrid
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
        {tab === "search" && (
          <SearchScreen
            lib={lib}
            onSearch={() => {
              setPhoneFolder(null);
              setTab("photos");
            }}
            onOpenPhoto={(hash) => {
              const i = photos.findIndex((p) => p.hash === hash);
              if (i >= 0) {
                setTab("photos");
                openViewer(i);
              }
            }}
          />
        )}
        {tab === "albums" && (
          <AlbumsScreen
            lib={lib}
            onOpened={() => {
              setPhoneFolder(null);
              setTab("photos");
            }}
            onOpenFolder={openFolder}
          />
        )}

      </main>

      <nav
        className="shrink-0 flex bg-panel/95 border-t border-zinc-800/80"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
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

      {viewerIndex !== null && photos[viewerIndex] && (
        <PhoneViewer
          photos={photos}
          index={viewerIndex}
          onIndex={setViewerIndex}
          onClose={closeViewer}
          onPerson={(name) => {
            closeViewer();
            showPerson(name);
          }}
          onShowFolder={onAndroid ? (photo) => void showFolderOf(photo) : undefined}
        />
      )}
      {page === "backup" && <BackupScreen onBack={closePage} />}
      {page === "settings" && <SettingsScreen onBack={closePage} />}
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
}: {
  photos: PhotoItem[];
  selected: Set<string>;
  onClear: () => void;
  // The backup has them: the selection ends, the banner under the header shows how it goes
  onBackedUp: () => void;
}) {
  const [busy, setBusy] = useState<"share" | "backup" | "save" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const chosen = photos.filter((p) => selected.has(p.hash));
  const sources = openLibraryIsAll() ? allPhotosSources() : null;
  const canBackUp = allPhotosCanBackUp();
  const onlyHere = onAndroid && sources ? chosen.filter((p) => whereabouts(p, sources, canBackUp) === "not-backed-up") : [];
  const onlyServer = onAndroid && sources ? chosen.filter((p) => whereabouts(p, sources, canBackUp) === "server-only") : [];
  const run = async (what: "share" | "backup" | "save") => {
    setBusy(what);
    setMessage(null);
    try {
      if (what === "share") await sharePhotos(chosen);
      else if (what === "save") {
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

// What the photos are narrowed to, as a title ("Anna", "Summer 2024", "beach"); null for everything
function scopeOf(lib: LibraryState): string | null {
  if (lib.peopleFilter) return describePeopleExpr(lib.peopleFilter);
  if (lib.activeAlbumId !== null) return lib.albums.find((a) => a.id === lib.activeAlbumId)?.name ?? "Album";
  if (lib.activeEvent !== "ALL") return lib.autoEvents.find((e) => e.id === lib.activeEvent)?.label ?? "Trip";
  if (lib.searchQuery.trim()) return `“${lib.searchQuery.trim()}”`;
  return null;
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

// The phone app: who is signed in (the first letter of the name), opening Settings
function SettingsButton({ onClick }: { onClick: () => void }) {
  const { servers } = useServers();
  const user = servers.find((s) => s.signed_in)?.user ?? "";
  return (
    <button onClick={onClick} className="p-1.5 rounded-full active:bg-white/10" aria-label="Settings">
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
