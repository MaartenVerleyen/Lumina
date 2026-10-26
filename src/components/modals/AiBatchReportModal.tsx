import { useDialogFocus } from "../../hooks/useDialogFocus";
import { AlertTriangle, CheckCircle2, RefreshCw, X } from "lucide-react";
import { PhotoItem } from "../../types/lumina";

export interface AiFailureItem {
  photo: PhotoItem;
  error: string;
  attempts: number;
}

interface AiBatchReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  succeededCount: number;
  failures: AiFailureItem[];
  onRetryFailures: (failures: AiFailureItem[]) => void;
}

export default function AiBatchReportModal({
  isOpen,
  onClose,
  succeededCount,
  failures,
  onRetryFailures,
}: AiBatchReportModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9990] bg-black/85 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="AI batch report" tabIndex={-1} className="bg-raised border border-zinc-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {failures.length === 0 ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-amber-400" />
            )}
            <h3 className="text-sm font-bold text-zinc-100">AI Batch Tagging Report</h3>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Summary Card */}
        <div className="p-5 flex flex-col gap-4 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-zinc-900/60 border border-zinc-800 rounded-xl">
              <span className="text-[11px] uppercase font-bold text-zinc-500">Completed Successfully</span>
              <div className="text-lg font-bold text-emerald-400 mt-1 font-mono">{succeededCount} photos</div>
            </div>
            <div className="p-3 bg-zinc-900/60 border border-zinc-800 rounded-xl">
              <span className="text-[11px] uppercase font-bold text-zinc-500">Failed with Errors</span>
              <div className="text-lg font-bold text-red-400 mt-1 font-mono">{failures.length} photos</div>
            </div>
          </div>

          {failures.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold text-zinc-300">Failure Details & Reasons:</span>
              <div className="max-h-48 overflow-y-auto flex flex-col gap-1.5 pr-1">
                {failures.map((f) => (
                  <div
                    key={f.photo.hash}
                    className="p-2.5 rounded-lg bg-zinc-950/80 border border-red-950/60 flex flex-col gap-1"
                  >
                    <div className="flex justify-between items-center text-zinc-300 font-medium">
                      <span className="truncate">{f.photo.name}</span>
                      <span className="text-[11px] text-zinc-500 font-mono">Retried {f.attempts}x</span>
                    </div>
                    <span className="text-[11px] text-red-300/80 font-mono break-words">{f.error}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-zinc-950 border-t border-zinc-800 flex justify-between items-center">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-lg text-xs font-medium"
          >
            Close
          </button>
          {failures.length > 0 && (
            <button
              onClick={() => {
                onRetryFailures(failures);
                onClose();
              }}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry {failures.length} Failed Photo{failures.length === 1 ? "" : "s"}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}