import { thumbSrc } from "../../utils/photoHelpers";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { invoke } from "@tauri-apps/api/core";
import { PhotoItem } from "../../types/lumina";
import { ArrowRight, CheckCircle, Folder, Sparkles, X } from "lucide-react";

interface CommitModalProps {
  isOpen: boolean;
  onClose: () => void;
  stagedPhotos: PhotoItem[];
  setPhotos: React.Dispatch<React.SetStateAction<PhotoItem[]>>;
  smartRenameOnCommit: boolean;
  setSmartRenameOnCommit: React.Dispatch<React.SetStateAction<boolean>>;
  handleDismissAllStaged: () => Promise<void>;
  handleCommitAllStaged: () => Promise<void>;
}

export default function CommitModal({
  isOpen,
  onClose,
  stagedPhotos,
  setPhotos,
  smartRenameOnCommit,
  setSmartRenameOnCommit,
  handleDismissAllStaged,
  handleCommitAllStaged,
}: CommitModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  if (!isOpen) return null;

  const trashCount = stagedPhotos.filter((p) => p.staged_target === "_Trash").length;
  const moveTargets = new Set(
    stagedPhotos.filter((p) => p.staged_target && p.staged_target !== "_Trash").map((p) => p.staged_target)
  );
  const moveCount = stagedPhotos.length - trashCount;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Review staged disk moves" tabIndex={-1} className="bg-raised border border-zinc-800 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
        <div className="p-5 border-b border-zinc-800 flex justify-between items-center">
          <div>
            <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-emerald-400" />
              Review Staged Disk Moves
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              {moveCount > 0 && (
                <>
                  <strong className="text-zinc-200">{moveCount}</strong> file(s) move into{" "}
                  <strong className="text-zinc-200">{moveTargets.size}</strong> folder(s)
                </>
              )}
              {moveCount > 0 && trashCount > 0 && " · "}
              {trashCount > 0 && (
                <>
                  <strong className="text-red-300">{trashCount}</strong> go to _Trash
                </>
              )}
              . Paired RAW files and .xmp sidecars move along. Files are moved on your drive.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-2">
          {stagedPhotos.map((p) => (
            <div
              key={p.hash}
              className="flex items-center justify-between p-3 bg-zinc-900/60 rounded-xl text-xs border border-zinc-800/60"
            >
              <div className="flex items-center gap-3 truncate">
                <img
                  src={thumbSrc(p)}
                  alt={p.name}
                  className="w-9 h-9 object-cover rounded-lg shrink-0"
                />
                <div className="truncate">
                  <div className="font-medium text-zinc-200 truncate">{p.name}</div>
                  <div className="text-[11px] text-zinc-500 flex items-center gap-1">
                    <span>From:</span>
                    <Folder className="w-3 h-3 text-zinc-500" />
                    <span>{p.subfolder}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-emerald-400 font-mono font-medium flex items-center gap-1">
                  <ArrowRight className="w-3.5 h-3.5" />
                  <span>{p.staged_target}</span>
                </span>
                <button
                  onClick={async () => {
                    await invoke("stage_photo_move", {
                      hash: p.hash,
                      targetSubfolder: null,
                    });
                    setPhotos((prev) =>
                      prev.map((x) =>
                        x.hash === p.hash ? { ...x, staged_target: null } : x
                      )
                    );
                  }}
                  className="text-zinc-500 hover:text-red-400"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-2.5 bg-zinc-900/90 border-t border-zinc-800 flex items-center justify-between text-xs">
          <label className="flex items-center gap-2 text-zinc-200 cursor-pointer">
            <input
              type="checkbox"
              checked={smartRenameOnCommit}
              onChange={(e) => setSmartRenameOnCommit(e.target.checked)}
              className="rounded bg-zinc-800 border-zinc-700 text-emerald-500 focus:ring-0"
            />
            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
            <span>
              <strong>Smart Chronological Rename</strong> on Commit (
              <code className="text-emerald-400">YYYY-MM-DD_HHMMSS_City_001.jpg</code>)
            </span>
          </label>
        </div>
        <div className="p-4 border-t border-zinc-800 flex justify-between items-center bg-zinc-950">
          <span className="text-xs text-zinc-400">
            Total: <strong>{stagedPhotos.length}</strong> changes
          </span>
          <div className="flex gap-2.5">
            <button
              onClick={handleDismissAllStaged}
              className="px-3.5 py-1.5 bg-red-950/60 hover:bg-red-900/70 text-red-300 border border-red-800/50 rounded-lg text-xs font-medium"
            >
              Dismiss All
            </button>
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs"
            >
              Close
            </button>
            <button
              onClick={handleCommitAllStaged}
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow"
            >
              Commit to Disk
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
