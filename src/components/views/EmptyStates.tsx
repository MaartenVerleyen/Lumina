import { useEffect, useState, type RefObject } from "react";
import { Clock, FolderInput, FolderOpen, Images, Search, Server } from "lucide-react";
import type { LibraryState } from "../../hooks/useLibraryState";
import { call, inDesktopApp, onAndroid, rememberLibraryRoles, subscribe, type Role } from "../../api";
import { useAccount } from "../auth/ServerGate";
import { ConnectServerForm, ServerLibraryList } from "../servers/Servers";
import { platform } from "../../api/platform";
import { useServers } from "../../hooks/useServers";

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
        <h2 className="text-lg font-bold text-zinc-100">Photo libraries on this server</h2>
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
  // The web client lists its server's libraries; the desktop app (also with a server's library open) offers
  // folders on this PC and the libraries of every server it is connected to
  if (!inDesktopApp) return <ServerLibraries lib={lib} gridContainerRef={gridContainerRef} />;
  return <DesktopStart lib={lib} gridContainerRef={gridContainerRef} />;
}

// The desktop app with nothing open: a folder on this PC (the full app), or a library on a Lumina server
function DesktopStart({ lib, gridContainerRef }: { lib: LibraryState; gridContainerRef: GridRef }) {
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
        <h2 className="text-lg font-bold text-zinc-100">
          Welcome to Lumina Photo Studio
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
          Drag and drop any photo folder onto this window, or click below to open your
          collection. Supports JPEG, PNG, WebP, HEIC, and Camera RAW (.CR2, .CR3, .NEF,
          .ARW, .DNG).
        </p>

        <div className="mt-5 flex items-center gap-2">
          <button
            onClick={lib.handleOpenFolder}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold shadow-lg transition flex items-center gap-2 cursor-pointer"
          >
            <FolderOpen className="w-4 h-4" />
            <span>Choose Photo Folder...</span>
          </button>
          <button
            onClick={() => lib.openImport()}
            className="px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-xl text-xs font-semibold transition flex items-center gap-2 cursor-pointer"
          >
            <FolderInput className="w-4 h-4 text-emerald-400" />
            <span>Import from a card...</span>
          </button>
        </div>

        {lib.recentFolders.length > 0 && (
          <div className="w-full mt-6 pt-5 border-t border-zinc-800/80 flex flex-col gap-2 text-left">
            <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3 h-3 text-emerald-400" />
              Recent Photo Libraries
            </span>
            <div className="flex flex-col gap-1.5">
              {lib.recentFolders.map((rf) => (
                <button
                  key={rf}
                  onClick={() => lib.handleLoadFolderPath(rf)}
                  className="w-full px-3 py-2 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-300 hover:text-white flex items-center justify-between transition truncate"
                >
                  <span className="truncate font-mono text-[11px]">{rf}</span>
                  <span className="text-[11px] text-emerald-400 font-semibold ml-2 shrink-0">
                    Open →
                  </span>
                </button>
              ))}
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
        <span className="text-sm font-bold text-zinc-200">No photos match these filters</span>
        <span>
          {lib.photos.length} photo(s) are in this library, but the current search, filter, folder, person or
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
