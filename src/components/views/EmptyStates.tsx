import { useEffect, useState, type RefObject } from "react";
import { Clock, FolderInput, FolderOpen, Images, Loader2, Search, Server, X } from "lucide-react";
import type { LibraryState } from "../../hooks/useLibraryState";
import { call, inDesktopApp, onAndroid, rememberLibraryRoles, subscribe, type Role } from "../../api";
import { useAccount } from "../auth/ServerGate";
import { ConnectServerForm, ServerLibraryList } from "../servers/Servers";
import { platform } from "../../api/platform";
import { useServers } from "../../hooks/useServers";
import { plural } from "../../utils/plural";
import { useLocalLibraries } from "../../hooks/useLocalLibraries";
import { dropRecent, renameRecent, sameFolder } from "../../utils/recentFolders";

type GridRef = RefObject<HTMLDivElement | null>;

interface ServerLibrary {
  root: string;
  name: string;
  photos: number;
  // This user's role on it ("guest": only what is shared with them)
  role?: Role;
}

// In the web client: the server's libraries, where the desktop picks a folder. With just one it opens it.
function ServerLibraries({ lib, gridContainerRef }: { lib: LibraryState; gridContainerRef: GridRef }) {
  const [libraries, setLibraries] = useState<ServerLibrary[] | null>(null);
  const account = useAccount();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let shown: ServerLibrary[] | null = null;
    const load = () =>
      call<ServerLibrary[]>("list_libraries")
        .then((list) => {
          rememberLibraryRoles(list);
          // Opens the only library at first, or once one appears where there was none (shared just now)
          if (list.length === 1 && (shown === null || shown.length === 0)) lib.handleLoadFolderPath(list[0].root);
          shown = list;
          setLibraries(list);
        })
        .catch((e) => setError(String(e)));
    load();
    // Someone shared an album with this user (or stopped), or changed their role
    const myName = account?.user.name.toLowerCase();
    const offs = ["shares-changed", "roles-changed"].map((name) =>
      subscribe<{ users?: string[] }>(name, (e) => {
        if ((e.payload.users ?? []).some((u) => u.toLowerCase() === myName)) load();
      })
    );
    return () => {
      for (const off of offs) off.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={gridContainerRef} className="flex-1 overflow-y-auto p-6 flex items-center justify-center">
      <div className="max-w-xl w-full rounded-2xl border border-zinc-800 bg-panel/90 p-8 flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-4">
          <Images className="w-7 h-7 text-emerald-400" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-100">Photo libraries on this server</h2>
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        {libraries?.length === 0 && (
          <p className="text-xs text-zinc-400 mt-2">
            {account?.user.role === "guest" ? "Nothing is shared with you yet." : "The server has no libraries yet."}
          </p>
        )}
        <div className="w-full mt-5 flex flex-col gap-1.5">
          {libraries?.map((l) => (
            <button
              key={l.root}
              onClick={() => lib.handleLoadFolderPath(l.root)}
              className="w-full px-3 py-2.5 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 text-sm text-zinc-200 hover:text-white flex items-center justify-between transition"
            >
              <span className="truncate font-semibold">{l.name || l.root}</span>
              <span className="text-[11px] text-zinc-500 ml-2 shrink-0">
                {l.photos} photo{l.photos === 1 ? "" : "s"} · <span className="text-emerald-400 font-semibold">Open →</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// No library open yet: open a folder (or drop one on the window), or pick a recent one
export function NoLibrary({ lib, gridContainerRef }: { lib: LibraryState; gridContainerRef: GridRef }) {
  // A library's list is on its way: not the start screen, which would look as if nothing opened
  if (lib.libraryLoading) {
    return (
      <div ref={gridContainerRef} className="flex-1 flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
          Loading {lib.libraryLoading}…
        </div>
      </div>
    );
  }
  // The web client lists its server's libraries; the desktop app (also with a server's library open) offers
  // folders on this PC and the libraries of every server it is connected to
  if (!inDesktopApp) return <ServerLibraries lib={lib} gridContainerRef={gridContainerRef} />;
  return <DesktopStart lib={lib} gridContainerRef={gridContainerRef} />;
}

// The desktop app with nothing open: a folder on this PC (the full app), or a library on a Lumina server
function DesktopStart({ lib, gridContainerRef }: { lib: LibraryState; gridContainerRef: GridRef }) {
  // This PC's libraries: which recent folders are still there, and how many photos they hold
  const local = useLocalLibraries(lib.setError);
  useEffect(() => {
    if (inDesktopApp) void local.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { servers } = useServers();
  const [connecting, setConnecting] = useState(false);
  return (
    <div
      ref={gridContainerRef}
      className="flex-1 overflow-y-auto p-6 flex items-center justify-center"
    >
      <div className="max-w-xl w-full rounded-2xl border-2 border-dashed border-zinc-800 bg-panel/90 hover:border-emerald-500/40 p-8 flex flex-col items-center text-center transition">
        <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-4">
          <FolderOpen className="w-7 h-7 text-emerald-400" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-100">
          Welcome to Lumina
        </h2>
        {!platform.fullApp && (
          <p className="text-xs text-zinc-400 mt-1 max-w-md leading-relaxed">
            {onAndroid
              ? "Lumina on your phone shows the photo libraries of your Lumina server. Connect to it below."
              : "On a Mac, Lumina works with the photo libraries on a Lumina server for now. Connect to one below."}
          </p>
        )}
        {platform.fullApp && (
        <>
        <p className="text-xs text-zinc-400 mt-1 max-w-md leading-relaxed">
          Drop a folder of photos and videos on this window, or choose one below. Lumina reads JPEG, PNG,
          WebP, HEIC, camera RAW (CR2, CR3, NEF, ARW, DNG) and videos (MP4, MOV), and never changes the files.
        </p>

        <div className="mt-5 flex items-center gap-2">
          <button
            onClick={lib.handleOpenFolder}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold shadow-lg transition flex items-center gap-2 cursor-pointer"
          >
            <FolderOpen className="w-4 h-4" />
            <span>Choose a photo folder…</span>
          </button>
          <button
            onClick={() => lib.openImport()}
            className="px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-xl text-xs font-semibold transition flex items-center gap-2 cursor-pointer"
          >
            <FolderInput className="w-4 h-4 text-emerald-400" />
            <span>Import from a card…</span>
          </button>
        </div>

        {lib.recentFolders.length > 0 && (
          <div className="w-full mt-6 pt-5 border-t border-zinc-800/80 flex flex-col gap-2 text-left">
            <span className="text-xs font-medium text-zinc-500 flex items-center gap-1.5">
              <Clock className="w-3 h-3 text-emerald-400" />
              Recent libraries
            </span>
            <div className="flex flex-col gap-1.5">
              {lib.recentFolders.map((rf) => {
                // A folder that is gone (renamed, moved, a drive not connected) says so and can be located
                const known = local.libraries?.find((l) => sameFolder(l.root, rf));
                return (
                  <div key={rf} className="group flex items-center gap-1">
                    <button
                      onClick={() => lib.handleLoadFolderPath(rf)}
                      disabled={known?.missing}
                      className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 disabled:hover:bg-zinc-900/80 border border-zinc-800 text-xs text-zinc-300 hover:text-white disabled:text-zinc-500 flex items-center justify-between transition"
                      title={known?.missing ? "Folder not found: renamed or moved? Use Locate… to show Lumina where it is now" : rf}
                    >
                      <span className="truncate font-mono text-[11px]">
                        {known?.missing && <span className="font-sans text-amber-300/80">Folder not found · </span>}
                        {rf}
                      </span>
                      {!known?.missing && (
                        <span className="text-[11px] text-emerald-400 font-semibold ml-2 shrink-0">
                          {known ? `${known.photos.toLocaleString()} · ` : ""}Open →
                        </span>
                      )}
                    </button>
                    {known?.missing && (
                      <button
                        onClick={async () => {
                          const picked = await local.locate(rf);
                          if (!picked) return;
                          lib.updateRecentFolders((r) => renameRecent(r, rf, picked));
                          void lib.handleLoadFolderPath(picked);
                        }}
                        className="shrink-0 px-2 py-2 rounded-lg text-[11px] text-amber-200 hover:bg-zinc-800"
                        title="Show Lumina where the folder is now; ratings, tags and names are kept"
                      >
                        Locate…
                      </button>
                    )}
                    <button
                      onClick={() => lib.updateRecentFolders((r) => dropRecent(r, rf))}
                      className="shrink-0 p-2 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 focus:opacity-100"
                      title="Take off this list (Lumina keeps the library; Forget is in the Library menu)"
                      aria-label={`Take ${rf} off the recent list`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        </>
        )}

        {/* Client mode: libraries of the Lumina servers this app is connected to */}
        <div className="w-full mt-6 pt-5 border-t border-zinc-800/80 flex flex-col gap-3 text-left">
          <ServerLibraryList onOpen={(root, server) => lib.handleLoadFolderPath(root, server)} />
          {connecting ? (
            <ConnectServerForm onDone={() => setConnecting(false)} />
          ) : (
            <button
              onClick={() => setConnecting(true)}
              className="self-start px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-300 hover:text-white flex items-center gap-1.5 transition"
            >
              <Server className="w-3.5 h-3.5 text-emerald-400" />
              {servers.length === 0 ? "Connect to a Lumina server…" : "Connect to another server…"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// The library has photos but the filters hide all of them
export function NoMatches({ lib, gridContainerRef }: { lib: LibraryState; gridContainerRef: GridRef }) {
  return (
    <div
      ref={gridContainerRef}
      className="flex-1 overflow-y-auto p-6 flex items-center justify-center"
    >
      <div className="max-w-sm text-center flex flex-col items-center gap-2 text-xs text-zinc-400">
        <Search className="w-8 h-8 text-zinc-600" />
        <span className="text-sm font-semibold text-zinc-200">No photos match these filters</span>
        <span>
          {plural(lib.photos.length, "photo")} are in this library, but the current search, filter, folder, person or
          date range hides all of them.
        </span>
        <button
          onClick={lib.clearAllFilters}
          className="mt-2 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
        >
          Clear all filters
        </button>
      </div>
    </div>
  );
}
