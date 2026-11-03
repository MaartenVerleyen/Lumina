import { thumbSrc } from "../../utils/photoHelpers";
import { platform } from "../../api/platform";
import { useState, useRef, useEffect } from "react";
import { call, mediaUrl } from "../../api";
import { useAccess } from "../auth/ServerGate";
import { diskPathOf } from "../../utils/rawPairs";
import { isVideo } from "../../utils/media";
import LoupeVideo from "./LoupeVideo";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { useWheel } from "../../hooks/useWheel";
import { PhotoItem } from "../../types/lumina";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Eye,
  Film,
  Flag,
  Folder,
  Pin,
  RotateCcw as RotateLeft,
  RotateCw,
  Sparkles,
  Star,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

interface LoupeModalProps {
  isOpen: boolean;
  onClose: () => void;
  activePhoto: PhotoItem | null;
  autoAdvance: boolean;
  navigateByOffset: (offset: number, extendSelection: boolean) => void;
  handleSetFlag: (flag: "pick" | "reject" | null) => Promise<void>;
  handleBatchStageMove: (targetSub: string | null) => Promise<void>;
  handleBatchRate: (rating: number) => Promise<void>;
  handleRotateSelection: (deltaDegrees: number) => Promise<void>;
  handleAiAnalyzeSingle: () => Promise<void>;
  // Optional props for filmstrip & direct callbacks
  visiblePhotos?: PhotoItem[];
  setActiveHash?: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedHashes?: React.Dispatch<React.SetStateAction<Set<string>>>;
  handleSetColorLabel?: (color: "red" | "yellow" | "green" | "blue" | null) => Promise<void>;
  handleToggleBasketSelection?: () => Promise<void>;
}

export default function LoupeModal({
  isOpen,
  onClose,
  activePhoto,
  autoAdvance,
  navigateByOffset,
  handleSetFlag,
  handleBatchStageMove,
  handleBatchRate,
  handleRotateSelection,
  handleAiAnalyzeSingle,
  visiblePhotos = [],
  setActiveHash,
  setSelectedHashes,
  handleSetColorLabel,
  handleToggleBasketSelection,
}: LoupeModalProps) {
  const access = useAccess();
  const [loupeZoom, setLoupeZoom] = useState<number>(1);
  const [loupePan, setLoupePan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isMovePopoverOpen, setIsMovePopoverOpen] = useState<boolean>(false);
  const [moveTargetInput, setMoveTargetInput] = useState<string>("");
  const [localColor, setLocalColor] = useState<"red" | "yellow" | "green" | "blue" | null>(null);
  const [localBasket, setLocalBasket] = useState<boolean>(false);
  // A Live Photo's clip plays over the photo while LIVE is hovered or L is held
  const [livePlaying, setLivePlaying] = useState<boolean>(false);

  const isPanningRef = useRef<boolean>(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // A drag that ends over the backdrop fires a click there: it must not close the Loupe
  const didPanRef = useRef<boolean>(false);
  const isVisible = isOpen && Boolean(activePhoto);
  const video = activePhoto ? isVideo(activePhoto) : false;
  const dialogRef = useDialogFocus<HTMLDivElement>(isVisible);
  useWheel(
    dialogRef,
    (e) => {
      const delta = e.deltaY < 0 ? 0.35 : -0.35;
      setLoupeZoom((z) => {
        const next = Math.max(1, Math.min(6, +(z + delta).toFixed(2)));
        if (next === 1) setLoupePan({ x: 0, y: 0 });
        return next;
      });
    },
    // A video keeps the wheel for its own controls (volume); zoom is for photos
    isVisible && !video
  );

  const liveClip = activePhoto?.live_video_path ?? null;
  useEffect(() => {
    if (!isVisible || !liveClip) return;
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "l" && !e.repeat) setLivePlaying(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "l") setLivePlaying(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [isVisible, liveClip]);

  useEffect(() => {
    setLivePlaying(false);
    setLoupeZoom(1);
    setLoupePan({ x: 0, y: 0 });
    setIsMovePopoverOpen(false);
    setLocalColor(activePhoto?.color_label ?? null);
    setLocalBasket(activePhoto?.in_basket ?? false);
  }, [activePhoto?.hash, activePhoto?.color_label, activePhoto?.in_basket, isOpen]);

  if (!isOpen || !activePhoto) return null;

  const currentIdx =
    visiblePhotos.length > 0
      ? visiblePhotos.findIndex((p) => p.hash === activePhoto.hash)
      : -1;
  const stripStart = currentIdx >= 0 ? Math.max(0, currentIdx - 6) : 0;
  const stripEnd =
    currentIdx >= 0 ? Math.min(visiblePhotos.length, stripStart + 13) : 0;
  const filmstripPhotos =
    visiblePhotos.length > 1 ? visiblePhotos.slice(stripStart, stripEnd) : [];

  async function onColorSelect(color: "red" | "yellow" | "green" | "blue" | null) {
    if (!activePhoto) return;
    const nextColor = localColor === color ? null : color;
    setLocalColor(nextColor);
    if (handleSetColorLabel) {
      await handleSetColorLabel(nextColor);
    } else {
      await call("set_photo_color_label", {
        hashes: [activePhoto.hash],
        color: nextColor,
      });
    }
  }

  async function onToggleBasket() {
    if (!activePhoto) return;
    const nextBasket = !localBasket;
    setLocalBasket(nextBasket);
    if (handleToggleBasketSelection) {
      await handleToggleBasketSelection();
    } else {
      await call("set_photo_basket", {
        hashes: [activePhoto.hash],
        inBasket: nextBasket,
      });
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Loupe: ${activePhoto.name}`}
      tabIndex={-1}
      onClick={() => {
        if (didPanRef.current) {
          didPanRef.current = false;
          return;
        }
        onClose();
      }}
      onMouseDown={(e) => {
        didPanRef.current = false;
        if (loupeZoom <= 1 || video) return;
        isPanningRef.current = true;
        panStartRef.current = {
          x: e.clientX - loupePan.x,
          y: e.clientY - loupePan.y,
        };
      }}
      onMouseMove={(e) => {
        if (!isPanningRef.current) return;
        didPanRef.current = true;
        setLoupePan({
          x: e.clientX - panStartRef.current.x,
          y: e.clientY - panStartRef.current.y,
        });
      }}
      onMouseUp={() => {
        isPanningRef.current = false;
      }}
      onMouseLeave={() => {
        isPanningRef.current = false;
      }}
      className="fixed inset-0 z-[9999] bg-black/95 backdrop-blur-md flex flex-col items-center justify-between p-6 select-none overflow-hidden"
    >
      {/* Top Bar inside Loupe: Photo Info, Zoom Controls, External Actions & Close */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full flex items-center justify-between z-50 px-2"
      >
        <div className="flex items-center gap-2.5 bg-zinc-900/90 border border-zinc-800 px-3.5 py-1.5 rounded-xl text-xs text-zinc-300">
          <span className="font-semibold text-zinc-100">{activePhoto.name}</span>
          {currentIdx >= 0 && (
            <span className="text-zinc-500 font-mono">
              ({currentIdx + 1} / {visiblePhotos.length})
            </span>
          )}
          {activePhoto.captured_at && (
            <span className="text-zinc-500 font-mono border-l border-zinc-800 pl-2.5">
              {activePhoto.captured_at.split(" ")[0].replace(/:/g, "-")}
            </span>
          )}
          {!video && activePhoto.focal_length && (
            <span className="text-emerald-400 font-mono border-l border-zinc-800 pl-2.5">
              {activePhoto.focal_length} {activePhoto.aperture || ""}{" "}
              {activePhoto.shutter_speed || ""} {activePhoto.iso || ""}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Open External & Reveal in Explorer (files on this computer only) */}
          {platform.localFiles && (
          <div className="flex items-center gap-1 bg-zinc-900/90 border border-zinc-800 px-2 py-1 rounded-xl text-xs">
            <button
              onClick={() => call("open_in_default_app", { path: diskPathOf(activePhoto) })}
              className="px-2 py-0.5 hover:bg-zinc-800 rounded text-zinc-300 hover:text-white flex items-center gap-1 transition"
              title="Open in Default OS Photo Viewer / Editor"
            >
              <Eye className="w-3.5 h-3.5 text-emerald-400" />
              <span>Open External</span>
            </button>
            <button
              onClick={() => call("reveal_in_file_manager", { path: diskPathOf(activePhoto) })}
              className="px-2 py-0.5 hover:bg-zinc-800 rounded text-zinc-300 hover:text-white flex items-center gap-1 transition"
              title="Reveal File in Windows Explorer / Finder"
            >
              <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
              <span>Explorer</span>
            </button>
          </div>
          )}

          {/* Zoom Controls (photos only: a video has its own player controls) */}
          <div
            className={`flex items-center gap-1.5 bg-zinc-900/90 border border-zinc-800 px-2.5 py-1 rounded-xl text-xs ${
              video ? "hidden" : ""
            }`}
          >
            <button
              onClick={() => {
                setLoupeZoom((z) => {
                  const next = Math.max(1, +(z - 0.5).toFixed(1));
                  if (next === 1) setLoupePan({ x: 0, y: 0 });
                  return next;
                });
              }}
              className="p-1 hover:bg-zinc-800 rounded text-zinc-300"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="font-mono text-zinc-200 w-12 text-center">
              {Math.round(loupeZoom * 100)}%
            </span>
            <button
              onClick={() => setLoupeZoom((z) => Math.min(6, +(z + 0.5).toFixed(1)))}
              className="p-1 hover:bg-zinc-800 rounded text-zinc-300"
              title="Zoom In (or use Mouse Wheel)"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            {loupeZoom > 1 && (
              <button
                onClick={() => {
                  setLoupeZoom(1);
                  setLoupePan({ x: 0, y: 0 });
                }}
                className="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[11px]"
              >
                Reset
              </button>
            )}
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-full bg-zinc-900/90 hover:bg-zinc-800 text-zinc-300 border border-zinc-700/60"
            title="Close (Space or Esc)"
            aria-label="Close Loupe"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Zoomable Image Canvas */}
      <div className="relative flex-1 w-full flex items-center justify-center overflow-hidden my-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigateByOffset(-1, false);
          }}
          className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/60 transition shadow-xl z-40"
          title="Previous (Left Arrow)"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>

        {liveClip && !video && (
          <button
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={() => setLivePlaying(true)}
            onMouseLeave={() => setLivePlaying(false)}
            className={`absolute top-3 left-1/2 -translate-x-1/2 z-40 px-3 py-1 rounded-full text-[11px] font-bold tracking-widest border backdrop-blur transition ${
              livePlaying ? "bg-white text-black border-white" : "bg-black/60 text-white border-white/30 hover:bg-black/80"
            }`}
            title="Hover (or hold L) to play the Live Photo"
          >
            LIVE
          </button>
        )}
        {video ? (
          <LoupeVideo photo={activePhoto} />
        ) : liveClip && livePlaying ? (
          <video
            src={mediaUrl({ kind: "original", hash: activePhoto.live_video_hash ?? "", path: liveClip })}
            autoPlay
            muted
            loop
            onClick={(e) => e.stopPropagation()}
            style={{ transform: `rotate(${activePhoto.rotation}deg)` }}
            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl"
          />
        ) : (
          <img
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (loupeZoom > 1) {
                setLoupeZoom(1);
                setLoupePan({ x: 0, y: 0 });
              } else {
                setLoupeZoom(2.5);
              }
            }}
            src={mediaUrl({ kind: "original", hash: activePhoto.hash, path: activePhoto.path })}
            alt={activePhoto.name}
            draggable={false}
            style={{
              transform: `translate(${loupePan.x}px, ${loupePan.y}px) scale(${loupeZoom}) rotate(${activePhoto.rotation}deg)`,
              transformOrigin: "center center",
            }}
            className={`max-w-full max-h-full object-contain rounded-xl shadow-2xl transition-transform duration-75 ${
              loupeZoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
            }`}
          />
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            navigateByOffset(1, false);
          }}
          className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/60 transition shadow-xl z-40"
          title="Next (Right Arrow)"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      </div>

      {/* Bottom Dock: Complete Triage Action HUD + Context Filmstrip */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col items-center gap-2.5 z-50 w-full max-w-5xl"
      >
        {/* Optional Stage Move Popover in Fullscreen */}
        {isMovePopoverOpen && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await handleBatchStageMove(moveTargetInput.trim() || null);
              setIsMovePopoverOpen(false);
              setMoveTargetInput("");
            }}
            className="bg-card border border-zinc-700 p-2.5 rounded-xl shadow-2xl flex items-center gap-2 text-xs"
          >
            <Folder className="w-4 h-4 text-emerald-400" />
            <input
              type="text"
              value={moveTargetInput}
              onChange={(e) => setMoveTargetInput(e.target.value)}
              placeholder="Target subfolder (e.g. 2026/Selects)..."
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-zinc-200 w-56 focus:outline-none focus:border-emerald-500"
              autoFocus
            />
            <button
              type="submit"
              className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-semibold"
            >
              Stage
            </button>
            <button
              type="button"
              onClick={() => setIsMovePopoverOpen(false)}
              className="text-zinc-500 hover:text-white px-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
        )}

        {/* Complete Interactive Triage Action HUD (not for those who may only look) */}
        {access.edit && (
        <div className="bg-card/95 border border-zinc-700/70 backdrop-blur-xl px-4 py-2 rounded-2xl flex items-center gap-3 text-xs text-zinc-200 shadow-2xl flex-wrap justify-center">
          {/* Pick / Reject / Unflag */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                handleSetFlag(activePhoto.flag === "pick" ? null : "pick");
                if (autoAdvance) navigateByOffset(1, false);
              }}
              className={`px-2.5 py-1 rounded-lg font-medium flex items-center gap-1.5 transition ${
                activePhoto.flag === "pick"
                  ? "bg-emerald-600 text-white shadow"
                  : "bg-zinc-800 text-zinc-300 hover:text-emerald-300"
              }`}
              title="Pick / Keep (P)"
            >
              <Flag className="w-3.5 h-3.5" />
              <span>Pick (P)</span>
            </button>
            <button
              onClick={() => {
                handleSetFlag("reject");
                handleBatchStageMove("_Trash");
                if (autoAdvance) navigateByOffset(1, false);
              }}
              className={`px-2.5 py-1 rounded-lg font-medium flex items-center gap-1.5 transition ${
                activePhoto.flag === "reject"
                  ? "bg-red-600 text-white shadow"
                  : "bg-zinc-800 hover:bg-red-950/60 text-red-400"
              }`}
              title="Reject & Stage for _Trash (X)"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span>Reject (X)</span>
            </button>
            <button
              onClick={() => handleSetFlag(null)}
              className="px-2 py-1 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-white transition"
              title="Clear Flag (U)"
            >
              Unflag (U)
            </button>
          </div>

          {/* 1-5 Stars + 0★ Clear */}
          <div className="flex items-center gap-1 border-l border-zinc-700 pl-3">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                onClick={() => {
                  handleBatchRate(star);
                  if (autoAdvance) navigateByOffset(1, false);
                }}
                className="p-0.5 hover:scale-110 transition"
                title={`Rate ${star}★`}
              >
                <Star
                  className={`w-4 h-4 ${
                    star <= activePhoto.rating
                      ? "text-amber-400 fill-amber-400"
                      : "text-zinc-600 hover:text-amber-400"
                  }`}
                />
              </button>
            ))}
            {activePhoto.rating > 0 && (
              <button
                onClick={() => handleBatchRate(0)}
                className="text-[11px] text-zinc-500 hover:text-zinc-300 ml-1"
                title="Clear Rating (0)"
              >
                0★
              </button>
            )}
          </div>

          {/* Color Labels (6-9) */}
          <div className="flex items-center gap-1.5 border-l border-zinc-700 pl-3">
            {(["red", "yellow", "green", "blue"] as const).map((color, idx) => (
              <button
                key={color}
                onClick={() => onColorSelect(color)}
                className={`w-3.5 h-3.5 rounded-full transition ${
                  color === "red"
                    ? "bg-red-500"
                    : color === "yellow"
                    ? "bg-yellow-400"
                    : color === "green"
                    ? "bg-emerald-500"
                    : "bg-blue-500"
                } ${
                  localColor === color
                    ? "ring-2 ring-white scale-110"
                    : "opacity-60 hover:opacity-100"
                }`}
                title={`Color Label: ${color} (${idx + 6})`}
              />
            ))}
            {localColor && (
              <button
                onClick={() => onColorSelect(null)}
                className="text-[11px] text-zinc-500 hover:text-zinc-300 ml-0.5"
              >
                Clear
              </button>
            )}
          </div>

          {/* Pinboard Basket & Stage Move */}
          <div className="flex items-center gap-1.5 border-l border-zinc-700 pl-3">
            <button
              onClick={onToggleBasket}
              className={`px-2 py-1 rounded-lg flex items-center gap-1 transition ${
                localBasket
                  ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                  : "bg-zinc-800 text-zinc-300 hover:text-white"
              }`}
              title="Toggle Pinboard Basket (B)"
            >
              <Pin className="w-3.5 h-3.5 text-cyan-400" />
              <span>{localBasket ? "Pinned (B)" : "Pin (B)"}</span>
            </button>

            <button
              onClick={() => {
                setMoveTargetInput(activePhoto.staged_target || "");
                setIsMovePopoverOpen((p) => !p);
              }}
              className={`px-2 py-1 rounded-lg flex items-center gap-1 transition ${
                activePhoto.staged_target
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : "bg-zinc-800 text-zinc-300 hover:text-white"
              }`}
              title="Stage Move to Subfolder"
            >
              <Folder className="w-3.5 h-3.5 text-emerald-400" />
              <span>{activePhoto.staged_target || "Move"}</span>
            </button>
          </div>

          {/* Rotation and AI in Loupe (photos only) */}
          {!video && (
            <>
              <div className="flex items-center gap-1 border-l border-zinc-700 pl-3">
                <button
                  onClick={() => handleRotateSelection(-90)}
                  className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white"
                  title="Rotate Left ([)"
                >
                  <RotateLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleRotateSelection(90)}
                  className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white"
                  title="Rotate Right (])"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* AI Analyze in Loupe */}
              <button
                onClick={handleAiAnalyzeSingle}
                className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-medium shadow"
                title="Run Local AI Vision Analysis (A)"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>AI Tag (A)</span>
              </button>
            </>
          )}
        </div>
        )}

        {/* Bottom Filmstrip Scrubber (when visiblePhotos are provided) */}
        {filmstripPhotos.length > 1 && setActiveHash && setSelectedHashes && (
          <div className="flex items-center gap-1.5 bg-panel/90 border border-zinc-800/80 p-1.5 rounded-xl overflow-x-auto max-w-full">
            {filmstripPhotos.map((fp) => {
              const isCur = fp.hash === activePhoto.hash;
              return (
                <button
                  key={fp.hash}
                  onClick={() => {
                    setActiveHash(fp.hash);
                    setSelectedHashes(new Set([fp.hash]));
                  }}
                  className={`relative w-12 h-12 rounded-lg overflow-hidden shrink-0 border-2 transition ${
                    isCur
                      ? "border-emerald-400 scale-105 shadow-md"
                      : "border-transparent opacity-60 hover:opacity-100"
                  }`}
                >
                  {fp.thumb_ready ? (
                    <img src={thumbSrc(fp)} alt={fp.name} className="w-full h-full object-cover" />
                  ) : isVideo(fp) ? (
                    <span className="w-full h-full flex items-center justify-center bg-zinc-900">
                      <Film className="w-4 h-4 text-zinc-600" />
                    </span>
                  ) : (
                    <img src={mediaUrl({ kind: "original", hash: fp.hash, path: fp.path })} alt={fp.name} className="w-full h-full object-cover" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
