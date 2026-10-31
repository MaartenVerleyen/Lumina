import { useMemo, useState } from "react";
import { Copy, Crown, Images, Loader2, Trash2, X } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import type { DuplicateSet, DuplicateStage } from "../../hooks/library/useDuplicates";
import type { PhotoItem } from "../../types/lumina";
import { thumbSrc } from "../../utils/photoHelpers";

type Kind = DuplicateSet["kind"];

const KINDS: { kind: Kind; label: string; hint: string }[] = [
  {
    kind: "exact",
    label: "Exact copies",
    hint: "Byte-for-byte the same file in more than one folder. Removing the extras loses nothing.",
  },
  {
    kind: "same_photo",
    label: "Same photo, different file",
    hint: "One shot saved more than once: resized by Google Photos, a developed or edited export, a black and white version. Taken in the same second and looking alike; bursts and RAW files are never included.",
  },
];
const PAGE = 30;

interface DuplicatesModalProps {
  duplicates: { sets: DuplicateSet[] | null } | null;
  photoByHash: Map<string, PhotoItem>;
  folder: string;
  onClose: () => void;
  onStage: (stages: DuplicateStage[]) => Promise<boolean>;
  confirmAction: (message: string, confirmLabel: string, options?: { title?: string }) => Promise<boolean>;
}

const formatSize = (kb: number) =>
  kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`;

// Duplicates review: exact copies and the same photo as different files, one set per row with the copy to keep
// marked (click another copy to keep that one instead). Extras are staged for _Trash, per set or all at once.
export default function DuplicatesModal({ duplicates, photoByHash, folder, onClose, onStage, confirmAction }: DuplicatesModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(duplicates !== null);
  const [kind, setKind] = useState<Kind>("exact");
  // Per set (keyed by its first hash): the copy chosen to keep instead of the suggestion, and sets skipped
  const [keepers, setKeepers] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(false);

  // Sets of the open folder that still have at least two photos, per kind
  const byKind = useMemo(() => {
    const out: Record<Kind, { key: string; photos: PhotoItem[] }[]> = { exact: [], same_photo: [] };
    for (const set of duplicates?.sets ?? []) {
      const photos = set.hashes.map((h) => photoByHash.get(h)).filter((p): p is PhotoItem => Boolean(p) && p!.staged_target !== "_Trash");
      if (photos.length > 1) out[set.kind].push({ key: set.hashes[0], photos });
    }
    return out;
  }, [duplicates, photoByHash]);

  if (!duplicates) return null;
  const sets = byKind[kind].filter((s) => !skipped.has(s.key));
  const stageOf = (s: { key: string; photos: PhotoItem[] }): DuplicateStage => {
    const keep = keepers[s.key] ?? s.photos[0].hash;
    return { keep, extras: s.photos.filter((p) => p.hash !== keep).map((p) => p.hash) };
  };
  const extrasOf = (list: typeof sets) => list.reduce((n, s) => n + s.photos.length - 1, 0);
  const extraSize = (list: typeof sets) =>
    list.reduce((kb, s) => kb + s.photos.filter((p) => p.hash !== (keepers[s.key] ?? s.photos[0].hash)).reduce((a, p) => a + p.size_kb, 0), 0);
  const relativeFolder = (p: PhotoItem) => {
    const dir = p.path.slice(0, Math.max(p.path.lastIndexOf("\\"), p.path.lastIndexOf("/")));
    const root = folder.replace(/[\\/]+$/, "");
    return dir.toLowerCase().startsWith(root.toLowerCase()) ? dir.slice(root.length + 1) || "(top folder)" : dir;
  };

  async function stage(list: typeof sets) {
    setBusy(true);
    try {
      await onStage(list.map(stageOf));
    } finally {
      setBusy(false);
    }
  }

  async function stageAll() {
    const extras = extrasOf(sets);
    const ok = await confirmAction(
      `Stage ${extras.toLocaleString()} extra cop${extras === 1 ? "y" : "ies"} (${formatSize(extraSize(sets))}) from ${sets.length.toLocaleString()} sets for _Trash?\n\nEach set keeps the copy marked Keep, which takes over the stars, tags, people and albums of the others. Nothing is deleted until you Commit, and Ctrl+Z undoes it.`,
      "Stage for _Trash",
      { title: KINDS.find((k) => k.kind === kind)!.label }
    );
    if (ok) await stage(sets);
  }

  const info = KINDS.find((k) => k.kind === kind)!;
  return (
    <div onClick={onClose} className="fixed inset-0 z-[9985] bg-black/85 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Duplicates"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        className="bg-raised border border-zinc-800 rounded-2xl shadow-2xl w-[min(1180px,100%)] h-[min(860px,100%)] flex flex-col overflow-hidden"
      >
        <div className="flex items-center gap-4 px-6 py-4 border-b border-zinc-800">
          <span className="w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/25 grid place-items-center shrink-0">
            <Copy className="w-4 h-4 text-sky-300" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-zinc-100">Duplicates</h2>
            <p className="text-[12px] text-zinc-500">
              The copy to keep is the largest, then the oldest, then the one with the most stars, tags and people. Click
              another copy to keep that one instead.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-6 pt-3">
          {KINDS.map((k) => {
            const list = byKind[k.kind].filter((s) => !skipped.has(s.key));
            return (
              <button
                key={k.kind}
                onClick={() => {
                  setKind(k.kind);
                  setShown(PAGE);
                }}
                aria-pressed={kind === k.kind}
                className={`px-3 py-1.5 rounded-lg text-[12px] border transition ${
                  kind === k.kind
                    ? "bg-sky-500/15 text-sky-200 border-sky-500/40 font-semibold"
                    : "text-zinc-400 border-zinc-800 hover:bg-zinc-900 hover:text-zinc-200"
                }`}
              >
                {k.label}
                {duplicates.sets && <span className="ml-1.5 font-mono text-[11px] opacity-80">{list.length.toLocaleString()}</span>}
              </button>
            );
          })}
        </div>
        <p className="px-6 pt-2 pb-3 text-[12px] text-zinc-500 border-b border-zinc-800/70">{info.hint}</p>

        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3">
          {duplicates.sets === null ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-zinc-400 text-xs">
              <Loader2 className="w-5 h-5 animate-spin text-sky-400" />
              Looking for duplicates…
            </div>
          ) : sets.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-zinc-400 text-xs">
              <Images className="w-8 h-8 text-zinc-600" />
              <span className="text-sm font-semibold text-zinc-200">No {info.label.toLowerCase()} left</span>
            </div>
          ) : (
            <>
              {sets.slice(0, shown).map((s) => {
                const keep = keepers[s.key] ?? s.photos[0].hash;
                return (
                  <div key={s.key} className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800 flex flex-col gap-2.5">
                    <div className="flex gap-2.5 overflow-x-auto pb-1">
                      {s.photos.map((p) => {
                        const isKeep = p.hash === keep;
                        return (
                          <button
                            key={p.hash}
                            onClick={() => setKeepers((prev) => ({ ...prev, [s.key]: p.hash }))}
                            aria-pressed={isKeep}
                            title={isKeep ? `Keeping ${p.path}` : `Keep ${p.path} instead`}
                            className={`relative w-44 shrink-0 rounded-lg border text-left overflow-hidden transition ${
                              isKeep ? "border-emerald-500/70 bg-emerald-950/30" : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600 opacity-80 hover:opacity-100"
                            }`}
                          >
                            <div className="h-28 bg-zinc-950">
                              {p.thumb_ready && (
                                <img src={thumbSrc(p)} alt="" loading="lazy" draggable={false} className="w-full h-full object-cover" />
                              )}
                            </div>
                            <span
                              className={`absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold flex items-center gap-1 ${
                                isKeep ? "bg-emerald-500 text-zinc-950" : "bg-black/70 text-zinc-300"
                              }`}
                            >
                              {isKeep ? (
                                <>
                                  <Crown className="w-3 h-3" /> Keep
                                </>
                              ) : (
                                "Extra"
                              )}
                            </span>
                            <div className="px-2 py-1.5 flex flex-col gap-0.5 text-[11px]">
                              <span className="text-zinc-200 truncate" title={p.name}>{p.name}</span>
                              <span className="text-zinc-500 truncate" title={relativeFolder(p)}>{relativeFolder(p)}</span>
                              <span className="text-zinc-500 font-mono">
                                {p.width && p.height ? `${p.width}×${p.height} · ` : ""}
                                {formatSize(p.size_kb)}
                              </span>
                              <span className="text-zinc-600 font-mono">{p.captured_at ? p.captured_at.slice(0, 16) : "no date"}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-end gap-2 text-[12px]">
                      <button
                        onClick={() => setSkipped((prev) => new Set(prev).add(s.key))}
                        className="px-2.5 py-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                        title="Leave this set as it is (until the next search)"
                      >
                        Skip
                      </button>
                      <button
                        onClick={() => stage([s])}
                        disabled={busy}
                        className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-red-950/50 border border-zinc-700 hover:border-red-500/40 text-zinc-200 hover:text-red-200 flex items-center gap-1.5 disabled:opacity-40"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Stage {s.photos.length - 1} extra{s.photos.length === 2 ? "" : "s"} for _Trash
                      </button>
                    </div>
                  </div>
                );
              })}
              {sets.length > shown && (
                <button
                  onClick={() => setShown((n) => n + PAGE)}
                  className="self-center px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-[12px]"
                >
                  Show {Math.min(PAGE, sets.length - shown)} more of {(sets.length - shown).toLocaleString()}
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-3.5 border-t border-zinc-800 text-[12px]">
          <span className="text-zinc-500">
            {duplicates.sets &&
              sets.length > 0 &&
              `${sets.length.toLocaleString()} sets · ${extrasOf(sets).toLocaleString()} extra files · ${formatSize(extraSize(sets))}`}
          </span>
          <button
            onClick={stageAll}
            disabled={busy || sets.length === 0}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Stage all {extrasOf(sets).toLocaleString()} extras for _Trash
          </button>
        </div>
      </div>
    </div>
  );
}
