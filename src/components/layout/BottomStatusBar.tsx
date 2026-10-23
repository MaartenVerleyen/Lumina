import { FaceScanProgress } from "../../types/lumina";
import {
  CheckSquare,
  Grid,
  Images,
  Loader2,
  ScanFace,
  Sparkles,
  Square,
  Zap,
} from "lucide-react";

interface BottomStatusBarProps {
  totalPhotos: number;
  visibleCount: number;
  selectedCount: number;
  viewMode: "grid" | "map" | "compare";
  zoomLevel: number;
  setZoomLevel: React.Dispatch<React.SetStateAction<number>>;
  progress: { completed: number; total: number } | null;
  faceScanProgress: FaceScanProgress | null;
  aiBatchProgress: {
    current: number;
    total: number;
    succeeded: number;
    failed: number;
  } | null;
}

export default function BottomStatusBar({
  totalPhotos,
  visibleCount,
  selectedCount,
  viewMode,
  zoomLevel,
  setZoomLevel,
  progress,
  faceScanProgress,
  aiBatchProgress,
}: BottomStatusBarProps) {
  return (
    <footer className="h-7 px-4 bg-[#0c0d14] border-t border-zinc-800/80 flex items-center justify-between text-[11px] text-zinc-400 select-none shrink-0 z-20">
      {/* Left: Library Telemetry & Active Background Tasks */}
      <div className="flex items-center gap-3 overflow-hidden">
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

        {progress && (
          <span className="flex items-center gap-1.5 text-emerald-400 font-mono bg-emerald-950/50 border border-emerald-500/30 px-2 py-0.5 rounded text-[10px] shrink-0">
            <Zap className="w-3 h-3 animate-pulse" />
            <span>
              Thumbs: {progress.completed}/{progress.total}
            </span>
          </span>
        )}

        {faceScanProgress && (
          <span className="flex items-center gap-1.5 text-indigo-300 font-mono bg-indigo-950/50 border border-indigo-500/30 px-2 py-0.5 rounded text-[10px] shrink-0">
            <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
            <ScanFace className="w-3 h-3 text-indigo-400" />
            <span>
              ONNX Faces: {faceScanProgress.completed}/{faceScanProgress.total} (
              {faceScanProgress.faces_found} found)
            </span>
          </span>
        )}

        {aiBatchProgress && (
          <span className="flex items-center gap-1.5 text-purple-300 font-mono bg-purple-950/50 border border-purple-500/30 px-2 py-0.5 rounded text-[10px] shrink-0">
            <Loader2 className="w-3 h-3 animate-spin text-purple-400" />
            <Sparkles className="w-3 h-3 text-purple-400" />
            <span>
              AI Tagging: {aiBatchProgress.current}/{aiBatchProgress.total}
            </span>
          </span>
        )}
      </div>

      {/* Center: Pro Keyboard Shortcut Hints */}
      <div className="hidden lg:flex items-center gap-3 text-[10px] text-zinc-500 font-mono">
        <span>
          <kbd className="px-1 py-0.2 bg-zinc-900 border border-zinc-800 rounded text-zinc-400">
            Space
          </kbd>{" "}
          Loupe
        </span>
        <span>
          <kbd className="px-1 py-0.2 bg-zinc-900 border border-zinc-800 rounded text-emerald-400">
            P
          </kbd>{" "}
          Pick
        </span>
        <span>
          <kbd className="px-1 py-0.2 bg-zinc-900 border border-zinc-800 rounded text-red-400">
            X
          </kbd>{" "}
          Reject
        </span>
        <span>
          <kbd className="px-1 py-0.2 bg-zinc-900 border border-zinc-800 rounded text-amber-400">
            1-5
          </kbd>{" "}
          Rate
        </span>
        <span>
          <kbd className="px-1 py-0.2 bg-zinc-900 border border-zinc-800 rounded text-indigo-400">
            C
          </kbd>{" "}
          Compare
        </span>
        <span>
          <kbd className="px-1 py-0.2 bg-zinc-900 border border-zinc-800 rounded text-indigo-400">
            A
          </kbd>{" "}
          AI Tag
        </span>
      </div>

      {/* Right: Grid Thumbnail Zoom Slider */}
      <div className="flex items-center gap-2 shrink-0">
        {viewMode === "grid" && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setZoomLevel((z) => Math.max(0, z - 0.15))}
              className="text-zinc-500 hover:text-zinc-300 transition"
              title="Smaller thumbnails"
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
            />
            <button
              onClick={() => setZoomLevel((z) => Math.min(1, z + 0.15))}
              className="text-zinc-500 hover:text-zinc-300 transition"
              title="Larger thumbnails"
            >
              <Square className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    </footer>
  );
}
