import { Sparkles, X } from "lucide-react";
import { useAccess } from "../auth/ServerGate";
import { describePeopleExpr, peopleInExpr } from "../../utils/peopleQuery";
import { describeTerm, removeTerm } from "../../utils/searchQuery";
import { removeUnderstood } from "../../utils/naturalQuery";
import type { LibraryState } from "../../hooks/useLibraryState";

// The chips under the toolbar for every active filter (last import, trip, person, tag, album, search terms), each with ✕
export default function FilterBar({
  lib,
  saveSearchName,
  setSaveSearchName,
}: {
  lib: LibraryState;
  saveSearchName: string | null;
  setSaveSearchName: (name: string | null) => void;
}) {
  const access = useAccess();
  return (
    <>
      {(lib.parsedSearch.terms.length > 0 ||
        lib.activeAlbumId !== null ||
        lib.activeEvent !== "ALL" ||
        lib.peopleFilter !== null ||
        lib.activeTag !== "ALL" ||
        lib.hashFilter !== null) && (
        <div className="bg-panel border-b border-zinc-800/60 px-4 py-1.5 flex items-center gap-1.5 flex-wrap shrink-0 text-xs">
          {lib.hashFilter !== null && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-200">
              {lib.hashFilter.label} ({lib.hashFilter.hashes.size})
              <button onClick={() => lib.setHashFilter(null)} className="hover:text-white" aria-label="Show all photos">
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          {lib.activeEvent !== "ALL" && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/15 border border-sky-500/40 text-sky-200">
              {lib.autoEvents.find((ev) => ev.id === lib.activeEvent)?.label ?? "Trip"}
              <button onClick={() => lib.setActiveEvent("ALL")} className="hover:text-white" aria-label="Leave trip">
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          {lib.peopleFilter !== null && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-200">
              {peopleInExpr(lib.peopleFilter).length > 1 ? "People" : "Person"}: {describePeopleExpr(lib.peopleFilter)}
              <button onClick={() => lib.setPeopleFilter(null)} className="hover:text-white" aria-label="Show everyone">
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          {lib.activeTag !== "ALL" && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/15 border border-indigo-500/40 text-indigo-200">
              Tag: #{lib.activeTag}
              <button onClick={() => lib.setActiveTag("ALL")} className="hover:text-white" aria-label="Clear tag">
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          {lib.activeAlbumId !== null && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/15 border border-indigo-500/40 text-indigo-200">
              Album: {lib.albums.find((a) => a.id === lib.activeAlbumId)?.name ?? "?"}
              <button onClick={() => lib.setActiveAlbumId(null)} className="hover:text-white" aria-label="Leave album">
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          {lib.parsedSearch.terms.map((t) => (
            <span
              key={t.raw}
              title={t.label ? "Understood from your words" : undefined}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full border ${
                t.label
                  ? "bg-indigo-500/10 border-indigo-500/40 text-indigo-200"
                  : t.negate
                  ? "bg-red-500/10 border-red-500/40 text-red-200"
                  : "bg-emerald-500/10 border-emerald-500/40 text-emerald-200"
              }`}
            >
              {describeTerm(t)}
              <button
                onClick={() => lib.setSearchQuery(t.label ? removeUnderstood(lib.searchQuery, t.raw) : removeTerm(lib.searchQuery, t))}
                className="hover:text-white"
                aria-label={`Remove ${describeTerm(t)}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <span className="ml-auto flex items-center gap-1.5">
            {lib.activeAlbumId !== null && lib.selectedHashes.size > 0 && access.edit && (
              <button
                onClick={() => lib.activeAlbumId !== null && lib.handleRemoveFromAlbum(lib.activeAlbumId)}
                className="px-2 py-0.5 rounded-lg bg-zinc-900 hover:bg-red-950/60 border border-zinc-800 text-zinc-300"
              >
                Remove {lib.selectedHashes.size} from album
              </button>
            )}
            {lib.searchQuery.trim() !== "" &&
              access.edit &&
              (saveSearchName === null ? (
                <button
                  onClick={() => setSaveSearchName("")}
                  className="px-2 py-0.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-amber-200 flex items-center gap-1"
                  title="Save this search: it shows in Albums and updates by itself"
                >
                  <Sparkles className="w-3 h-3" />
                  Save as smart album
                </button>
              ) : (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (saveSearchName.trim() && (await lib.handleSaveSearch(saveSearchName))) setSaveSearchName(null);
                  }}
                  className="flex items-center gap-1"
                >
                  <input
                    autoFocus
                    value={saveSearchName}
                    onChange={(e) => setSaveSearchName(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Escape") setSaveSearchName(null);
                    }}
                    placeholder="Smart album name"
                    className="bg-zinc-950 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-200 select-text focus:outline-none focus:border-amber-400"
                  />
                  <button type="submit" className="px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-500 text-white">
                    Save
                  </button>
                </form>
              ))}
          </span>
        </div>
      )}
    </>
  );
}
