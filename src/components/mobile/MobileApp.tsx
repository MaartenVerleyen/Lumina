import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Images, Loader2, Map as MapIcon, Search, Sparkles, SquareLibrary, UserRound, Users, X } from "lucide-react";
import { ALL_PHOTOS, mediaUrl, onAndroid } from "../../api";
import { refreshServers, useServers } from "../../hooks/useServers";
import { useLibraryState, type LibraryState } from "../../hooks/useLibraryState";
import { describePeopleExpr } from "../../utils/peopleQuery";
import type { MediaFilter } from "../../types/lumina";
import { useAccount } from "../auth/ServerGate";
import { usePhoneLayout } from "../../app/usePhoneLayout";
import ConfirmDialog from "../modals/ConfirmDialog";
import PhotoMap from "../views/PhotoMap";
import { NoLibrary } from "../views/EmptyStates";
import { WebUploadButton } from "../servers/WebUpload";
import { BackupButton } from "./BackupSheet";
import MobileGrid from "./MobileGrid";
import MobileViewer from "./MobileViewer";
import luminaMark from "../../assets/lumina-mark.svg";

type Tab = "photos" | "people" | "albums" | "map";

const TABS: { id: Tab; label: string; icon: typeof Images }[] = [
  { id: "photos", label: "Photos", icon: Images },
  { id: "people", label: "People", icon: Users },
  { id: "albums", label: "Albums", icon: SquareLibrary },
  { id: "map", label: "Map", icon: MapIcon },
];

// The web client on a phone: browse, search and look, with one thing on screen at a time. It shares the
// library state with the full layout (useLibraryState); editing comes with the editor role (milestone 3).
export default function MobileApp() {
  const lib = useLibraryState();
  const [tab, setTab] = useState<Tab>("photos");
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const libraryRef = useRef<HTMLDivElement>(null);

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

  // The phone's back button (or swipe) closes the viewer instead of leaving the page
  useEffect(() => {
    const onPop = () => setViewerIndex(null);
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

  const photos = lib.visiblePhotos;
  const scope = scopeOf(lib);
  const showPerson = (name: string) => {
    lib.clearAllFilters();
    lib.setPeopleFilter({ person: name });
    setTab("photos");
  };

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
        {searching ? (
          <SearchBar lib={lib} onDone={() => setSearching(false)} />
        ) : (
          <div className="h-12 flex items-center gap-1">
            {scope ? (
              <button
                onClick={lib.clearAllFilters}
                className="p-2 rounded-full text-zinc-300 active:bg-white/10"
                aria-label="Show all photos"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            ) : (
              <img src={luminaMark} alt="" className="w-6 h-6 mx-2 object-contain" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[15px] font-semibold text-zinc-100 truncate">{scope ?? TABS.find((t) => t.id === tab)!.label}</div>
              {tab === "photos" && (
                <div className="text-[11px] text-zinc-500">
                  {photos.length} {photos.length === 1 ? "item" : "items"}
                </div>
              )}
            </div>
            <button onClick={() => setSearching(true)} className="p-2.5 rounded-full text-zinc-300 active:bg-white/10" aria-label="Search">
              <Search className="w-5 h-5" />
            </button>
            {onAndroid ? <BackupButton /> : <WebUploadButton />}
            <AccountButton />
          </div>
        )}
        {tab === "photos" && !searching && <MediaChips lib={lib} />}
      </header>

      <Errors lib={lib} />

      <main className="flex-1 min-h-0 flex flex-col">
        {tab === "photos" &&
          (photos.length === 0 ? (
            <Empty busy={lib.progress !== null || lib.isScanningFolder || !serversKnown} filtered={!!scope || lib.mediaFilter !== "ALL"} onClear={lib.clearAllFilters} />
          ) : (
            <MobileGrid
              photos={photos}
              byMonth={!lib.semanticScores && lib.gridSortBy.startsWith("DATE")}
              onOpen={openViewer}
            />
          ))}
        {tab === "people" && <PeopleTab lib={lib} onPerson={showPerson} />}
        {tab === "albums" && <AlbumsTab lib={lib} onOpened={() => setTab("photos")} />}
        {tab === "map" && (
          <div className="flex-1 min-h-0 flex flex-col">
            <PhotoMap
              photos={photos}
              onSelectPhoto={(hash) => {
                const i = photos.findIndex((p) => p.hash === hash);
                if (i >= 0) openViewer(i);
              }}
            />
          </div>
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
        <MobileViewer
          photos={photos}
          index={viewerIndex}
          onIndex={setViewerIndex}
          onClose={closeViewer}
          onPerson={(name) => {
            closeViewer();
            showPerson(name);
          }}
        />
      )}
      <ConfirmDialog />
    </Shell>
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

function SearchBar({ lib, onDone }: { lib: LibraryState; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <form
      className="h-12 flex items-center gap-1.5 min-w-0"
      onSubmit={(e) => {
        e.preventDefault();
        input.current?.blur();
        onDone();
      }}
    >
      <div className={`flex-1 flex items-center gap-2 h-9 rounded-full px-3 border ${lib.smartSearch ? "border-indigo-500/60" : "border-zinc-700"} bg-zinc-900`}>
        <Search className="w-4 h-4 text-zinc-500 shrink-0" />
        <input
          ref={input}
          type="search"
          enterKeyHint="search"
          value={lib.searchQuery}
          onChange={(e) => lib.setSearchQuery(e.target.value)}
          placeholder={lib.smartSearch ? "Describe a photo" : "Names, places, tags"}
          className="flex-1 min-w-0 bg-transparent text-base text-zinc-100 placeholder-zinc-500 outline-none"
        />
        {lib.searchQuery && (
          <button type="button" onClick={() => lib.setSearchQuery("")} className="text-zinc-500" aria-label="Clear search">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={lib.toggleSmartSearch}
        aria-pressed={lib.smartSearch}
        aria-label="Smart search"
        title="Smart search: describe the photo"
        className={`h-9 w-9 shrink-0 rounded-full flex items-center justify-center border ${
          lib.smartSearch ? "bg-indigo-600 border-indigo-500 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-300"
        }`}
      >
        <Sparkles className="w-4 h-4" />
      </button>
      <button type="submit" className="h-9 shrink-0 pl-1 pr-2 text-sm text-emerald-400 font-semibold">
        Done
      </button>
    </form>
  );
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

function PeopleTab({ lib, onPerson }: { lib: LibraryState; onPerson: (name: string) => void }) {
  const people = useMemo(
    () => lib.people.filter((p) => !p.hidden && p.photo_count > 0).sort((a, b) => Number(b.starred) - Number(a.starred) || b.photo_count - a.photo_count),
    [lib.people]
  );
  if (people.length === 0) {
    return <div className="flex-1 flex items-center justify-center p-8 text-center text-sm text-zinc-400">No named people yet.</div>;
  }
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain p-3">
      <div className="grid grid-cols-3 min-[520px]:grid-cols-5 gap-x-2 gap-y-4">
        {people.map((p) => (
          <button key={p.id} onClick={() => onPerson(p.name)} className="flex flex-col items-center gap-1.5 active:opacity-70">
            <div className="w-full aspect-square rounded-full overflow-hidden bg-zinc-800 border border-zinc-700/60">
              {p.cover_thumb ? (
                <img src={mediaUrl({ kind: "face", path: p.cover_thumb })} alt="" loading="lazy" className="w-full h-full object-cover" />
              ) : (
                <UserRound className="w-1/2 h-1/2 m-auto mt-[25%] text-zinc-600" />
              )}
            </div>
            <div className="text-xs text-zinc-200 font-medium truncate max-w-full">{p.name}</div>
            <div className="text-[10px] text-zinc-500 -mt-1">{p.photo_count}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function AlbumsTab({ lib, onOpened }: { lib: LibraryState; onOpened: () => void }) {
  const albums = lib.albums.filter((a) => (lib.albumCounts.get(a.id) ?? 0) > 0);
  const trips = lib.autoEvents;
  if (albums.length === 0 && trips.length === 0) {
    return <div className="flex-1 flex items-center justify-center p-8 text-center text-sm text-zinc-400">No albums or trips yet.</div>;
  }
  const row = (key: string | number, label: string, count: number, open: () => void) => (
    <button
      key={key}
      onClick={() => {
        lib.clearAllFilters();
        open();
        onOpened();
      }}
      className="w-full px-4 py-3 flex items-center justify-between text-left border-b border-zinc-800/70 active:bg-white/5"
    >
      <span className="text-sm text-zinc-100 truncate">{label}</span>
      <span className="text-xs text-zinc-500 ml-3 shrink-0">{count}</span>
    </button>
  );
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain pb-4">
      {albums.length > 0 && (
        <>
          <h2 className="px-4 pt-4 pb-1 text-[11px] uppercase tracking-wider text-zinc-500">Albums</h2>
          {albums.map((a) => row(a.id, a.name, lib.albumCounts.get(a.id) ?? 0, () => lib.setActiveAlbumId(a.id)))}
        </>
      )}
      {trips.length > 0 && (
        <>
          <h2 className="px-4 pt-5 pb-1 text-[11px] uppercase tracking-wider text-zinc-500">Trips and events</h2>
          {trips.map((t) => row(t.id, t.label, t.count, () => lib.setActiveEvent(t.id)))}
        </>
      )}
    </div>
  );
}

// Who is logged in, a way to the full layout, and Log out
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
