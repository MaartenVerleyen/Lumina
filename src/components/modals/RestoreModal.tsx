import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArchiveRestore, ArrowRight, CheckCircle2, AlertTriangle, Loader2, X } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import type { BackupManifest } from "../../types/lumina";
import type { RootRemap } from "../../utils/backup";

interface RestoreModalProps {
  target: { path: string; manifest: BackupManifest } | null;
  busy: boolean;
  onClose: () => void;
  onRestore: (remaps: RootRemap[]) => void;
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[15px] font-semibold text-zinc-100 tabular-nums">{value.toLocaleString()}</span>
      <span className="text-[11px] text-zinc-500">{label}</span>
    </div>
  );
}

// Restoring a backup: what it holds, and where each of its library folders is on this PC
export default function RestoreModal({ target, busy, onClose, onRestore }: RestoreModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(target !== null);
  // New location per library folder in the backup (the same path when it is still there)
  const [targets, setTargets] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!target) return;
    setTargets(Object.fromEntries(target.manifest.roots.map((r) => [r.path, r.path])));
  }, [target]);

  if (!target) return null;
  const { manifest } = target;
  const made = new Date(manifest.created_at * 1000);
  const missing = manifest.roots.filter((r) => !r.exists && (targets[r.path] ?? r.path) === r.path).length;

  const choose = async (root: string) => {
    const picked = await open({ directory: true, multiple: false, title: `Where are the photos from ${root} now?` });
    if (typeof picked === "string") setTargets((prev) => ({ ...prev, [root]: picked }));
  };

  return (
    <div onClick={busy ? undefined : onClose} className="fixed inset-0 z-[9985] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Restore a backup"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.stopPropagation();
            onClose();
          }
        }}
        className="bg-raised border border-zinc-800 rounded-2xl shadow-2xl w-[min(680px,100%)] max-h-full flex flex-col text-xs"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-[15px] font-semibold text-zinc-100 flex items-center gap-2">
            <ArchiveRestore className="w-4 h-4 text-emerald-400" />
            Restore a backup
          </h2>
          <button onClick={onClose} disabled={busy} className="p-1 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800 disabled:opacity-40" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 flex flex-col gap-5 overflow-y-auto">
          <div>
            <div className="text-[13px] text-zinc-200">
              Made {made.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} at{" "}
              {made.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              {manifest.computer && <> on {manifest.computer}</>}
            </div>
            <div className="text-zinc-500 mt-0.5 font-mono text-[11px] truncate" title={target.path}>
              {target.path}
            </div>
          </div>
          <div className="grid grid-cols-5 gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-3">
            <Stat value={manifest.photos} label="photos" />
            <Stat value={manifest.rated} label="rated or flagged" />
            <Stat value={manifest.people} label="people" />
            <Stat value={manifest.named_faces} label="named faces" />
            <Stat value={manifest.albums} label="albums" />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Library folders</span>
            <p className="text-zinc-500 -mt-1">
              On a new PC, or after moving your photos, point each folder to where the photos are now. Ratings, names
              and captions follow them.
            </p>
            <div className="rounded-xl border border-zinc-800 divide-y divide-zinc-800/80">
              {manifest.roots.map((r) => {
                const to = targets[r.path] ?? r.path;
                const moved = to !== r.path;
                const ok = r.exists || moved;
                return (
                  <div key={r.path} className="flex items-center gap-3 px-4 py-3">
                    {ok ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-label="Found" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-label="Not found on this PC" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`font-mono text-[11.5px] truncate ${moved ? "text-zinc-500 line-through" : "text-zinc-200"}`} title={r.path}>
                          {r.path}
                        </span>
                        {moved && (
                          <>
                            <ArrowRight className="w-3 h-3 text-zinc-500 shrink-0" />
                            <span className="font-mono text-[11.5px] text-emerald-300 truncate" title={to}>
                              {to}
                            </span>
                          </>
                        )}
                      </div>
                      <div className={`text-[11.5px] mt-0.5 ${ok ? "text-zinc-500" : "text-amber-300/90"}`}>
                        {r.photos.toLocaleString()} photo{r.photos === 1 ? "" : "s"}
                        {!ok && " · not found on this PC: choose where they are now"}
                      </div>
                    </div>
                    {moved && (
                      <button onClick={() => setTargets((prev) => ({ ...prev, [r.path]: r.path }))} className="px-2 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
                        Undo
                      </button>
                    )}
                    <button
                      onClick={() => choose(r.path)}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 shrink-0 disabled:opacity-40"
                    >
                      {ok ? "Change…" : "Choose…"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          <p className="text-zinc-500 leading-relaxed">
            Lumina restarts with this backup's ratings, flags, people, captions, albums and settings. Your current
            library is kept as a safety copy. Thumbnails are made again when you open each folder.
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-zinc-800">
          <span className={`text-[12px] ${missing ? "text-amber-300/90" : "text-zinc-500"}`}>
            {missing > 0 ? `${missing} folder${missing === 1 ? "" : "s"} not found here: those photos keep their old location.` : ""}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onClose} disabled={busy} className="px-3.5 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-40">
              Cancel
            </button>
            <button
              onClick={() => onRestore(Object.entries(targets).map(([from, to]) => ({ from, to })).filter((r) => r.from !== r.to))}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-40"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Restore and restart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
