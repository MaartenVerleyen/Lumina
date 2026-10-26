import { useDialogFocus } from "../../hooks/useDialogFocus";
import { LibraryHealthStats } from "../../types/lumina";
import { AlertTriangle, Camera, FileCode, HardDrive, Trash2, X } from "lucide-react";

interface HealthXmpModalProps {
  isOpen: boolean;
  onClose: () => void;
  healthStats: LibraryHealthStats | null;
  isExportingXmp: boolean;
  handlePruneCache: () => Promise<void>;
  handleExportXmp: (onlySelected: boolean) => Promise<void>;
}

export default function HealthXmpModal({
  isOpen,
  onClose,
  healthStats,
  isExportingXmp,
  handlePruneCache,
  handleExportXmp,
}: HealthXmpModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Library health" tabIndex={-1} className="bg-raised border border-zinc-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col">
        <div className="p-5 border-b border-zinc-800 flex justify-between items-center">
          <div>
            <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-emerald-400" />
              Library Health, Storage & XMP Portability
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Inspect disk usage, camera distribution, orphaned cache, and Adobe/Lightroom XMP
              sidecars.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {healthStats ? (
          <div className="p-5 flex flex-col gap-4 text-xs">
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 bg-zinc-900/80 border border-zinc-800 rounded-xl">
                <div className="text-zinc-500 text-[11px] uppercase font-bold">Total Library</div>
                <div className="text-lg font-bold text-zinc-100 mt-0.5">
                  {healthStats.total_photos} photos
                </div>
                <div className="text-emerald-400 font-mono text-[11px]">
                  {healthStats.total_library_size_mb} MB
                </div>
              </div>
              <div className="p-3 bg-zinc-900/80 border border-zinc-800 rounded-xl">
                <div className="text-zinc-500 text-[11px] uppercase font-bold">
                  Burst Duplicates
                </div>
                <div className="text-lg font-bold text-amber-300 mt-0.5">
                  {healthStats.duplicate_extras_count} extras
                </div>
                <div className="text-amber-400/80 font-mono text-[11px]">
                  ~{healthStats.duplicate_recoverable_mb} MB
                </div>
              </div>
              <div className="p-3 bg-zinc-900/80 border border-zinc-800 rounded-xl">
                <div className="text-zinc-500 text-[11px] uppercase font-bold">
                  Thumb & Face Cache
                </div>
                <div className="text-lg font-bold text-zinc-100 mt-0.5">
                  {healthStats.cache_files_count} files
                </div>
                <div className="text-zinc-400 font-mono text-[11px]">
                  {healthStats.cache_size_mb} MB ({healthStats.orphaned_cache_count} orphaned)
                </div>
              </div>
            </div>

            {healthStats.damaged_count > 0 && (
              <div className="p-3.5 bg-orange-950/40 border border-orange-500/40 rounded-xl flex flex-col gap-1.5">
                <span className="text-[11px] font-bold text-orange-300 uppercase tracking-wider flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {healthStats.damaged_count} damaged file(s)
                </span>
                <span className="text-zinc-400 text-[11px]">
                  These files are incomplete or corrupt (often an interrupted download). Lumina shows
                  what is present, but you may want to replace them from the original source.
                </span>
                <div className="flex flex-col gap-0.5 font-mono text-[11px] text-zinc-300 max-h-28 overflow-y-auto">
                  {healthStats.damaged_files.map((f) => (
                    <span key={f} className="truncate" title={f}>
                      {f}
                    </span>
                  ))}
                  {healthStats.damaged_count > healthStats.damaged_files.length && (
                    <span className="text-zinc-500">
                      …and {healthStats.damaged_count - healthStats.damaged_files.length} more
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Camera Model Breakdown */}
            <div className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-xl flex flex-col gap-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Top Cameras / Devices
              </span>
              <div className="flex flex-col gap-1.5">
                {healthStats.camera_breakdown.map(([cam, cnt]) => (
                  <div key={cam} className="flex justify-between items-center text-zinc-300">
                    <span className="flex items-center gap-1.5">
                      <Camera className="w-3.5 h-3.5 text-emerald-400" />
                      <span>{cam}</span>
                    </span>
                    <span className="font-mono text-zinc-400">{cnt} photos</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Portability & Cache Maintenance Actions */}
            <div className="flex items-center justify-between gap-3 pt-2">
              <button
                onClick={handlePruneCache}
                className="flex-1 py-2 px-3 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 rounded-xl text-zinc-200 font-medium transition flex items-center justify-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5 text-amber-400" />
                <span>Prune Orphaned Cache ({healthStats.orphaned_cache_count})</span>
              </button>

              <button
                onClick={() => handleExportXmp(false)}
                disabled={isExportingXmp}
                className="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-semibold shadow transition flex items-center justify-center gap-1.5"
              >
                <FileCode className="w-3.5 h-3.5" />
                <span>
                  {isExportingXmp ? "Exporting XMP..." : "Export All XMP Sidecars"}
                </span>
              </button>
            </div>
          </div>
        ) : (
          <div className="p-8 text-center text-xs text-zinc-500">
            Calculating library metrics...
          </div>
        )}
      </div>
    </div>
  );
}
