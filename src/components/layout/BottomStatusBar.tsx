import type { ViewMode } from "../../types/lumina";
import { useEffect, useRef, useState } from "react";
import { useAccess } from "../auth/ServerGate";
import { CheckSquare, FileText, Grid, Images, Loader2, Square, X } from "lucide-react";

// A background job shown in the Jobs panel (folder scan, thumbnails, face scan, AI batch, downloads, ...)
export interface BackgroundJob {
  id: string;
  label: string;
  detail?: string;
  completed: number;
  // 0 = unknown (indeterminate)
  total: number;
  onCancel?: () => void;
  cancelLabel?: string;
  cancelling?: boolean;
  // A second button next to Cancel ("Try again" for failed uploads)
  action?: { label: string; onClick: () => void };
}

interface BottomStatusBarProps {
  totalPhotos: number;
  visibleCount: number;
  selectedCount: number;
  viewMode: ViewMode;
  zoomLevel: number;
  setZoomLevel: React.Dispatch<React.SetStateAction<number>>;
  jobs: BackgroundJob[];
  sessionLogsCount?: number;
  onOpenSessionLog?: () => void;
}

// Remaining time from the progress seen since the job first appeared
function useEtas(jobs: BackgroundJob[]): Record<string, string> {
  const startRef = useRef<Record<string, { at: number; completed: number }>>({});
  const now = Date.now();
  const etas: Record<string, string> = {};
  const seen = new Set<string>();
  for (const job of jobs) {
    seen.add(job.id);
    const start = startRef.current[job.id];
    if (!start || job.completed < start.completed) {
      startRef.current[job.id] = { at: now, completed: job.completed };
      continue;
    }
    const done = job.completed - start.completed;
    const seconds = (now - start.at) / 1000;
    if (job.total > 0 && done >= 3 && seconds >= 2) {
      const remaining = ((job.total - job.completed) / done) * seconds;
      etas[job.id] = remaining < 60 ? `${Math.max(1, Math.round(remaining))} s left` : `${Math.round(remaining / 60)} min left`;
    }
  }
  for (const id of Object.keys(startRef.current)) {
    if (!seen.has(id)) delete startRef.current[id];
  }
  return etas;
}

export default function BottomStatusBar({
  totalPhotos,
  visibleCount,
  selectedCount,
  viewMode,
  zoomLevel,
  setZoomLevel,
  jobs,
  sessionLogsCount = 0,
  onOpenSessionLog,
}: BottomStatusBarProps) {
  const access = useAccess();
  const [isJobsOpen, setIsJobsOpen] = useState(false);
  const jobsRef = useRef<HTMLDivElement>(null);
  const etas = useEtas(jobs);

  useEffect(() => {
    if (!isJobsOpen) return;
    function onDown(e: MouseEvent) {
      if (jobsRef.current && !jobsRef.current.contains(e.target as Node)) setIsJobsOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [isJobsOpen]);

  useEffect(() => {
    if (jobs.length === 0) setIsJobsOpen(false);
  }, [jobs.length]);

  const percentOf = (job: BackgroundJob) =>
    job.total > 0 ? Math.min(100, Math.round((job.completed / job.total) * 100)) : null;
  const single = jobs.length === 1 ? jobs[0] : null;

  return (
    <footer className="h-7 px-4 bg-panel border-t border-zinc-800/80 flex items-center justify-between text-[11px] text-zinc-400 select-none shrink-0 z-20">
      {/* Left: library counts and background jobs */}
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex items-center gap-1.5 text-zinc-300 font-medium shrink-0">
          <Images className="w-3.5 h-3.5 text-emerald-400" />
          <span>
            Showing <strong className="text-zinc-100 font-mono">{visibleCount}</strong> of{" "}
            <span className="font-mono">{totalPhotos}</span>
          </span>
        </span>

        {selectedCount > 0 && (
          <span className="flex items-center gap-1 text-emerald-400 font-medium border-l border-zinc-800 pl-3 shrink-0">
            <CheckSquare className="w-3 h-3" />
            <span className="font-mono">{selectedCount}</span> selected
          </span>
        )}

        {jobs.length > 0 && (
          <div ref={jobsRef} className="relative shrink-0">
            <button
              onClick={() => setIsJobsOpen((o) => !o)}
              aria-expanded={isJobsOpen}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-zinc-700 bg-zinc-800/80 text-zinc-200 font-mono hover:bg-zinc-700 transition"
              title="Background jobs: progress and cancel"
            >
              <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
              {single ? (
                <span>
                  {single.label}
                  {single.total > 0 ? ` ${single.completed}/${single.total}` : "…"}
                </span>
              ) : (
                <span>{jobs.length} jobs running</span>
              )}
            </button>

            {isJobsOpen && (
              <div className="absolute left-0 bottom-full mb-2 w-96 bg-raised border border-zinc-700/80 rounded-xl shadow-2xl p-2 flex flex-col gap-1.5 z-50">
                <span className="px-1.5 pt-0.5 text-xs font-medium text-zinc-500">
                  Background jobs
                </span>
                {jobs.map((job) => {
                  const percent = percentOf(job);
                  return (
                    <div key={job.id} className="p-2 rounded-lg bg-zinc-900/80 border border-zinc-800 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-zinc-200 font-medium truncate">{job.label}</span>
                        {job.action && (
                          <button
                            onClick={job.action.onClick}
                            className="ml-auto px-2 py-0.5 rounded bg-zinc-800 hover:bg-emerald-950/70 text-zinc-300 hover:text-emerald-200 text-[11px] shrink-0"
                          >
                            {job.action.label}
                          </button>
                        )}
                        {job.onCancel && (
                          <button
                            onClick={job.onCancel}
                            disabled={job.cancelling}
                            className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-red-950/70 text-zinc-300 hover:text-red-200 disabled:opacity-60 text-[11px] shrink-0"
                          >
                            <X className="w-3 h-3" />
                            {job.cancelling ? "Stopping…" : job.cancelLabel ?? "Cancel"}
                          </button>
                        )}
                      </div>
                      <div className="h-1.5 bg-zinc-950 rounded-full overflow-hidden">
                        {percent === null ? (
                          <div className="h-full w-1/3 bg-emerald-500/70 rounded-full animate-pulse" />
                        ) : (
                          <div style={{ width: `${percent}%` }} className="h-full bg-emerald-500 rounded-full transition-all duration-300" />
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500 font-mono">
                        <span className="truncate">{job.detail ?? ""}</span>
                        <span className="shrink-0">
                          {job.total > 0 ? `${job.completed}/${job.total} · ${percent}%` : "working…"}
                          {etas[job.id] ? ` · ${etas[job.id]}` : ""}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Center: keyboard hints */}
      <div className="hidden lg:flex items-center gap-3 text-[11px] text-zinc-500 font-mono">
        {([
          ["Ctrl+P", "Commands", "text-emerald-300", true],
          ["Space", "Loupe", "text-zinc-400", true],
          ["P", "Pick", "text-emerald-400", access.edit],
          ["X", "Reject", "text-red-400", access.edit],
          ["1-5", "Rate", "text-amber-400", access.edit],
          ["C", "Compare", "text-zinc-400", true],
          ["A", "AI Tag", "text-zinc-400", access.edit],
        ] as [string, string, string, boolean][]).filter(([, , , shown]) => shown).map(([key, label, color]) => (
          <span key={key}>
            <kbd className={`px-1 py-0.2 bg-zinc-900 border border-zinc-800 rounded ${color}`}>{key}</kbd> {label}
          </span>
        ))}
      </div>

      {/* Right: Session Log and thumbnail size */}
      <div className="flex items-center gap-3 shrink-0">
        {onOpenSessionLog && (
          <button
            onClick={onOpenSessionLog}
            className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-emerald-300 font-mono transition"
            title="Open session activity log (Ctrl+L)"
          >
            <FileText className="w-3 h-3 text-emerald-400" />
            <span>Session Log ({sessionLogsCount})</span>
          </button>
        )}

        {(viewMode === "grid" || viewMode === "people") && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setZoomLevel((z) => Math.max(0, z - 0.15))}
              className="text-zinc-500 hover:text-zinc-300 transition"
              title="Smaller thumbnails"
              aria-label="Smaller thumbnails"
            >
              <Grid className="w-3 h-3" />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={zoomLevel}
              onChange={(e) => setZoomLevel(parseFloat(e.target.value))}
              className="w-20 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              title="Adjust grid thumbnail size"
              aria-label="Thumbnail size"
            />
            <button
              onClick={() => setZoomLevel((z) => Math.min(1, z + 0.15))}
              className="text-zinc-500 hover:text-zinc-300 transition"
              title="Larger thumbnails"
              aria-label="Larger thumbnails"
            >
              <Square className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    </footer>
  );
}
