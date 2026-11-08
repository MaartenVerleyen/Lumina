import { BookImage, Globe, Grid3x3, Loader2, Trophy, X } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import type { HighlightsState } from "../../hooks/library/useHighlights";
import type { PhotoItem } from "../../types/lumina";
import { thumbSrc } from "../../utils/photoHelpers";

const COUNTS = [10, 20, 50];

interface HighlightsModalProps {
  highlights: HighlightsState | null;
  photoByHash: Map<string, PhotoItem>;
  onClose: () => void;
  onCount: (count: number) => void;
  onShowInGrid: () => void;
  // Absent for users who may not make albums
  onSaveAsAlbum?: () => void;
  // Absent in the web client (a gallery is written to a folder on this computer)
  onShareGallery?: () => void;
  onOpenPhoto: (hash: string) => void;
}

// The chosen highlights of a set: a wall of the best photos, with how many to pick and what to do with them
export default function HighlightsModal({
  highlights,
  photoByHash,
  onClose,
  onCount,
  onShowInGrid,
  onSaveAsAlbum,
  onShareGallery,
  onOpenPhoto,
}: HighlightsModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(highlights !== null);
  if (!highlights) return null;
  const picks = (highlights.hashes ?? []).map((h) => photoByHash.get(h)).filter((p): p is PhotoItem => Boolean(p));

  return (
    <div onClick={onClose} className="fixed inset-0 z-[9985] bg-black/85 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Highlights: ${highlights.title}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        className="bg-raised border border-zinc-800 rounded-2xl shadow-2xl w-[min(1180px,100%)] h-[min(820px,100%)] flex flex-col overflow-hidden"
      >
        <div className="flex items-center gap-4 px-6 py-4 border-b border-zinc-800">
          <span className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/25 grid place-items-center shrink-0">
            <Trophy className="w-4 h-4 text-amber-300" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-zinc-100 truncate">Highlights · {highlights.title}</h2>
            <p className="text-[12px] text-zinc-500">
              The best of {highlights.source.length.toLocaleString()} photos: your stars and picks, open eyes, sharp faces,
              how good a photo looks, and variety.
            </p>
          </div>
          <div className="flex bg-zinc-950 border border-zinc-800 rounded-lg p-0.5 text-[12px]">
            {COUNTS.map((n) => (
              <button
                key={n}
                onClick={() => onCount(n)}
                aria-pressed={highlights.count === n}
                className={`px-3 py-1 rounded-md transition ${
                  highlights.count === n ? "bg-amber-500/20 text-amber-200 font-semibold" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {highlights.hashes === null ? (
            <div className="h-full flex items-center justify-center gap-2 text-sm text-zinc-400">
              <Loader2 className="w-5 h-5 animate-spin" /> Choosing the best photos…
            </div>
          ) : picks.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-zinc-500">No photos to choose from here.</div>
          ) : (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
              {picks.map((p) => (
                <button
                  key={p.hash}
                  onClick={() => onOpenPhoto(p.hash)}
                  className="group relative aspect-[4/3] rounded-xl overflow-hidden bg-zinc-950 border border-zinc-800 hover:border-amber-400/60 lumina-tour-enter"
                  title={p.name}
                >
                  {p.thumb_ready && (
                    <img
                      src={thumbSrc(p)}
                      alt={p.name}
                      draggable={false}
                      className="w-full h-full object-cover"
                      style={p.rotation ? { transform: `rotate(${p.rotation}deg)` } : undefined}
                    />
                  )}
                  <span className="absolute inset-x-0 bottom-0 px-2.5 py-1.5 bg-gradient-to-t from-black/80 to-transparent text-[11px] text-zinc-200 text-left opacity-0 group-hover:opacity-100 transition">
                    {p.captured_at ? p.captured_at.slice(0, 10).replace(/:/g, "-") : p.name}
                    {p.location ? ` · ${p.location.split(",")[0]}` : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-3.5 border-t border-zinc-800 text-[12px]">
          <span className="text-zinc-500">{picks.length > 0 && `${picks.length} photos, oldest first`}</span>
          <div className="flex items-center gap-2">
            {onShareGallery && (
              <button
                onClick={onShareGallery}
                disabled={picks.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 disabled:opacity-40"
              >
                <Globe className="w-3.5 h-3.5 text-emerald-400" /> Share as web page
              </button>
            )}
            {onSaveAsAlbum && (
            <button
              onClick={onSaveAsAlbum}
              disabled={picks.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 disabled:opacity-40"
            >
              <BookImage className="w-3.5 h-3.5 text-zinc-400" /> Save as album
            </button>
            )}
            <button
              onClick={onShowInGrid}
              disabled={picks.length === 0}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-40"
            >
              <Grid3x3 className="w-3.5 h-3.5" /> Show in Photos
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
