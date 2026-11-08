import { useEffect, useRef, useState } from "react";
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
  // Show files per second and time left (off when `completed` isn't a count of files)
  showRate?: boolean;
}

// How long the rate is averaged over: long enough to smooth out slow files, short enough to follow changes
const RATE_WINDOW_MS = 20000;

function formatEta(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${minutes % 60} min`;
}

// Files per second over the last RATE_WINDOW_MS, starting over when the stage changes. Progress only records
// a sample; the shown rate is worked out once a second (setting state on every progress event, hundreds a
// second during a rescan, made React report an update loop)
function useRate(isOpen: boolean, stage: string, completed: number): number | null {
  const samples = useRef<{ t: number; done: number }[]>([]);
  const stageRef = useRef(stage);
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    const now = performance.now();
    const last = samples.current[samples.current.length - 1];
    if (!isOpen || stageRef.current !== stage || (last && completed < last.done)) {
      samples.current = [];
      stageRef.current = stage;
      if (!isOpen) return;
    }
    const s = samples.current;
    s.push({ t: now, done: completed });
    while (s.length > 2 && now - s[0].t > RATE_WINDOW_MS) s.shift();
  }, [isOpen, stage, completed]);
  useEffect(() => {
    setRate(null);
    if (!isOpen) return;
    const timer = setInterval(() => {
      const s = samples.current;
      const first = s[0];
      const last = s[s.length - 1];
      const seconds = first ? (performance.now() - first.t) / 1000 : 0;
      setRate(first && seconds >= 3 && last.done > first.done ? (last.done - first.done) / seconds : null);
    }, 1000);
    return () => clearInterval(timer);
  }, [isOpen, stage]);
  return rate;
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
  showRate = true,
}: OperationProgressModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  const rate = useRate(isOpen && showRate, stage, completed);
  if (!isOpen) return null;

  // Until the backend reports a total (e.g. while it lists the folder) the bar is indeterminate
  const known = total > 0;
  const percent = known ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  return (
    <div className="fixed inset-0 z-[9990] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="bg-raised border border-zinc-800 rounded-2xl w-full max-w-md p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
            <p className="text-xs text-zinc-400">{stage}</p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="flex flex-col gap-1.5">
          <div className="w-full h-2.5 bg-zinc-900 border border-zinc-800 rounded-full overflow-hidden p-0.5">
            {known ? (
              <div
                style={{ width: `${percent}%` }}
                className="h-full bg-emerald-500 rounded-full transition-[width] duration-200"
              />
            ) : (
              <div className="h-full w-1/3 bg-emerald-500/70 rounded-full animate-pulse" />
            )}
          </div>
          <div className="flex justify-between items-center text-[11px] text-zinc-500 font-mono">
            <span className="truncate">{currentFile || "Processing..."}</span>
            {known && (
              <span className="shrink-0 ml-2">
                {completed.toLocaleString()} / {total.toLocaleString()} ({percent}%)
              </span>
            )}
          </div>
          {known && rate !== null && (
            <div className="flex justify-between text-[11px] text-zinc-500 font-mono">
              <span>{rate >= 10 ? Math.round(rate) : rate.toFixed(1)} files/s</span>
              <span>{formatEta(Math.max(0, total - completed) / rate)} left</span>
            </div>
          )}
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