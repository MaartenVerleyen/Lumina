import { thumbSrc } from "../../utils/photoHelpers";
import { fileManager, platform } from "../../api/platform";
import { useState, useRef, useEffect } from "react";
import { call, mediaUrl } from "../../api";
import { useAccess } from "../auth/ServerGate";
import { diskPathOf } from "../../utils/rawPairs";
import { isVideo } from "../../utils/media";
import { shutterLabel } from "../../utils/exposure";
import LoupeVideo from "./LoupeVideo";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { useWheel } from "../../hooks/useWheel";
import { PhotoItem } from "../../types/lumina";
import {
  ChevronLeft,
  ChevronRight,
  Crosshair,
  ExternalLink,
  Eye,
  Film,
  Flag,
  Folder,
  Pin,
  RotateCcw as RotateLeft,
  RotateCw,
  ScanFace,
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
  handleSetFlag: (flag: "pick" | "reject" | null) => Promise<unknown>;
  handleBatchStageMove: (targetSub: string | null) => Promise<unknown>;
  // The X key's action: reject and mark for _Trash in one step (one undo)
  handleRejectToTrash?: () => Promise<unknown>;
  handleBatchRate: (rating: number) => Promise<void>;
  handleRotateSelection: (deltaDegrees: number) => Promise<void>;
  handleAiAnalyzeSingle: () => Promise<void>;
  // Optional props for filmstrip & direct callbacks
  visiblePhotos?: PhotoItem[];
  setActiveHash?: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedHashes?: React.Dispatch<React.SetStateAction<Set<string>>>;
  handleSetColorLabel?: (color: "red" | "yellow" | "green" | "blue" | null) => Promise<void>;
  handleToggleBasketSelection?: () => Promise<unknown>;
  // Face boxes on the photo (F shows or hides them) and naming a face from there: the same face selection and
  // name field as the side panel, so saving goes through the same matching
  faces?: {
    selectedFaceId: string | null;
    setSelectedFaceId: (id: string | null) => void;
    faceNameInput: string;
    setFaceNameInput: (name: string) => void;
    // A box drawn around a face the scan missed (shared with the side panel, which shows it too)
    isDrawingFace: boolean;
    setIsDrawingFace: (on: boolean) => void;
    drawnBox: FaceBox | null;
    setDrawnBox: (box: FaceBox | null) => void;
    handleSaveFaceAndAutomatch: (e: React.FormEvent) => Promise<void>;
    handleClearFace: (faceId: string) => Promise<void>;
    // Names to suggest while typing
    personNames: string[];
  };
}

type FaceBox = { x: number; y: number; w: number; h: number };

const FACES_KEY = "lumina_loupe_faces";

function readShowFaces(): boolean {
  try {
    return localStorage.getItem(FACES_KEY) === "1";
  } catch {
    return false;
  }
}

export default function LoupeModal({
  isOpen,
  onClose,
  activePhoto,
  autoAdvance,
  navigateByOffset,
  handleSetFlag,
  handleBatchStageMove,
  handleRejectToTrash,
  handleBatchRate,
  handleRotateSelection,
  handleAiAnalyzeSingle,
  visiblePhotos = [],
  setActiveHash,
  setSelectedHashes,
  handleSetColorLabel,
  handleToggleBasketSelection,
  faces,
}: LoupeModalProps) {
  const access = useAccess();
  // Face boxes over the photo, remembered between sessions
  const [showFaces, setShowFaces] = useState<boolean>(readShowFaces);
  const toggleFaces = () =>
    setShowFaces((on) => {
      try {
        localStorage.setItem(FACES_KEY, on ? "0" : "1");
      } catch {
        // not remembered: still toggled for now
      }
      return !on;
    });
  // The photo as drawn (zoomed, panned and turned), to turn mouse positions into the photo's own 0..1 coordinates
  const photoWrapRef = useRef<HTMLDivElement>(null);
  // The face whose name field is open (a box was clicked)
  const [namingFaceId, setNamingFaceId] = useState<string | null>(null);
  // The photo's own size and the room it has: the image and its face boxes are drawn at the same fitted size
  const [natural, setNatural] = useState<{ hash: string; w: number; h: number } | null>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
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

  // F shows or hides the face boxes (not while typing a name)
  useEffect(() => {
    if (!isVisible || video) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing || e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      toggleFaces();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isVisible, video]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!isVisible || !el) return;
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isVisible, video]);

  useEffect(() => {
    setNamingFaceId(null);
  }, [activePhoto?.hash, isOpen]);

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

  // The photo fitted into the room it has, never larger than it is (as the image was before it had face boxes)
  const fitted =
    natural && natural.hash === activePhoto.hash && room && room.w > 0 && room.h > 0
      ? (() => {
          const scale = Math.min(room.w / natural.w, room.h / natural.h, 1);
          return { w: Math.round(natural.w * scale), h: Math.round(natural.h * scale) };
        })()
      : null;
  // The face whose name field is open, while it is still on the photo
  const namingFace = namingFaceId ? activePhoto.faces.find((f) => f.face_id === namingFaceId) ?? null : null;
  const canName = access.edit && Boolean(faces);
  const drawing = canName && !video && Boolean(faces?.isDrawingFace);
  // A box drawn and let go of waits for its name
  const drawnReady = canName && !video && Boolean(faces?.drawnBox) && !faces?.isDrawingFace;

  function startDrawing() {
    if (!faces) return;
    faces.setIsDrawingFace(true);
    faces.setDrawnBox(null);
    faces.setSelectedFaceId(null);
    setNamingFaceId(null);
    if (!showFaces) toggleFaces();
  }

  // Drag out a box on the photo. The rotation is in quarter turns, so the photo's on-screen box is still a
  // rectangle: undo the turn to get the photo's own coordinates. The drag follows the mouse outside the photo.
  function onDrawMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const el = photoWrapRef.current;
    if (!faces || !el || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    const turn = (((activePhoto?.rotation ?? 0) % 360) + 360) % 360;
    const at = (clientX: number, clientY: number) => {
      const sx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const sy = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      if (turn === 90) return { x: sy, y: 1 - sx };
      if (turn === 180) return { x: 1 - sx, y: 1 - sy };
      if (turn === 270) return { x: 1 - sy, y: sx };
      return { x: sx, y: sy };
    };
    const start = at(e.clientX, e.clientY);
    let box: FaceBox | null = null;
    const move = (ev: MouseEvent) => {
      const p = at(ev.clientX, ev.clientY);
      box = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      };
      faces.setDrawnBox(box);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      // The click that follows a drag ending over the backdrop must not close the full-screen view
      didPanRef.current = true;
      // A click or a tiny drag is not a box: keep drawing
      if (!box || box.w < 0.01 || box.h < 0.01) {
        faces.setDrawnBox(null);
        return;
      }
      faces.setIsDrawingFace(false);
      faces.setFaceNameInput("");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function cancelDrawn() {
    faces?.setDrawnBox(null);
    faces?.setIsDrawingFace(false);
  }

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
              {shutterLabel(activePhoto.shutter_speed)} {activePhoto.iso || ""}
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
              title={`Show in ${fileManager}`}
            >
              <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
              <span>{fileManager}</span>
            </button>
          </div>
          )}

          {/* Face boxes on or off (photos only: a video's faces come from other frames) */}
          {!video && (
            <button
              onClick={toggleFaces}
              aria-pressed={showFaces}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs transition ${
                showFaces
                  ? "bg-emerald-600/20 border-emerald-500/50 text-emerald-200"
                  : "bg-zinc-900/90 border-zinc-800 text-zinc-300 hover:text-white"
              }`}
              title={access.edit && faces ? "Show or hide face boxes; click a box to name it (F)" : "Show or hide face boxes (F)"}
            >
              <ScanFace className="w-3.5 h-3.5" />
              <span>Faces{activePhoto.faces.length > 0 ? ` (${activePhoto.faces.length})` : ""}</span>
            </button>
          )}
          {!video && canName && (
            <button
              onClick={() => (faces?.isDrawingFace ? cancelDrawn() : startDrawing())}
              aria-pressed={drawing}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs transition ${
                drawing
                  ? "bg-indigo-600/30 border-indigo-500/60 text-indigo-100"
                  : "bg-zinc-900/90 border-zinc-800 text-zinc-300 hover:text-white"
              }`}
              title="Draw a box around a face the scan missed, then name it (Esc stops)"
            >
              <Crosshair className="w-3.5 h-3.5" />
              <span>{drawing ? "Drag over a face…" : "Draw a face"}</span>
            </button>
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
      <div ref={canvasRef} className="relative flex-1 w-full flex items-center justify-center overflow-hidden my-2">
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
            className={`absolute top-3 left-1/2 -translate-x-1/2 z-40 px-3 py-1 rounded-full text-[11px] font-semibold tracking-widest border backdrop-blur transition ${
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
          // The photo and its face boxes move, zoom and turn as one
          <div
            ref={photoWrapRef}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={drawing ? onDrawMouseDown : undefined}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (drawing) return;
              if (loupeZoom > 1) {
                setLoupeZoom(1);
                setLoupePan({ x: 0, y: 0 });
              } else {
                setLoupeZoom(2.5);
              }
            }}
            style={{
              transform: `translate(${loupePan.x}px, ${loupePan.y}px) scale(${loupeZoom}) rotate(${activePhoto.rotation}deg)`,
              transformOrigin: "center center",
              ...(fitted ? { width: fitted.w, height: fitted.h } : { visibility: "hidden" as const }),
            }}
            className={`relative shrink-0 transition-transform duration-75 ${
              drawing ? "cursor-crosshair" : loupeZoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
            }`}
          >
            <img
              ref={(img) => {
                // A photo already in the cache may have loaded before onLoad was attached
                if (img?.complete && img.naturalWidth > 0 && natural?.hash !== activePhoto.hash) {
                  setNatural({ hash: activePhoto.hash, w: img.naturalWidth, h: img.naturalHeight });
                }
              }}
              onLoad={(e) =>
                setNatural({ hash: activePhoto.hash, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
              // A photo that can't be shown still gets a place (the browser's broken-image mark), not an empty screen
              onError={() => setNatural({ hash: activePhoto.hash, w: activePhoto.width || 4, h: activePhoto.height || 3 })}
              src={mediaUrl({ kind: "original", hash: activePhoto.hash, path: activePhoto.path })}
              alt={activePhoto.name}
              draggable={false}
              className="block w-full h-full object-contain rounded-xl shadow-2xl"
            />
            {showFaces &&
              fitted &&
              activePhoto.faces.map((face, idx) => {
                const naming = namingFaceId === face.face_id;
                return (
                  <div
                    key={face.face_id}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!canName || !faces) return;
                      setNamingFaceId(face.face_id);
                      faces.setSelectedFaceId(face.face_id);
                      faces.setDrawnBox(null);
                      faces.setIsDrawingFace(false);
                      faces.setFaceNameInput(face.person_name || "");
                    }}
                    style={{
                      left: `${face.bbox_x * 100}%`,
                      top: `${face.bbox_y * 100}%`,
                      width: `${face.bbox_w * 100}%`,
                      height: `${face.bbox_h * 100}%`,
                    }}
                    title={canName ? (face.person_name ? `${face.person_name}: click to change the name` : "Click to name this face") : face.person_name || undefined}
                    className={`absolute rounded-md border-2 transition ${drawing ? "pointer-events-none" : canName ? "cursor-pointer" : "cursor-default"} ${
                      naming
                        ? "border-indigo-400 bg-indigo-500/20"
                        : face.person_name
                          ? "border-emerald-400/80 hover:border-emerald-300"
                          : "border-amber-400/80 hover:border-amber-300"
                    }`}
                  >
                    {/* The label keeps its size at any zoom */}
                    <span
                      style={{ transform: `scale(${1 / loupeZoom})`, transformOrigin: "bottom left" }}
                      className={`absolute bottom-full left-0 mb-0.5 px-1.5 rounded text-[11px] font-semibold whitespace-nowrap shadow ${
                        face.person_name ? "bg-emerald-600 text-white" : "bg-amber-500 text-zinc-950"
                      }`}
                    >
                      {face.person_name || `Face ${idx + 1}`}
                    </span>
                  </div>
                );
              })}
            {fitted && canName && !video && faces?.drawnBox && (
              <div
                style={{
                  left: `${faces.drawnBox.x * 100}%`,
                  top: `${faces.drawnBox.y * 100}%`,
                  width: `${faces.drawnBox.w * 100}%`,
                  height: `${faces.drawnBox.h * 100}%`,
                }}
                className="absolute rounded-md border-2 border-indigo-400 bg-indigo-500/20 pointer-events-none"
              />
            )}
          </div>
        )}

        {(namingFace || drawnReady) && faces && (
          <form
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              await faces.handleSaveFaceAndAutomatch(e);
              setNamingFaceId(null);
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-900/95 border border-zinc-700 shadow-2xl text-xs"
          >
            <span className="text-zinc-400 shrink-0">{namingFace?.person_name ? "Name" : "Who is this?"}</span>
            <input
              autoFocus
              type="text"
              list="loupe-person-names"
              value={faces.faceNameInput}
              onChange={(e) => faces.setFaceNameInput(e.target.value)}
              onKeyDown={(e) => {
                // Keys typed here stay here; Esc closes the name field, not the full-screen view
                e.stopPropagation();
                if (e.key === "Escape") {
                  e.preventDefault();
                  setNamingFaceId(null);
                  cancelDrawn();
                }
              }}
              placeholder="Person's name…"
              className="w-56 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-zinc-200 select-text focus:outline-none focus:border-emerald-500/80"
            />
            <datalist id="loupe-person-names">
              {faces.personNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <button
              type="submit"
              disabled={!faces.faceNameInput.trim()}
              className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg font-semibold"
            >
              Save name
            </button>
            {namingFace ? (
              <button
                type="button"
                onClick={async () => {
                  await faces.handleClearFace(namingFace.face_id);
                  setNamingFaceId(null);
                }}
                className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg"
                title={namingFace.person_name ? `Take the name "${namingFace.person_name}" off this face` : "This box isn't a face: remove it"}
              >
                {namingFace.person_name ? "Remove name" : "Not a face"}
              </button>
            ) : (
              <button
                type="button"
                onClick={startDrawing}
                className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg"
                title="Draw the box again"
              >
                Redraw
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setNamingFaceId(null);
                cancelDrawn();
              }}
              className="p-1 text-zinc-500 hover:text-zinc-200"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
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
              placeholder="Target subfolder (e.g. 2026/Selects)"
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
                if (handleRejectToTrash) void handleRejectToTrash();
                else {
                  handleSetFlag("reject");
                  handleBatchStageMove("_Trash");
                }
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
                  // Clicking the stars it has takes them off, as in the side panel
                  const clearing = activePhoto.rating === star;
                  handleBatchRate(clearing ? 0 : star);
                  if (autoAdvance && !clearing) navigateByOffset(1, false);
                }}
                className="p-0.5 hover:brightness-125 active:scale-95 transition"
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
              title="Pin or unpin (B)"
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
              title="Move to a folder"
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
                className="flex items-center gap-1 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white font-medium shadow"
                title="AI caption (A)"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>AI caption (A)</span>
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
