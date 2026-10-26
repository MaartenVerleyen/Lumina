import { useDialogFocus } from "../../hooks/useDialogFocus";
import { Loader2 } from "lucide-react";

interface OperationProgressModalProps {
  isOpen: boolean;
  title: string;
  stage: string;
  currentFile?: string;
  completed: number;
  total: number;
  onCancel?: () => void;
  cancelLabel?: string;
}

export default function OperationProgressModal({
  isOpen,
  title,
  stage,
  currentFile,
  completed,
  total,
  onCancel,
  cancelLabel = "Cancel",
}: OperationProgressModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  if (!isOpen) return null;

  // Until the backend reports a total (e.g. while it lists the folder) the bar is indeterminate
  const known = total > 0;
  const percent = known ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  return (
    <div className="fixed inset-0 z-[9990] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="bg-[#12141c] border border-zinc-800 rounded-2xl w-full max-w-md p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-zinc-100">{title}</h3>
            <p className="text-xs text-zinc-400">{stage}</p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="flex flex-col gap-1.5">
          <div className="w-full h-2.5 bg-zinc-900 border border-zinc-800 rounded-full overflow-hidden p-0.5">
            {known ? (
              <div
                style={{ width: `${percent}%` }}
                className="h-full bg-emerald-500 rounded-full transition-all duration-200 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
              />
            ) : (
              <div className="h-full w-1/3 bg-emerald-500/70 rounded-full animate-pulse" />
            )}
          </div>
          <div className="flex justify-between items-center text-[11px] text-zinc-500 font-mono">
            <span className="truncate">{currentFile || "Processing..."}</span>
            {known && (
              <span className="shrink-0 ml-2">
                {completed} / {total} ({percent}%)
              </span>
            )}
          </div>
        </div>

        {onCancel && (
          <div className="flex justify-end pt-2">
            <button
              onClick={onCancel}
              className="px-3.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-medium transition"
            >
              {cancelLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}