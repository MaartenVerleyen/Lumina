import { useRef, useMemo } from "react";
import { useWheel } from "../../hooks/useWheel";
import { convertFileSrc } from "@tauri-apps/api/core";
import { PhotoItem, ViewMode } from "../../types/lumina";
import { cullScore, hasClosedEyes, isSoftFocus, DEFAULT_CULLING, type CullingSettings } from "../../utils/culling";
import {
  ChevronLeft,
  ChevronRight,
  Columns,
  EyeOff,
  Focus,
  Star,
  Trophy,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

interface CompareViewProps {
  comparePhotos: PhotoItem[];
  activeHash: string | null;
  setActiveHash: React.Dispatch<React.SetStateAction<string | null>>;
  compareZoom: number;
  setCompareZoom: React.Dispatch<React.SetStateAction<number>>;
  comparePan: { x: number; y: number };
  setComparePan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  photos?: PhotoItem[];
  setSelectedHashes?: React.Dispatch<React.SetStateAction<Set<string>>>;
  setAutoMatchNotice?: (message: string) => void;
  onKeepAndTrashRest: (keepHash: string, otherHashes: string[]) => Promise<void>;
  // How many photos qualified for comparing (only the first 4 are shown)
  compareCandidateCount?: number;
  culling?: CullingSettings;
}

export default function CompareView({
  comparePhotos,
  activeHash,
  setActiveHash,
  compareZoom,
  setCompareZoom,
  comparePan,
  setComparePan,
  setViewMode,
  photos = [],
  setSelectedHashes,
  setAutoMatchNotice,
  onKeepAndTrashRest,
  compareCandidateCount = 0,
  culling = DEFAULT_CULLING,
}: CompareViewProps) {
  const isPanningCompareRef = useRef<boolean>(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  useWheel(canvasRef, (e) => {
    const delta = e.deltaY < 0 ? 0.35 : -0.35;
    setCompareZoom((z) => {
      const next = Math.max(1, Math.min(6, +(z + delta).toFixed(2)));
      if (next === 1) setComparePan({ x: 0, y: 0 });
      return next;
    });
  });
  const hiddenCount = Math.max(0, compareCandidateCount - comparePhotos.length);

  // Identify all unresolved burst groups in the library (groups with >= 2 un-trashed photos and no "pick" chosen yet)
  const unresolvedBurstGroups = useMemo(() => {
    const groups = new Map<number, PhotoItem[]>();
    for (const p of photos) {
      if (!p.duplicate_group || p.subfolder === "_Trash" || p.staged_target === "_Trash") {
        continue;
      }
      const list = groups.get(p.duplicate_group) || [];
      list.push(p);
      groups.set(p.duplicate_group, list);
    }
    const out: { groupId: number; members: PhotoItem[] }[] = [];
    for (const [groupId, members] of Array.from(groups.entries()).sort((a, b) => a[0] - b[0])) {
      if (members.length >= 2) {
        out.push({
          groupId,
          members: [...members].sort((a, b) => cullScore(b, culling) - cullScore(a, culling)),
        });
      }
    }
    return out;
  }, [photos, culling]);

  const currentGroupId = comparePhotos[0]?.duplicate_group ?? null;
  const currentBurstIdx = useMemo(() => {
    if (!currentGroupId) return -1;
    return unresolvedBurstGroups.findIndex((g) => g.groupId === currentGroupId);
  }, [currentGroupId, unresolvedBurstGroups]);

  function jumpToBurstGroup(targetGroup: { groupId: number; members: PhotoItem[] }) {
    const lead = targetGroup.members[0];
    if (!lead) return;
    if (setSelectedHashes) {
      setSelectedHashes(new Set([lead.hash]));
    }
    setActiveHash(lead.hash);
    setCompareZoom(1);
    setComparePan({ x: 0, y: 0 });
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface">
      {/* Synchronized Compare Toolbar */}
      <div className="bg-panel border-b border-zinc-800 px-4 py-2 flex items-center justify-between text-xs gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-emerald-300 flex items-center gap-1.5">
            <Columns className="w-4 h-4 text-emerald-400" />
            <span>Synchronized Compare ({comparePhotos.length} photos)</span>
          </span>
          {hiddenCount > 0 && (
            <span
              className="px-2 py-0.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 text-[11px]"
              title="Compare shows at most 4 photos side by side. Select fewer photos to choose which ones."
            >
              +{hiddenCount} more not shown
            </span>
          )}

          {currentBurstIdx >= 0 && unresolvedBurstGroups.length > 0 && (
            <div className="flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/30 text-amber-300 px-2.5 py-0.5 rounded-lg font-mono text-[11px]">
              <span>
                Burst #{currentGroupId} ({currentBurstIdx + 1} of {unresolvedBurstGroups.length} remaining)
              </span>
              <button
                onClick={() => {
                  const prev =
                    unresolvedBurstGroups[
                      (currentBurstIdx - 1 + unresolvedBurstGroups.length) %
                        unresolvedBurstGroups.length
                    ];
                  if (prev) jumpToBurstGroup(prev);
                }}
                className="p-0.5 hover:bg-amber-500/20 rounded"
                title="Previous Burst Group"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  const next =
                    unresolvedBurstGroups[
                      (currentBurstIdx + 1) % unresolvedBurstGroups.length
                    ];
                  if (next) jumpToBurstGroup(next);
                }}
                className="p-0.5 hover:bg-amber-500/20 rounded"
                title="Skip to Next Burst Group"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <span className="text-zinc-500 hidden xl:inline">
            Scroll wheel or click +/- to zoom all • Drag any image to pan all simultaneously
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setCompareZoom((z) => Math.max(1, +(z - 0.5).toFixed(1)))}
            className="p-1.5 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 text-zinc-300"
            aria-label="Zoom out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="font-mono text-zinc-300 w-12 text-center">
            {Math.round(compareZoom * 100)}%
          </span>
          <button
            onClick={() => setCompareZoom((z) => Math.min(6, +(z + 0.5).toFixed(1)))}
            className="p-1.5 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 text-zinc-300"
            aria-label="Zoom in"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              setCompareZoom(1);
              setComparePan({ x: 0, y: 0 });
            }}
            className="px-2.5 py-1 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 text-zinc-400 hover:text-white"
          >
            Reset 100%
          </button>
          <button
            onClick={() => setViewMode("grid")}
            className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded font-medium ml-2"
          >
            Exit Compare (C)
          </button>
        </div>
      </div>

      {/* Multi-Pane Synchronized Canvas */}
      <div
        ref={canvasRef}
        onMouseDown={(e) => {
          if (compareZoom <= 1) return;
          isPanningCompareRef.current = true;
          panStartRef.current = { x: e.clientX - comparePan.x, y: e.clientY - comparePan.y };
        }}
        onMouseMove={(e) => {
          if (!isPanningCompareRef.current) return;
          setComparePan({
            x: e.clientX - panStartRef.current.x,
            y: e.clientY - panStartRef.current.y,
          });
        }}
        onMouseUp={() => {
          isPanningCompareRef.current = false;
        }}
        onMouseLeave={() => {
          isPanningCompareRef.current = false;
        }}
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, comparePhotos.length)}, minmax(0, 1fr))`,
        }}
        className="flex-1 grid gap-2 p-3 overflow-hidden select-none cursor-grab active:cursor-grabbing"
      >
        {comparePhotos.map((cp) => {
          const isActive = cp.hash === activeHash;
          return (
            <div
              key={cp.hash}
              onClick={() => setActiveHash(cp.hash)}
              className={`relative flex flex-col rounded-xl overflow-hidden bg-zinc-950 border transition ${
                isActive ? "border-emerald-500 ring-1 ring-emerald-500" : "border-zinc-800"
              }`}
            >
              <div className="flex-1 relative overflow-hidden flex items-center justify-center">
                <img
                  src={convertFileSrc(cp.path)}
                  alt={cp.name}
                  draggable={false}
                  style={{
                    transform: `translate(${comparePan.x}px, ${comparePan.y}px) scale(${compareZoom}) rotate(${cp.rotation}deg)`,
                    transformOrigin: "center center",
                  }}
                  className="max-w-full max-h-full object-contain pointer-events-none transition-transform duration-75"
                />
              </div>

              {/* Compare Card Bottom Bar */}
              <div className="p-2.5 bg-card border-t border-zinc-800 flex items-center justify-between text-xs z-10">
                <div className="truncate">
                  <div className="font-semibold text-zinc-200 truncate">{cp.name}</div>
                  <div className="text-[11px] font-mono text-emerald-400 flex items-center gap-1.5">
                    <span>Focus Score: {cp.sharpness}</span>
                    {hasClosedEyes(cp, culling) && (
                      <span className="inline-flex items-center gap-0.5 text-rose-300">
                        • <EyeOff className="w-3 h-3" /> Eyes closed
                      </span>
                    )}
                    {isSoftFocus(cp, culling) && (
                      <span className="inline-flex items-center gap-0.5 text-orange-300">
                        • <Focus className="w-3 h-3" /> Soft face
                      </span>
                    )}
                    {cp.rating > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-amber-400">
                        • <Star className="w-3 h-3 fill-amber-400" /> {cp.rating}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      // Find the next unresolved burst group BEFORE updating state
                      const remainingGroups = unresolvedBurstGroups.filter(
                        (g) => g.groupId !== currentGroupId
                      );
                      const nextGroup =
                        remainingGroups.find((g) => g.groupId > (currentGroupId ?? 0)) ||
                        remainingGroups[0] ||
                        null;

                      const others = comparePhotos.filter((o) => o.hash !== cp.hash);
                      try {
                        // Undo-aware (one Ctrl+Z step) and RAW+JPEG pair aware
                        await onKeepAndTrashRest(
                          cp.hash,
                          others.map((o) => o.hash)
                        );
                      } catch {
                        return; // error already shown by the handler; don't auto-advance
                      }

                      // Auto-advance to the next burst group if we were comparing a burst!
                      if (currentGroupId && nextGroup && nextGroup.members.length > 0) {
                        jumpToBurstGroup(nextGroup);
                        if (setAutoMatchNotice) {
                          setAutoMatchNotice(
                            `Kept "${cp.name}" • Auto-advanced to Burst #${nextGroup.groupId} (${remainingGroups.length} remaining)`
                          );
                        }
                      } else {
                        if (setSelectedHashes) {
                          setSelectedHashes(new Set([cp.hash]));
                        }
                        setActiveHash(cp.hash);
                        setViewMode("grid");
                        if (setAutoMatchNotice) {
                          setAutoMatchNotice(
                            currentGroupId
                              ? `Kept "${cp.name}" — All burst groups resolved!`
                              : `Kept "${cp.name}" and staged ${others.length} other photo(s) for _Trash.`
                          );
                        }
                      }
                    }}
                    className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-semibold shadow transition flex items-center gap-1.5"
                    title="Keep this photo as Pick, stage the rest for _Trash, and auto-advance to the next burst group"
                  >
                    <Trophy className="w-3.5 h-3.5" />
                    <span>Keep This & Trash Rest</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
