import { Sparkles } from "lucide-react";
import type { LibraryState } from "../../hooks/useLibraryState";

// Banners above the grid: smart search results ("best matches for …") and the burst comparison
export default function ResultBanners({ lib }: { lib: LibraryState }) {
  return (
    <>
      {lib.semanticScores && lib.semanticResult && (
        <div className="bg-indigo-950/40 border-b border-indigo-500/30 px-5 py-2 flex items-center justify-between gap-3 shrink-0 text-xs">
          <span className="flex items-center gap-2 text-indigo-100 min-w-0">
            <Sparkles className="w-4 h-4 text-indigo-300 shrink-0" />
            <span className="truncate">
              {lib.semanticResult.source.kind === "similar" ? (
                <>Photos similar to <strong>{lib.semanticResult.source.name}</strong></>
              ) : (
                <>
                  Best matches for <strong>"{lib.semanticResult.source.query}"</strong>
                  {lib.semanticResult.source.query !== lib.parsedSearch.text && " · searching…"}
                </>
              )}{" "}
              · {lib.visiblePhotos.length} photo{lib.visiblePhotos.length === 1 ? "" : "s"}, best first
            </span>
            {lib.semanticStatus && lib.semanticStatus.indexed < lib.semanticStatus.total && (
              <span className="text-indigo-300/80 shrink-0">
                ({lib.semanticStatus.indexed} of {lib.semanticStatus.total} photos indexed so far)
              </span>
            )}
          </span>
          <button
            onClick={lib.clearSemanticResult}
            className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 shrink-0"
          >
            Show all photos
          </button>
        </div>
      )}

      {(lib.smartFilter === "DUPLICATES" || lib.showAllBurstVersions) &&
        lib.duplicatePhotosCount > 0 && (
          <div className="bg-amber-950/30 border-b border-amber-500/30 px-5 py-2 flex items-center justify-between shrink-0">
            <span className="text-xs text-amber-200">
              Comparing <strong>{lib.totalBurstGroups}</strong> Burst Groups (
              {lib.duplicatePhotosCount} items):
            </span>
            <button
              onClick={lib.handleKeepSharpestInAllGroups}
              className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow transition"
            >
              Keep Best & Stage Rest for _Trash
            </button>
          </div>
        )}
    </>
  );
}
