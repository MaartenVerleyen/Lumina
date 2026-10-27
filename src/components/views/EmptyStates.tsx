import type { RefObject } from "react";
import { Clock, FolderInput, FolderOpen, Search } from "lucide-react";
import type { LibraryState } from "../../hooks/useLibraryState";

type GridRef = RefObject<HTMLDivElement | null>;

// No library open yet: open a folder (or drop one on the window), or pick a recent one
export function NoLibrary({ lib, gridContainerRef }: { lib: LibraryState; gridContainerRef: GridRef }) {
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
