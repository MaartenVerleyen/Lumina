import { RefObject } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Virtualizer } from "@tanstack/react-virtual";
import { PhotoItem } from "../../types/lumina";
import {
  Crosshair,
  Flag,
  Layers,
  Loader2,
  MapPin,
  Pin,
  Sparkles,
  Star,
  Trophy,
  XCircle,
} from "lucide-react";

interface VirtualPhotoGridProps {
  gridContainerRef: RefObject<HTMLDivElement | null>;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  gridColumns: number;
  cardThumbHeight: number;
  visiblePhotos: PhotoItem[];
  selectedHashes: Set<string>;
  activeHash: string | null;
  analyzingHashes: Set<string>;
  burstGroupCounts: Map<number, number>;
  sharpestInGroup: Map<number, { hash: string; sharpness: number }>;
  showAllBurstVersions: boolean;
  expandedBurstGroups: Set<number>;
  handlePhotoClick: (index: number, hash: string, e: React.MouseEvent) => void;
  setActiveHash: React.Dispatch<React.SetStateAction<string | null>>;
  setIsLoupeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggleBurstGroupExpand: (groupNum: number, e: React.MouseEvent) => void;
  // Optional props for Simple Mode & explicit Right-Click Context Menu callback
  simpleMode?: boolean;
  onPhotoContextMenu?: (photo: PhotoItem, e: React.MouseEvent) => void;
}

export default function VirtualPhotoGrid({
  gridContainerRef,
  rowVirtualizer,
  gridColumns,
  cardThumbHeight,
  visiblePhotos,
  selectedHashes,
  activeHash,
  analyzingHashes,
  burstGroupCounts,
  sharpestInGroup,
  showAllBurstVersions,
  expandedBurstGroups,
  handlePhotoClick,
  setActiveHash,
  setIsLoupeOpen,
  toggleBurstGroupExpand,
  simpleMode = false,
  onPhotoContextMenu,
}: VirtualPhotoGridProps) {
  return (
    <div ref={gridContainerRef} className="flex-1 overflow-y-auto p-4">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const startIndex = virtualRow.index * gridColumns;
          const rowPhotos = visiblePhotos.slice(startIndex, startIndex + gridColumns);

          return (
            <div
              key={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
                gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
              }}
              className="grid gap-3.5 pb-3.5"
            >
              {rowPhotos.map((photo, colIndex) => {
                const globalIndex = startIndex + colIndex;
                const isSelected = selectedHashes.has(photo.hash);
                const isActive = photo.hash === activeHash;
                const isAnalyzingThis = analyzingHashes.has(photo.hash);
                const hasAiData = photo.tags.length > 0 || Boolean(photo.ai_caption);

                const grp = photo.duplicate_group;
                const burstCount = grp ? burstGroupCounts.get(grp) || 1 : 1;
                const isBurstExpanded = grp
                  ? showAllBurstVersions || expandedBurstGroups.has(grp)
                  : false;
                const isSharpestPick = grp && sharpestInGroup.get(grp)?.hash === photo.hash;

                return (
                  <div
                    key={photo.hash}
                    data-photo-hash={photo.hash}
                    onClick={(e) => handlePhotoClick(globalIndex, photo.hash, e)}
                    onContextMenu={(e) => {
                      if (onPhotoContextMenu) {
                        e.preventDefault();
                        e.stopPropagation();
                        onPhotoContextMenu(photo, e);
                      }
                    }}
                    onDoubleClick={() => {
                      setActiveHash(photo.hash);
                      setIsLoupeOpen(true);
                    }}
                    className={`group relative flex flex-col rounded-xl overflow-hidden bg-[#10121a] border transition duration-150 cursor-pointer ${
                      isAnalyzingThis
                        ? "border-indigo-500 ring-2 ring-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.35)]"
                        : isActive
                        ? "border-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.25)] ring-1 ring-emerald-500"
                        : isSelected
                        ? "border-emerald-500/60 bg-emerald-950/15"
                        : isBurstExpanded && grp
                        ? "border-amber-500/60 bg-amber-950/10"
                        : "border-zinc-800/80 hover:border-zinc-600"
                    }`}
                  >
                    {grp && !isBurstExpanded && burstCount > 1 && (
                      <div className="absolute inset-x-2 -top-1 h-2 bg-amber-500/20 border-t border-amber-400/40 rounded-t-xl pointer-events-none z-20" />
                    )}

                    {/* Color Label Corner Ribbon */}
                    {photo.color_label && (
                      <div
                        className={`absolute top-0 right-0 w-3.5 h-3.5 z-20 ${
                          photo.color_label === "red"
                            ? "bg-red-500"
                            : photo.color_label === "yellow"
                            ? "bg-yellow-400"
                            : photo.color_label === "green"
                            ? "bg-emerald-500"
                            : "bg-blue-500"
                        } [clip-path:polygon(100%_0,0_0,100%_100%)]`}
                      />
                    )}

                    <div
                      style={{ height: `${cardThumbHeight}px` }}
                      className="relative w-full bg-zinc-950 flex items-center justify-center overflow-hidden"
                    >
                      {photo.thumb_ready ? (
                        <img
                          src={convertFileSrc(photo.thumb_path)}
                          alt={photo.name}
                          decoding="async"
                          draggable={false}
                          style={
                            photo.rotation
                              ? { transform: `rotate(${photo.rotation}deg)` }
                              : undefined
                          }
                          className="w-full h-full object-cover select-none"
                        />
                      ) : (
                        <span className="text-xs text-zinc-600 animate-pulse">Loading...</span>
                      )}

                      {isAnalyzingThis && (
                        <div className="absolute inset-0 bg-indigo-950/60 backdrop-blur-[2px] flex flex-col items-center justify-center gap-1.5 z-10">
                          <Loader2 className="w-6 h-6 text-indigo-300 animate-spin" />
                          <span className="text-[10px] font-bold text-indigo-200 tracking-wide uppercase">
                            AI Tagging...
                          </span>
                        </div>
                      )}

                      {/* Top-Left Badges */}
                      <div className="absolute top-2 left-2 flex items-center gap-1 z-20">
                        {photo.in_basket && (
                          <span
                            className="p-1 rounded bg-cyan-950/90 border border-cyan-400/60 text-cyan-300 backdrop-blur shadow"
                            title="Pinned to Basket (B)"
                          >
                            <Pin className="w-3 h-3" />
                          </span>
                        )}
                        {photo.flag === "pick" && (
                          <span
                            className="p-1 rounded bg-emerald-950/90 border border-emerald-400/60 text-emerald-400 backdrop-blur shadow"
                            title="Picked (P)"
                          >
                            <Flag className="w-3 h-3" />
                          </span>
                        )}
                        {photo.flag === "reject" && (
                          <span
                            className="p-1 rounded bg-red-950/90 border border-red-500/60 text-red-400 backdrop-blur shadow"
                            title="Rejected (X)"
                          >
                            <XCircle className="w-3 h-3" />
                          </span>
                        )}

                        {photo.staged_target && (
                          <div className="px-1.5 py-0.5 rounded bg-emerald-950/90 border border-emerald-500/40 text-emerald-300 text-[9px] font-mono flex items-center gap-1 backdrop-blur-md">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                            <span>Staged</span>
                          </div>
                        )}

                        {photo.pair_raw_path && (
                          <span
                            className="px-1.5 py-0.5 rounded bg-amber-950/90 border border-amber-500/40 text-amber-300 text-[9px] font-mono font-bold backdrop-blur-md"
                            title={`Linked RAW+JPEG Pair: ${photo.pair_raw_path}`}
                          >
                            RAW+J
                          </span>
                        )}

                        {grp && burstCount > 1 && (
                          <button
                            onClick={(e) => toggleBurstGroupExpand(grp, e)}
                            className={`px-2 py-0.5 rounded-md backdrop-blur-md text-[10px] font-semibold border flex items-center gap-1 transition shadow ${
                              isBurstExpanded
                                ? isSharpestPick
                                  ? "bg-emerald-950/90 text-emerald-300 border-emerald-400/50 hover:bg-emerald-900"
                                  : "bg-amber-950/90 text-amber-300 border-amber-500/50 hover:bg-amber-900"
                                : "bg-amber-500/90 text-zinc-950 border-amber-300 hover:bg-amber-400"
                            }`}
                          >
                            {isBurstExpanded && isSharpestPick ? (
                              <Trophy className="w-3 h-3" />
                            ) : (
                              <Layers className="w-3 h-3" />
                            )}
                            {isBurstExpanded ? (
                              <span>
                                {isSharpestPick ? `Best (#${grp}) ▾` : `Burst #${grp} ▾`}
                              </span>
                            ) : (
                              <span>
                                {burstCount} {simpleMode ? "Similar" : "Burst"} ▸
                              </span>
                            )}
                          </button>
                        )}
                      </div>

                      {/* Star Badge */}
                      {photo.rating > 0 && (
                        <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-md text-amber-400 text-[10px] font-bold flex items-center gap-0.5">
                          <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />
                          <span>{photo.rating}</span>
                        </div>
                      )}

                      {/* Persistent AI & Tag Pills */}
                      {hasAiData && !isAnalyzingThis && (
                        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-1 pointer-events-none">
                          <div className="flex items-center gap-1 overflow-hidden">
                            <span className="px-1.5 py-0.5 rounded bg-indigo-950/90 border border-indigo-500/40 text-indigo-200 text-[9px] font-semibold flex items-center gap-1 shrink-0 backdrop-blur-md">
                              <Sparkles className="w-2.5 h-2.5 text-indigo-400" />
                              <span>{photo.tags.length}</span>
                            </span>
                            {photo.tags.slice(0, 2).map((t) => (
                              <span
                                key={t}
                                className="px-1.5 py-0.5 rounded bg-black/75 text-zinc-200 text-[9px] truncate backdrop-blur-md"
                              >
                                #{t}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="px-2.5 py-1.5 bg-[#10121a] flex items-center justify-between text-[10px] border-t border-zinc-800/50">
                      <span className="truncate font-medium text-zinc-300" title={photo.name}>
                        {photo.name}
                      </span>
                      <span className="font-mono text-zinc-500 shrink-0 ml-1 flex items-center gap-1">
                        {photo.location ? (
                          <>
                            <MapPin className="w-2.5 h-2.5 text-emerald-400" />
                            <span>{photo.location.split(",")[0]}</span>
                          </>
                        ) : !simpleMode && photo.sharpness > 0 ? (
                          <>
                            <span>{photo.sharpness}</span>
                            <Crosshair className="w-2.5 h-2.5 text-zinc-600" />
                          </>
                        ) : null}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
