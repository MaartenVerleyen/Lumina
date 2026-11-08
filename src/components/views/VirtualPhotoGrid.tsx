import { RefObject, memo, useState, type ReactNode } from "react";
import { Virtualizer } from "@tanstack/react-virtual";
import { PhotoItem } from "../../types/lumina";
import { GridLayout, LayoutRow } from "../../utils/gridLayout";
import { thumbSrc } from "../../utils/photoHelpers";
import DateScrubber from "./DateScrubber";
import { hasClosedEyes, isSoftFocus, type CullingSettings } from "../../utils/culling";
import { formatDuration, isVideo } from "../../utils/media";
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
  AlertTriangle,
  ImageOff,
  EyeOff,
  Focus,
  Film,
  Play,
  HardDrive,
  Cloud,
  CloudOff,
  Eye,
} from "lucide-react";
import { useIsOnDevice } from "../../hooks/useOnDevice";
import { allPhotosCanBackUp, allPhotosHasLocal, allPhotosSources } from "../../api";
import { whereabouts } from "../../api/allPhotos";

export type { GridStyle, CardDetails } from "../../settings";
import type { GridStyle, CardDetails } from "../../settings";

// Footer below the image in the square style (the justified style shows the name on hover instead)
export const SQUARE_FOOTER_HEIGHT = 32;

interface VirtualPhotoGridProps {
  gridContainerRef: RefObject<HTMLDivElement | null>;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  layout: GridLayout;
  gridStyle: GridStyle;
  cardDetails: CardDetails;
  visiblePhotos: PhotoItem[];
  selectedHashes: Set<string>;
  activeHash: string | null;
  analyzingHashes: Set<string>;
  burstGroupCounts: Map<number, number>;
  sharpestInGroup: Map<number, { hash: string; sharpness: number }>;
  culling: CullingSettings;
  showAllBurstVersions: boolean;
  expandedBurstGroups: Set<number>;
  handlePhotoClick: (index: number, hash: string, e: React.MouseEvent) => void;
  setActiveHash: React.Dispatch<React.SetStateAction<string | null>>;
  setIsLoupeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggleBurstGroupExpand: (groupNum: number, e: React.MouseEvent) => void;
  simpleMode?: boolean;
  onPhotoContextMenu?: (photo: PhotoItem, e: React.MouseEvent) => void;
  // Start of a possible drag (see usePhotoDrag)
  onCardPointerDown?: (hash: string, e: React.PointerEvent) => void;
}

// The month of the photos at the top of the viewport, for the floating date label. Hidden while that
// month's own header is still on screen.
function currentHeaderLabel(rows: LayoutRow[], scrollTop: number): string | null {
  let header: LayoutRow | null = null;
  for (const row of rows) {
    if (row.top > scrollTop) break;
    if (row.kind === "header") header = row;
  }
  if (!header || header.top + header.height > scrollTop) return null;
  return header.kind === "header" ? header.label : null;
}

export default function VirtualPhotoGrid({
  gridContainerRef,
  rowVirtualizer,
  layout,
  gridStyle,
  cardDetails,
  visiblePhotos,
  selectedHashes,
  activeHash,
  analyzingHashes,
  burstGroupCounts,
  sharpestInGroup,
  culling,
  showAllBurstVersions,
  expandedBurstGroups,
  handlePhotoClick,
  setActiveHash,
  setIsLoupeOpen,
  toggleBurstGroupExpand,
  simpleMode = false,
  onPhotoContextMenu,
  onCardPointerDown,
}: VirtualPhotoGridProps) {
  // Thumbnails that failed to load (file deleted or cache cleared) show a placeholder instead of a broken image.
  // Kept by URL, not by path: a server's thumb_path is the same in its own library and in All photos, and a
  // URL made for the wrong engine while the open library changes must not hide the right one.
  const [failedThumbs, setFailedThumbs] = useState<Set<string>>(() => new Set());
  const onThumbError = (src: string) =>
    setFailedThumbs((prev) => new Set(prev).add(src));

  const hasHeaders = layout.rows.some((r) => r.kind === "header");
  const floatingLabel = hasHeaders ? currentHeaderLabel(layout.rows, rowVirtualizer.scrollOffset ?? 0) : null;

  return (
    // The wrapper holds the date scrubber in place over the scrolling grid
    <div className="flex-1 min-h-0 relative flex flex-col">
      <div ref={gridContainerRef} className="flex-1 overflow-y-auto p-4">
        {floatingLabel && (
          // Sticky month label: zero-height so it never shifts the grid
          <div className="sticky top-0 z-30 h-0 pointer-events-none">
            <span className="inline-block -mt-2 px-3 py-1 rounded-full bg-raised/90 border border-zinc-700/70 text-xs font-semibold text-zinc-200 shadow-lg backdrop-blur-md">
              {floatingLabel}
            </span>
          </div>
        )}
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label="Photos"
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = layout.rows[virtualRow.index];
            if (!row) return null;
            if (row.kind === "header") {
              return (
                <div
                  key={row.key}
                  role="presentation"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${row.height}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="flex items-end pb-2.5"
                >
                  <h3 className="text-sm font-semibold text-zinc-200">{row.label}</h3>
                </div>
              );
            }
            return (
              <div
                key={row.key}
                role="presentation"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${row.height}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.items.map((item) => {
                  const photo = visiblePhotos[item.index];
                  if (!photo) return null;
                  const grp = photo.duplicate_group;
                  return (
                    <PhotoCard
                      key={photo.hash}
                      photo={photo}
                      index={item.index}
                      left={item.x}
                      width={item.width}
                      height={row.height}
                      gridStyle={gridStyle}
                      cardDetails={cardDetails}
                      isSelected={selectedHashes.has(photo.hash)}
                      isActive={photo.hash === activeHash}
                      isAnalyzing={analyzingHashes.has(photo.hash)}
                      burstCount={grp ? burstGroupCounts.get(grp) || 1 : 1}
                      isBurstExpanded={grp ? showAllBurstVersions || expandedBurstGroups.has(grp) : false}
                      isSharpestPick={Boolean(grp && sharpestInGroup.get(grp)?.hash === photo.hash)}
                      eyesClosed={hasClosedEyes(photo, culling)}
                      softFocus={isSoftFocus(photo, culling)}
                      thumbFailed={failedThumbs.has(thumbSrc(photo))}
                      simpleMode={simpleMode}
                      handlePhotoClick={handlePhotoClick}
                      setActiveHash={setActiveHash}
                      setIsLoupeOpen={setIsLoupeOpen}
                      toggleBurstGroupExpand={toggleBurstGroupExpand}
                      onPhotoContextMenu={onPhotoContextMenu}
                      onCardPointerDown={onCardPointerDown}
                      onThumbError={onThumbError}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {hasHeaders && (
        <DateScrubber rows={layout.rows} scrollRef={gridContainerRef} scrollTop={rowVirtualizer.scrollOffset ?? 0} />
      )}
    </div>
  );
}

interface PhotoCardProps {
  photo: PhotoItem;
  index: number;
  left: number;
  width: number;
  height: number;
  gridStyle: GridStyle;
  cardDetails: CardDetails;
  isSelected: boolean;
  isActive: boolean;
  isAnalyzing: boolean;
  burstCount: number;
  isBurstExpanded: boolean;
  isSharpestPick: boolean;
  eyesClosed: boolean;
  softFocus: boolean;
  thumbFailed: boolean;
  simpleMode: boolean;
  handlePhotoClick: (index: number, hash: string, e: React.MouseEvent) => void;
  setActiveHash: React.Dispatch<React.SetStateAction<string | null>>;
  setIsLoupeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggleBurstGroupExpand: (groupNum: number, e: React.MouseEvent) => void;
  onPhotoContextMenu?: (photo: PhotoItem, e: React.MouseEvent) => void;
  onCardPointerDown?: (hash: string, e: React.PointerEvent) => void;
  onThumbError: (src: string) => void;
}

const PhotoCard = memo(function PhotoCard({
  photo,
  index,
  left,
  width,
  height,
  gridStyle,
  cardDetails,
  isSelected,
  isActive,
  isAnalyzing,
  burstCount,
  isBurstExpanded,
  isSharpestPick,
  eyesClosed,
  softFocus,
  thumbFailed,
  simpleMode,
  handlePhotoClick,
  setActiveHash,
  setIsLoupeOpen,
  toggleBurstGroupExpand,
  onPhotoContextMenu,
  onCardPointerDown,
  onThumbError,
}: PhotoCardProps) {
  const grp = photo.duplicate_group;
  const justified = gridStyle === "justified";
  const imageHeight = justified ? height : height - SQUARE_FOOTER_HEIGHT;
  const hasAiData = photo.tags.length > 0 || Boolean(photo.ai_caption);
  const quarterTurn = photo.rotation === 90 || photo.rotation === 270;
  const video = isVideo(photo);
  // "On hover" card details: secondary badges appear on hover, and always on the selected/active photo
  const secondary =
    cardDetails === "hover" && !isSelected && !isActive
      ? "opacity-0 group-hover:opacity-100 transition-opacity duration-150"
      : "";

  return (
    <div
      data-photo-hash={photo.hash}
      role="option"
      aria-selected={isSelected}
      aria-label={photo.name}
      tabIndex={isActive ? 0 : -1}
      onClick={(e) => handlePhotoClick(index, photo.hash, e)}
      onPointerDown={(e) => onCardPointerDown?.(photo.hash, e)}
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
      style={{ position: "absolute", left, top: 0, width, height }}
      className={`group flex flex-col overflow-hidden bg-card border transition duration-150 cursor-pointer ${
        justified ? "rounded-lg" : "rounded-xl"
      } ${
        isAnalyzing
          ? "border-zinc-700 ring-2 ring-zinc-500"
          : isActive
          ? "border-emerald-500 ring-1 ring-emerald-500"
          : isSelected
          ? "border-emerald-500/60 bg-emerald-950/15"
          : isBurstExpanded && grp
          ? "border-amber-500/60 bg-amber-950/10"
          : justified
          ? "border-transparent hover:border-zinc-600"
          : "border-zinc-800/80 hover:border-zinc-600"
      }`}
    >
      {grp && !isBurstExpanded && burstCount > 1 && (
        <div className="absolute inset-x-2 -top-1 h-2 bg-white/5 border-t border-white/15 rounded-t-xl pointer-events-none z-20" />
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
        style={{ height: `${imageHeight}px` }}
        className="relative w-full bg-zinc-950 flex items-center justify-center overflow-hidden shrink-0"
      >
        {photo.thumb_ready && thumbFailed ? (
          <span className="flex flex-col items-center gap-1 text-[11px] text-zinc-600">
            <ImageOff className="w-5 h-5" />
            Preview unavailable
          </span>
        ) : photo.thumb_ready ? (
          <img
            src={thumbSrc(photo)}
            alt={photo.name}
            decoding="async"
            draggable={false}
            onError={() => onThumbError(thumbSrc(photo))}
            style={
              quarterTurn
                ? {
                    // Rotated a quarter turn: lay the image out in the swapped box so it still fills the card
                    width: `${imageHeight}px`,
                    height: `${width}px`,
                    maxWidth: "none",
                    flexShrink: 0,
                    transform: `rotate(${photo.rotation}deg)`,
                  }
                : photo.rotation
                ? { transform: `rotate(${photo.rotation}deg)` }
                : undefined
            }
            className={`object-cover select-none ${quarterTurn ? "" : "w-full h-full"}`}
          />
        ) : video ? (
          // A video without a frame yet (or one Windows can't decode): a still placeholder, not a skeleton
          <span className="flex flex-col items-center gap-1 text-[11px] text-zinc-600">
            <Film className="w-6 h-6" />
          </span>
        ) : (
          // Skeleton while the thumbnail is being made
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 via-zinc-800/60 to-zinc-900 animate-pulse" />
        )}

        {video && (
          <>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="w-9 h-9 rounded-full bg-black/55 border border-white/25 backdrop-blur-sm flex items-center justify-center shadow">
                <Play className="w-4 h-4 text-white fill-white ml-0.5" />
              </span>
            </div>
            {photo.duration_ms != null && (
              <span className="absolute bottom-2 right-2 z-20 px-1.5 py-0.5 rounded bg-black/75 text-white text-[11px] font-mono font-semibold backdrop-blur-md pointer-events-none">
                {formatDuration(photo.duration_ms)}
              </span>
            )}
          </>
        )}

        {isAnalyzing && (
          <div className="absolute inset-0 bg-zinc-800/80 backdrop-blur-[2px] flex flex-col items-center justify-center gap-1.5 z-10">
            <Loader2 className="w-6 h-6 text-zinc-400 animate-spin" />
            <span className="text-xs font-medium text-zinc-200">AI tagging…</span>
          </div>
        )}

        {/* Top-Left Badges */}
        <div className="absolute top-2 left-2 flex items-center gap-1 z-20 flex-wrap">
          <OnDeviceBadge hash={photo.hash} />
          {photo.copies && <WhereBadge photo={photo} />}
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
            <div
              className="px-1.5 py-0.5 rounded bg-emerald-950/90 border border-emerald-500/40 text-emerald-300 text-[11px] font-mono flex items-center gap-1 backdrop-blur-md"
              title={`Staged to move to ${photo.staged_target}`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span>Staged</span>
            </div>
          )}

          {photo.pair_raw_path && (
            <span
              className={`px-1.5 py-0.5 rounded bg-amber-950/90 border border-amber-500/40 text-amber-300 text-[11px] font-mono font-semibold backdrop-blur-md ${secondary}`}
              title={`Linked RAW+JPEG Pair: ${photo.pair_raw_path}`}
            >
              RAW+J
            </span>
          )}

          {photo.live_video_hash && (
            <span
              className={`px-1.5 py-0.5 rounded bg-black/70 border border-white/30 text-white text-[11px] font-semibold tracking-wide backdrop-blur-md ${secondary}`}
              title="Live Photo: open it and hover LIVE (or hold L) to play its clip"
            >
              LIVE
            </span>
          )}

          {eyesClosed && (
            <span
              className="p-1 rounded bg-rose-950/90 border border-rose-400/60 text-rose-300 backdrop-blur shadow"
              title="Eyes closed: someone in this photo seems to blink"
            >
              <EyeOff className="w-3 h-3" />
            </span>
          )}
          {softFocus && (
            <span
              className="p-1 rounded bg-orange-950/90 border border-orange-400/60 text-orange-300 backdrop-blur shadow"
              title="Soft focus: the main face is not sharp"
            >
              <Focus className="w-3 h-3" />
            </span>
          )}

          {photo.damaged && (
            <span
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-950/90 border border-orange-500/50 text-orange-300 text-[11px] font-mono font-semibold backdrop-blur-md"
              title="Damaged file: it is incomplete or corrupt (for example an interrupted download). The preview shows only the data that is present. Replace it from the original source if you can."
            >
              <AlertTriangle className="w-3 h-3" />
              Damaged
            </span>
          )}

          {grp && burstCount > 1 && (
            <button
              onClick={(e) => toggleBurstGroupExpand(grp, e)}
              className={`px-2 py-0.5 rounded-md backdrop-blur-md text-[11px] font-semibold border flex items-center gap-1 transition-colors ${
                isBurstExpanded
                  ? isSharpestPick
                    ? "bg-emerald-950/90 text-emerald-300 border-emerald-400/50 hover:bg-emerald-900"
                    : "bg-black/70 text-zinc-200 border-white/10 hover:bg-zinc-800"
                  : "bg-black/70 text-zinc-100 border-white/10 hover:bg-zinc-800"
              }`}
            >
              {isBurstExpanded && isSharpestPick ? <Trophy className="w-3 h-3" /> : <Layers className="w-3 h-3" />}
              {isBurstExpanded ? (
                <span>{isSharpestPick ? `Best of burst ${grp}` : `Burst ${grp}`}</span>
              ) : (
                <span>
                  {burstCount} {simpleMode ? "similar" : "in burst"}
                </span>
              )}
            </button>
          )}
        </div>

        {/* Star Badge */}
        {photo.rating > 0 && (
          <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-md text-amber-400 text-[11px] font-semibold flex items-center gap-0.5 z-20">
            <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />
            <span>{photo.rating}</span>
          </div>
        )}

        {/* AI & Tag Pills */}
        {hasAiData && !isAnalyzing && !justified && (
          <div className={`absolute bottom-2 left-2 right-2 flex items-center gap-1 overflow-hidden pointer-events-none ${secondary}`}>
            <span className="px-1.5 py-0.5 rounded bg-zinc-800/80 border border-zinc-700 text-zinc-200 text-[11px] font-semibold flex items-center gap-1 shrink-0 backdrop-blur-md">
              <Sparkles className="w-2.5 h-2.5 text-zinc-400" />
              <span>{photo.tags.length}</span>
            </span>
            {photo.tags.slice(0, 2).map((t) => (
              <span key={t} className="px-1.5 py-0.5 rounded bg-black/75 text-zinc-200 text-[11px] truncate backdrop-blur-md">
                #{t}
              </span>
            ))}
          </div>
        )}

        {/* Justified style: name, place and tags fade in over the bottom of the photo */}
        {justified && (
          <div
            className={`absolute inset-x-0 bottom-0 px-2.5 pt-6 pb-1.5 bg-gradient-to-t from-black/85 via-black/45 to-transparent text-[11px] flex items-end justify-between gap-2 pointer-events-none z-10 ${video ? "pr-14" : ""} ${secondary}`}
          >
            <span className="truncate font-medium text-zinc-100">{photo.name}</span>
            <span className="flex items-center gap-1 shrink-0 text-zinc-300">
              {hasAiData && (
                <>
                  <Sparkles className="w-2.5 h-2.5 text-zinc-400" />
                  <span>{photo.tags.length}</span>
                </>
              )}
              {photo.location && (
                <>
                  <MapPin className="w-2.5 h-2.5 text-emerald-400 ml-1" />
                  <span>{photo.location.split(",")[0]}</span>
                </>
              )}
            </span>
          </div>
        )}
      </div>

      {!justified && (
        <div
          style={{ height: `${SQUARE_FOOTER_HEIGHT}px` }}
          className="px-2.5 bg-card flex items-center justify-between text-[11px] border-t border-zinc-800/50 shrink-0"
        >
          <span className="truncate font-medium text-zinc-300" title={photo.name}>
            {photo.name}
          </span>
          <span className={`font-mono text-zinc-500 shrink-0 ml-1 flex items-center gap-1 ${secondary}`}>
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
      )}
    </div>
  );
});

// All photos: where the photo is. A photo in both places, or on this PC with no server to back up to, has no
// mark; one only on a server is marked, and shared photos (read-only) say so.
function WhereBadge({ photo }: { photo: PhotoItem }) {
  const where = whereabouts(photo, allPhotosSources(), allPhotosCanBackUp());
  const mark = (className: string, title: string, icon: ReactNode) => (
    <span className={`p-1 rounded bg-zinc-950/85 border backdrop-blur shadow ${className}`} title={title}>
      {icon}
    </span>
  );
  if (where === "not-backed-up") return mark("border-amber-400/60 text-amber-300", "Not backed up: only on this PC", <CloudOff className="w-3 h-3" />);
  if (where !== "server-only") return null;
  if (!photo.home) return mark("border-violet-400/50 text-violet-300", "Shared with you: you can look, not change", <Eye className="w-3 h-3" />);
  // Without a folder on this PC in the view (the web client) every photo is on the server: no mark
  if (!allPhotosHasLocal()) return null;
  return mark("border-sky-400/50 text-sky-300", "On the server only", <Cloud className="w-3 h-3" />);
}

// A server's photo whose original is on this PC (client mode)
function OnDeviceBadge({ hash }: { hash: string }) {
  if (!useIsOnDevice(hash)) return null;
  return (
    <span className="p-1 rounded bg-zinc-950/85 border border-sky-400/50 text-sky-300 backdrop-blur shadow" title="On this PC">
      <HardDrive className="w-3 h-3" />
    </span>
  );
}
