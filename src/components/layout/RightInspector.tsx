import { thumbSrc } from "../../utils/photoHelpers";
import { codecLabel, formatDuration, isVideo } from "../../utils/media";
import { shutterLabel } from "../../utils/exposure";
import { memo, useEffect, useRef } from "react";
import { call, mediaUrl } from "../../api";
import { PersonName } from "../people/PersonName";
import { useAccess } from "../auth/ServerGate";
import {
  CitySearchResult,
  FaceInstance,
  PhotoItem,
  ViewMode,
} from "../../types/lumina";
import {
  Aperture,
  Calendar,
  Camera,
  Compass,
  Crosshair,
  FileText,
  Flag,
  Folder,
  Gauge,
  Layers,
  Loader2,
  MapPin,
  Maximize2,
  Film,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw as RotateLeft,
  RotateCw,
  ScanFace,
  Sparkles,
  Star,
  User,
  X,
  XCircle,
} from "lucide-react";

function HistogramCanvas({ imageSrc }: { imageSrc: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.src = imageSrc;

      img.onload = () => {
        if (cancelled) return;
        const w = 64;
        const h = 48;
      const offCanvas = document.createElement("canvas");
      offCanvas.width = w;
      offCanvas.height = h;
      const offCtx = offCanvas.getContext("2d");
      if (!offCtx) return;

      offCtx.drawImage(img, 0, 0, w, h);
      const data = offCtx.getImageData(0, 0, w, h).data;

      const rBin = new Array(256).fill(0);
      const gBin = new Array(256).fill(0);
      const bBin = new Array(256).fill(0);
      const lBin = new Array(256).fill(0);

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        rBin[r]++;
        gBin[g]++;
        bBin[b]++;
        const luma = Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b));
        lBin[luma]++;
      }

      // Ignore extreme 0 and 255 clipping spikes for auto-scaling
      const maxVal = Math.max(
        ...rBin.slice(2, 254),
        ...gBin.slice(2, 254),
        ...bBin.slice(2, 254),
        1
      );

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(9, 10, 15, 0.95)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      function drawCurve(bin: number[], stroke: string, fill: string) {
        if (!ctx || !canvas) return;
        ctx.beginPath();
        ctx.moveTo(0, canvas.height);
        for (let x = 0; x < 256; x++) {
          const norm = Math.min(1, bin[x] / maxVal);
          const y = canvas.height - norm * (canvas.height - 4);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(255, canvas.height);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();

        ctx.beginPath();
        for (let x = 0; x < 256; x++) {
          const norm = Math.min(1, bin[x] / maxVal);
          const y = canvas.height - norm * (canvas.height - 4);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

        drawCurve(lBin, "rgba(228, 228, 231, 0.45)", "rgba(228, 228, 231, 0.08)");
        drawCurve(rBin, "rgba(239, 68, 68, 0.8)", "rgba(239, 68, 68, 0.12)");
        drawCurve(gBin, "rgba(16, 185, 129, 0.8)", "rgba(16, 185, 129, 0.12)");
        drawCurve(bBin, "rgba(59, 130, 246, 0.8)", "rgba(59, 130, 246, 0.12)");
      };
    }, 110);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [imageSrc]);

  return (
    <div className="flex flex-col gap-1 p-2 bg-zinc-900/90 rounded-xl border border-zinc-800">
      <div className="flex items-center justify-between text-xs text-zinc-500 px-1">
        <span>Histogram</span>
        <span className="flex items-center gap-1.5 font-semibold">
          <span className="text-zinc-300">L</span>
          <span className="text-red-400">R</span>
          <span className="text-emerald-400">G</span>
          <span className="text-blue-400">B</span>
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={256}
        height={56}
        className="w-full h-14 rounded-lg bg-surface border border-zinc-800/60"
      />
    </div>
  );
}

interface RightInspectorProps {
  rightWidth: number;
  simpleMode: boolean;
  activePhoto: PhotoItem;
  // More than one: pick, reject, rating, labels, rotation, tags and place below go to all of them
  selectedCount: number;
  setPhotos: React.Dispatch<React.SetStateAction<PhotoItem[]>>;
  selectedFaceId: string | null;
  setSelectedFaceId: React.Dispatch<React.SetStateAction<string | null>>;
  isDrawingFace: boolean;
  setIsDrawingFace: React.Dispatch<React.SetStateAction<boolean>>;
  drawStart: { x: number; y: number } | null;
  setDrawStart: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  drawnBox: { x: number; y: number; w: number; h: number } | null;
  setDrawnBox: React.Dispatch<
    React.SetStateAction<{ x: number; y: number; w: number; h: number } | null>
  >;
  faceNameInput: string;
  setFaceNameInput: React.Dispatch<React.SetStateAction<string>>;
  isDetectingSingleFace: boolean;
  analyzingHashes: Set<string>;
  isEditingInspectorLocation: boolean;
  setIsEditingInspectorLocation: React.Dispatch<React.SetStateAction<boolean>>;
  inspectorLocationQuery: string;
  setInspectorLocationQuery: React.Dispatch<React.SetStateAction<string>>;
  citySearchResults: CitySearchResult[];
  setCitySearchResults: React.Dispatch<React.SetStateAction<CitySearchResult[]>>;
  tagInput: string;
  setTagInput: React.Dispatch<React.SetStateAction<string>>;
  setIsLoupeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  setSelectedHashes: React.Dispatch<React.SetStateAction<Set<string>>>;
  setIsPickingMapLocation: React.Dispatch<React.SetStateAction<boolean>>;
  handleDetectFacesSingleOnnx: () => Promise<void>;
  handleSaveFaceAndAutomatch: (e: React.FormEvent) => Promise<void>;
  handleSetFlag: (flag: "pick" | "reject" | null) => Promise<void>;
  handleBatchRate: (rating: number) => Promise<void>;
  handleRotateSelection: (deltaDegrees: number) => Promise<void>;
  handleSetColorLabel: (color: "red" | "yellow" | "green" | "blue" | null) => Promise<void>;
  handleAiAnalyzeSingle: () => Promise<void>;
  handleForceRescanExifSelected: () => Promise<void>;
  handleSearchCities: (q: string) => Promise<void>;
  handleAssignCity: (c: CitySearchResult) => Promise<void>;
  handleAssignCustomLocationText: (customLoc: string) => Promise<void>;
  handleBatchAddTag: (tag: string) => Promise<void>;
  refreshPeople?: () => Promise<void>;
  onOpenFaceReviewModal?: (personName: string) => void;
}

function RightInspector({
  rightWidth,
  selectedCount,
  simpleMode,
  activePhoto,
  setPhotos,
  selectedFaceId,
  setSelectedFaceId,
  isDrawingFace,
  setIsDrawingFace,
  drawStart,
  setDrawStart,
  drawnBox,
  setDrawnBox,
  faceNameInput,
  setFaceNameInput,
  isDetectingSingleFace,
  analyzingHashes,
  isEditingInspectorLocation,
  setIsEditingInspectorLocation,
  inspectorLocationQuery,
  setInspectorLocationQuery,
  citySearchResults,
  setCitySearchResults,
  tagInput,
  setTagInput,
  setIsLoupeOpen,
  setViewMode,
  setSelectedHashes,
  setIsPickingMapLocation,
  handleDetectFacesSingleOnnx,
  handleSaveFaceAndAutomatch,
  handleSetFlag,
  handleBatchRate,
  handleRotateSelection,
  handleSetColorLabel,
  handleAiAnalyzeSingle,
  handleForceRescanExifSelected,
  handleSearchCities,
  handleAssignCity,
  handleAssignCustomLocationText,
  handleBatchAddTag,
  refreshPeople,
  onOpenFaceReviewModal,
}: RightInspectorProps) {
  // In All photos a photo with no copy this account may change (shared with a guest) is look-only
  const libraryAccess = useAccess();
  const access = { ...libraryAccess, edit: libraryAccess.edit && !(activePhoto.copies && !activePhoto.home) };
  const previewImgWrapRef = useRef<HTMLDivElement>(null);
  const faceInputRef = useRef<HTMLInputElement>(null);

  // Mouse position as 0..1 coordinates of the photo itself. The preview is rotated with CSS, and
  // getBoundingClientRect() returns the rotated, on-screen box, so undo the quarter turns first.
  function pointInPhoto(e: React.MouseEvent<HTMLDivElement>, el: HTMLDivElement) {
    const rect = el.getBoundingClientRect();
    const sx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const sy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    switch (((activePhoto.rotation % 360) + 360) % 360) {
      case 90:
        return { x: sy, y: 1 - sx };
      case 180:
        return { x: 1 - sx, y: 1 - sy };
      case 270:
        return { x: 1 - sy, y: sx };
      default:
        return { x: sx, y: sy };
    }
  }

  function handlePreviewMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!isDrawingFace || !previewImgWrapRef.current) return;
    const { x, y } = pointInPhoto(e, previewImgWrapRef.current);
    setDrawStart({ x, y });
    setDrawnBox({ x, y, w: 0.01, h: 0.01 });
    setSelectedFaceId(null);
  }

  function handlePreviewMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!isDrawingFace || !drawStart || !previewImgWrapRef.current) return;
    const { x: curX, y: curY } = pointInPhoto(e, previewImgWrapRef.current);
    const x = Math.min(drawStart.x, curX);
    const y = Math.min(drawStart.y, curY);
    const w = Math.max(0.04, Math.abs(curX - drawStart.x));
    const h = Math.max(0.04, Math.abs(curY - drawStart.y));
    setDrawnBox({ x, y, w, h });
  }

  function handlePreviewMouseUp() {
    if (!isDrawingFace || !drawStart) return;
    setDrawStart(null);
    setIsDrawingFace(false);
    setTimeout(() => faceInputRef.current?.focus(), 10);
  }



  const video = isVideo(activePhoto);
  // A video's file can't be shown as an image: only its thumbnail frame, once made
  const previewSrc = activePhoto.thumb_ready ? thumbSrc(activePhoto) : video ? "" : mediaUrl({ kind: "original", hash: activePhoto.hash, path: activePhoto.path });

  return (
    <aside
      style={{ width: `${rightWidth}px` }}
      className="bg-panel flex flex-col p-4 gap-3.5 overflow-y-auto shrink-0"
    >
      {selectedCount > 1 && (
        <div className="shrink-0 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
          <div className="font-medium">{selectedCount.toLocaleString()} photos selected</div>
          <div className="text-emerald-200/70">Pick, reject, rating, labels, rotation, tags and place below change all of them. Shown: {activePhoto.name}</div>
        </div>
      )}
      {/* Proportional Preview with Aspect-Ratio Lock & Face Canvas */}
      <div className="flex flex-col gap-2 shrink-0">
        <div className="relative w-full bg-zinc-950 rounded-xl overflow-hidden border border-zinc-800 flex items-center justify-center p-1">
          <div
            ref={previewImgWrapRef}
            onMouseDown={handlePreviewMouseDown}
            onMouseMove={handlePreviewMouseMove}
            onMouseUp={handlePreviewMouseUp}
            style={{ transform: `rotate(${activePhoto.rotation}deg)` }}
            className={`relative inline-block max-w-full transition-transform duration-150 ${
              isDrawingFace ? "cursor-crosshair ring-2 ring-indigo-500 rounded" : ""
            }`}
          >
            {previewSrc ? (
              <img
                src={previewSrc}
                alt={activePhoto.name}
                decoding="async"
                draggable={false}
                className="block max-w-full w-auto h-auto max-h-[44vh] object-contain rounded select-none pointer-events-none"
              />
            ) : (
              <div className="w-56 h-36 flex items-center justify-center text-zinc-700">
                <Film className="w-8 h-8" />
              </div>
            )}

            {/* Face Boxes (a video's faces come from other frames than the one shown) */}
            {!video && activePhoto.faces.map((face, idx) => {
              const isSelected = selectedFaceId === face.face_id;
              return (
                <div
                  key={face.face_id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedFaceId(face.face_id);
                    setDrawnBox(null);
                    setFaceNameInput(face.person_name || "");
                    setTimeout(() => faceInputRef.current?.focus(), 10);
                  }}
                  style={{
                    left: `${face.bbox_x * 100}%`,
                    top: `${face.bbox_y * 100}%`,
                    width: `${face.bbox_w * 100}%`,
                    height: `${face.bbox_h * 100}%`,
                  }}
                  className={`absolute rounded-md border-2 transition cursor-pointer ${
                    isSelected
                      ? "border-indigo-400 bg-indigo-500/20"
                      : face.person_name
                      ? "border-emerald-400/80 hover:border-emerald-300 bg-emerald-500/10"
                      : "border-amber-400/80 hover:border-amber-300 bg-amber-500/10"
                  }`}
                >
                  <span
                    className={`absolute -top-5 left-0 px-1.5 py-0.2 rounded text-[11px] font-semibold whitespace-nowrap shadow ${
                      face.person_name
                        ? "bg-emerald-600 text-white"
                        : "bg-amber-500 text-zinc-950"
                    }`}
                  >
                    {face.person_name || `Face #${idx + 1}`}
                  </span>
                </div>
              );
            })}

            {drawnBox && (
              <div
                style={{
                  left: `${drawnBox.x * 100}%`,
                  top: `${drawnBox.y * 100}%`,
                  width: `${drawnBox.w * 100}%`,
                  height: `${drawnBox.h * 100}%`,
                }}
                className="absolute rounded-md border-2 border-indigo-400 bg-indigo-500/25 pointer-events-none"
              >
                <span className="absolute -top-5 left-0 px-1.5 py-0.2 rounded bg-indigo-600 text-white text-[11px] font-semibold">
                  Selected Face
                </span>
              </div>
            )}
          </div>

          {video && (
            <button
              onClick={() => setIsLoupeOpen(true)}
              className="absolute inset-0 m-auto w-12 h-12 rounded-full bg-black/60 hover:bg-black/80 border border-white/25 backdrop-blur-sm flex items-center justify-center shadow transition"
              title="Play (Space)"
              aria-label="Play video"
            >
              <Play className="w-5 h-5 text-white fill-white ml-0.5" />
            </button>
          )}

          {/* Draw Face Button (photos only) */}
          {!video && access.edit && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsDrawingFace((p) => !p);
                setSelectedFaceId(null);
              }}
              className={`absolute top-2.5 left-2.5 px-2.5 py-1 rounded-md text-[11px] font-semibold flex items-center gap-1 transition backdrop-blur shadow ${
                isDrawingFace
                  ? "bg-emerald-600 text-white"
                  : "bg-black/70 hover:bg-zinc-800 text-zinc-200 border border-white/10"
              }`}
            >
              <Crosshair className="w-3 h-3" />
              <span>{isDrawingFace ? "Drag over a face…" : "Draw face box"}</span>
            </button>
          )}

          <button
            onClick={() => setIsLoupeOpen(true)}
            className="absolute bottom-2.5 right-2.5 p-1.5 bg-black/70 hover:bg-zinc-800 rounded-md text-white transition backdrop-blur shadow"
            title="Fullscreen (Space)"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Phase 6: Live RGB + Luminance Histogram (Pro Mode) */}
        {!simpleMode && previewSrc && (
          <HistogramCanvas imageSrc={previewSrc} />
        )}

        {/* Phase 6: Camera Telemetry LCD Pill */}
        {(activePhoto.focal_length ||
          activePhoto.aperture ||
          activePhoto.shutter_speed ||
          activePhoto.iso ||
          activePhoto.lens_model) && (
          <div className="flex flex-col gap-1.5 p-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-xs font-mono tabular-nums">
            <div className="flex items-center justify-between text-zinc-200">
              <div className="flex items-center gap-1 text-zinc-400" title="Focal length">
                <Compass className="w-3.5 h-3.5" />
                <span className="text-zinc-200">{activePhoto.focal_length || "--mm"}</span>
              </div>
              <div className="flex items-center gap-1 text-zinc-400" title="Aperture">
                <Aperture className="w-3.5 h-3.5" />
                <span className="text-zinc-200">{activePhoto.aperture || "f/--"}</span>
              </div>
              <div className="flex items-center gap-1 text-zinc-400" title="Shutter speed">
                <Gauge className="w-3.5 h-3.5" />
                <span className="text-zinc-200">{shutterLabel(activePhoto.shutter_speed) || "--s"}</span>
              </div>
              <div className="flex items-center gap-1 text-zinc-400" title="ISO">
                <Camera className="w-3.5 h-3.5" />
                <span className="text-zinc-200">{activePhoto.iso || "ISO --"}</span>
              </div>
            </div>
            {activePhoto.lens_model && (
              <div className="text-[11px] text-zinc-500 border-t border-zinc-800/80 pt-1 truncate">
                Lens: {activePhoto.lens_model}
              </div>
            )}
          </div>
        )}

        {/* Phase 6: RAW + JPEG Linked Pair Badge */}
        {activePhoto.pair_raw_path && (
          <div className="px-2.5 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-300 text-[11px] flex items-center justify-between font-mono">
            <span className="flex items-center gap-1.5 font-semibold">
              <Layers className="w-3.5 h-3.5 text-amber-400" />
              <span>RAW + JPEG Linked Pair</span>
            </span>
            <span
              className="text-[11px] text-zinc-400 truncate max-w-[140px]"
              title={activePhoto.pair_raw_path}
            >
              {activePhoto.pair_raw_path.split(/[\\/]/).pop()}
            </span>
          </div>
        )}

        {/* Face Strip & Namer */}
        <div className="p-2.5 bg-zinc-900/90 border border-zinc-800 rounded-xl flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400 flex items-center gap-1">
              <ScanFace className="w-3.5 h-3.5 text-zinc-400" />
              Faces ({activePhoto.faces.length})
            </span>
            {access.edit && (
            <button
              onClick={handleDetectFacesSingleOnnx}
              disabled={isDetectingSingleFace}
              className="px-2 py-0.5 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[11px] font-semibold transition flex items-center gap-1"
              title="Find the faces in this photo"
            >
              {isDetectingSingleFace ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <ScanFace className="w-3 h-3" />
              )}
              <span>
                {isDetectingSingleFace
                  ? "Scanning…"
                  : "Find faces"}
              </span>
            </button>
            )}
          </div>

          {activePhoto.faces.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto py-1">
              {activePhoto.faces.map((f, idx) => {
                const isSel = selectedFaceId === f.face_id;
                return (
                  <div
                    key={f.face_id}
                    onClick={() => {
                      setSelectedFaceId(isSel ? null : f.face_id);
                      setDrawnBox(null);
                      setFaceNameInput(f.person_name || "");
                      setTimeout(() => faceInputRef.current?.focus(), 10);
                    }}
                    className={`relative flex items-center gap-1.5 p-1 pr-2 rounded-full border cursor-pointer transition shrink-0 ${
                      isSel
                        ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-200"
                        : f.person_name
                        ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-200"
                        : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-600"
                    }`}
                  >
                    <img
                      src={mediaUrl({ kind: "face", path: f.face_thumb })}
                      alt="face"
                      className="w-6 h-6 rounded-full object-cover"
                    />
                    <span className="text-[11px] font-medium flex items-baseline gap-1 min-w-0">
                      {f.person_name ? <PersonName name={f.person_name} /> : `Face #${idx + 1}`}
                    </span>
                    {access.edit && (
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        const removedPerson = f.person_name;
                        // A named face loses its name and stays a face; an unnamed one isn't a face: its box goes
                        const rem = removedPerson
                          ? (
                              await call<Record<string, FaceInstance[]>>("unassign_faces_batch", {
                                faceIds: [f.face_id],
                                personName: removedPerson,
                              })
                            )[activePhoto.hash] ?? activePhoto.faces.map((x) => (x.face_id === f.face_id ? { ...x, person_name: null } : x))
                          : await call<FaceInstance[]>("remove_face_box", {
                              faceId: f.face_id,
                              hash: activePhoto.hash,
                            });
                        const remainingNames = new Set(
                          rem
                            .map((x) => x.person_name?.trim().toLowerCase())
                            .filter(Boolean)
                        );
                        setPhotos((prev) =>
                          prev.map((p) => {
                            if (p.hash !== activePhoto.hash) return p;
                            const nextPeople = removedPerson
                              ? p.people.filter(
                                  (pe) =>
                                    pe.toLowerCase() !== removedPerson.toLowerCase() ||
                                    remainingNames.has(pe.toLowerCase())
                                )
                              : p.people;
                            return { ...p, faces: rem, people: nextPeople };
                          })
                        );
                        if (selectedFaceId === f.face_id) {
                          // An unnamed face stays chosen, ready for another name
                          setSelectedFaceId(removedPerson ? f.face_id : rem[0]?.face_id ?? null);
                          setFaceNameInput(removedPerson ? "" : rem[0]?.person_name || "");
                        }
                        if (refreshPeople) {
                          await refreshPeople();
                        }
                      }}
                      className="text-zinc-500 hover:text-red-400 ml-0.5 text-xs"
                      title={f.person_name ? `Remove the name "${f.person_name}" from this face` : "Not a face: remove this box"}
                    >
                      <X className="w-3 h-3" />
                    </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* No faces and none being drawn: say so, instead of a name field with nothing to name */}
          {access.edit && activePhoto.faces.length === 0 && !drawnBox && !video && (
            <p className="text-xs text-zinc-500">
              No faces found. Missed one? Use “Draw face box” on the photo.
            </p>
          )}

          {access.edit && (activePhoto.faces.length > 0 || drawnBox) && (
          <form onSubmit={handleSaveFaceAndAutomatch} className="flex gap-1.5">
            <input
              ref={faceInputRef}
              type="text"
              value={faceNameInput}
              onClick={(e) => {
                e.stopPropagation();
                faceInputRef.current?.focus();
              }}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => setFaceNameInput(e.target.value)}
              placeholder={
                selectedFaceId || drawnBox
                  ? "Enter person name…"
                  : "Click a face to name it"
              }
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 select-text cursor-text focus:outline-none focus:border-emerald-500/80"
            />
            <button
              type="submit"
              className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shrink-0"
            >
              Save name
            </button>
          </form>
          )}

          {/* Assigned People Pills with 1-Click Unassign (X) */}
          {activePhoto.people.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-zinc-800/70">
              <span className="text-xs font-medium text-zinc-500 mr-1">
                People
              </span>
              {activePhoto.people.map((personName) => (
                <span
                  key={personName}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-500/40 text-emerald-200 text-[11px] font-medium"
                >
                  <User className="w-3 h-3 text-emerald-400" />
                  <PersonName name={personName} />
                  {access.edit && (
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const updatedPeople = await call<string[]>(
                        "remove_person_from_photo",
                        {
                          hash: activePhoto.hash,
                          name: personName,
                        }
                      );
                      setPhotos((prev) =>
                        prev.map((p) => {
                          if (p.hash !== activePhoto.hash) return p;
                          const nextFaces = p.faces.map((f) =>
                            f.person_name &&
                            f.person_name.toLowerCase() === personName.toLowerCase()
                              ? { ...f, person_name: null }
                              : f
                          );
                          return {
                            ...p,
                            people: updatedPeople,
                            faces: nextFaces,
                          };
                        })
                      );
                      if (
                        faceNameInput.trim().toLowerCase() === personName.toLowerCase()
                      ) {
                        setFaceNameInput("");
                      }
                      if (refreshPeople) {
                        await refreshPeople();
                      }
                    }}
                    className="text-emerald-400/70 hover:text-red-400 ml-0.5"
                    title={`Remove "${personName}" from this photo`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                  )}
                </span>
              ))}
            </div>
          )}

          {/* Pop-out Button to open the Full-Screen Face Match Review Studio */}
          {(faceNameInput.trim() || activePhoto.people.length > 0) &&
            onOpenFaceReviewModal && access.edit && (
              <button
                type="button"
                onClick={() =>
                  onOpenFaceReviewModal(faceNameInput.trim() || activePhoto.people[0])
                }
                className="mt-1 w-full py-1.5 px-2.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 text-[11px] font-semibold flex items-center justify-center gap-1.5 transition shadow-sm"
              >
                <ScanFace className="w-3.5 h-3.5 text-zinc-400" />
                <span>
                  Find more of {faceNameInput.trim() || activePhoto.people[0]}
                </span>
              </button>
            )}
        </div>
      </div>

      {/* Complete Triage Action Bar (Pick/Reject, 1-5 Star Rating, Rotate, Color Labels); read-only for those
          who may only look */}
      {access.edit ? (
      <div className="flex flex-col gap-2 p-2.5 bg-zinc-900/90 rounded-xl border border-zinc-800">
        <div className="flex items-center justify-between">
          {/* Pick / Reject */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleSetFlag(activePhoto.flag === "pick" ? null : "pick")}
              className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1.5 transition ${
                activePhoto.flag === "pick"
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "bg-zinc-800 text-zinc-400 hover:text-emerald-300"
              }`}
              title="Set pick flag (P)"
            >
              <Flag className="w-3.5 h-3.5" />
              <span>Pick</span>
            </button>
            <button
              onClick={() => handleSetFlag(activePhoto.flag === "reject" ? null : "reject")}
              className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1.5 transition ${
                activePhoto.flag === "reject"
                  ? "bg-red-600 text-white shadow-sm"
                  : "bg-zinc-800 text-zinc-400 hover:text-red-300"
              }`}
              title="Set reject flag (X)"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span>Reject</span>
            </button>
          </div>

          {/* Rotate Buttons */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleRotateSelection(-90)}
              className="p-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white"
              title="Rotate left ([)"
            >
              <RotateLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => handleRotateSelection(90)}
              className="p-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white"
              title="Rotate right (])"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Color Labels */}
          <div className="flex items-center gap-1.5">
            {(["red", "yellow", "green", "blue"] as const).map((color) => (
              <button
                key={color}
                onClick={() =>
                  handleSetColorLabel(activePhoto.color_label === color ? null : color)
                }
                className={`w-3.5 h-3.5 rounded-full transition ${
                  color === "red"
                    ? "bg-red-500"
                    : color === "yellow"
                    ? "bg-yellow-400"
                    : color === "green"
                    ? "bg-emerald-500"
                    : "bg-blue-500"
                } ${
                  activePhoto.color_label === color
                    ? "ring-2 ring-white scale-110"
                    : "opacity-60 hover:opacity-100"
                }`}
                title={`Color label: ${color}`}
              />
            ))}
          </div>
        </div>

        {/* Interactive 1-5 Star Rating Bar */}
        <div className="flex items-center justify-between pt-2 border-t border-zinc-800/80 text-xs">
          <span className="text-xs font-medium text-zinc-500">
            Rating
          </span>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((star) => {
              const active = star <= activePhoto.rating;
              return (
                <button
                  key={star}
                  onClick={() =>
                    handleBatchRate(activePhoto.rating === star ? 0 : star)
                  }
                  className="p-0.5 hover:brightness-125 active:scale-95 transition"
                  title={`Rate ${star} star${star === 1 ? "" : "s"} (Click again to clear)`}
                >
                  <Star
                    className={`w-4 h-4 ${
                      active
                        ? "text-amber-400 fill-amber-400"
                        : "text-zinc-600 hover:text-amber-400/60"
                    }`}
                  />
                </button>
              );
            })}
            {activePhoto.rating > 0 && (
              <button
                onClick={() => handleBatchRate(0)}
                className="ml-1 text-[11px] text-zinc-500 hover:text-zinc-300"
                title="Clear rating (0)"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>
      ) : (
        <ReadOnlyTriage photo={activePhoto} />
      )}

      {/* Details & AI Section */}
      <div className="flex flex-col gap-3">
        <div className="flex justify-between items-start gap-2">
          <div className="truncate">
            <h3
              className="text-sm font-semibold text-zinc-200 truncate"
              title={activePhoto.name}
            >
              {activePhoto.name}
            </h3>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-500">
              <span>{activePhoto.size_kb} KB</span>
              {activePhoto.width > 0 && activePhoto.height > 0 && (
                <>
                  <span>•</span>
                  <span className="font-mono text-zinc-400">
                    {activePhoto.rotation === 90 || activePhoto.rotation === 270
                      ? `${activePhoto.height}×${activePhoto.width}`
                      : `${activePhoto.width}×${activePhoto.height}`}
                  </span>
                </>
              )}
              {video ? (
                <>
                  {activePhoto.duration_ms != null && (
                    <>
                      <span>•</span>
                      <span className="font-mono text-sky-400">{formatDuration(activePhoto.duration_ms)}</span>
                    </>
                  )}
                  {codecLabel(activePhoto.video_codec) && (
                    <>
                      <span>•</span>
                      <span className="font-mono text-zinc-400">{codecLabel(activePhoto.video_codec)}</span>
                    </>
                  )}
                </>
              ) : (
                !simpleMode && (
                  <>
                    <span>•</span>
                    <span className="font-mono text-emerald-400">
                      Score: {activePhoto.sharpness}
                    </span>
                  </>
                )
              )}
            </div>
          </div>
          {!video && access.edit && (
            <button
              onClick={handleAiAnalyzeSingle}
              disabled={analyzingHashes.has(activePhoto.hash)}
              className="flex items-center gap-1 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white rounded-lg text-xs font-medium shrink-0 shadow-sm"
            >
              {analyzingHashes.has(activePhoto.hash) ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>{analyzingHashes.has(activePhoto.hash) ? "Captioning…" : "AI caption (A)"}</span>
            </button>
          )}
        </div>

        {/* Metadata & Interactive GPS / City Search */}
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-400">
            <Folder className="w-3 h-3 text-emerald-400" />
            <span>{activePhoto.subfolder}</span>
          </span>
          {activePhoto.location ? (
            <div className="inline-flex items-center rounded-md bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 overflow-hidden">
              <button
                onClick={() => setViewMode("map")}
                className="inline-flex items-center gap-1 px-2 py-0.5 hover:bg-emerald-900/60 transition"
                title="Show on the map"
              >
                <MapPin className="w-3 h-3 text-emerald-400" />
                <span>{activePhoto.location}</span>
              </button>
              {access.edit && (
              <>
              <button
                onClick={() => {
                  setIsEditingInspectorLocation((p) => !p);
                  setInspectorLocationQuery(activePhoto.location);
                }}
                className="px-1.5 py-0.5 border-l border-emerald-500/30 hover:bg-emerald-800/60"
                title="Change or edit location"
              >
                <Pencil className="w-2.5 h-2.5" />
              </button>
              <button
                onClick={() => handleAssignCustomLocationText("")}
                className="px-1.5 py-0.5 border-l border-emerald-500/30 hover:bg-red-900/60 hover:text-red-200"
                title="Clear location"
              >
                <X className="w-2.5 h-2.5" />
              </button>
              </>
              )}
            </div>
          ) : access.edit && (
            <button
              onClick={() => {
                setIsEditingInspectorLocation((p) => !p);
                setInspectorLocationQuery("");
                setCitySearchResults([]);
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-dashed border-zinc-700 text-zinc-300 hover:text-white transition"
            >
              <MapPin className="w-3 h-3 text-emerald-400" />
              <span>Add location</span>
            </button>
          )}
          {activePhoto.captured_at && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300">
              <Calendar className="w-3 h-3 text-cyan-400" />
              <span>{activePhoto.captured_at.split(" ")[0].replace(/:/g, "-")}</span>
            </span>
          )}
          {activePhoto.camera_model && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300">
              <Camera className="w-3 h-3 text-zinc-400" />
              <span>{activePhoto.camera_model}</span>
            </span>
          )}
          {!simpleMode && access.edit && (
            <button
              onClick={handleForceRescanExifSelected}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white transition"
              title="Force refresh EXIF & OS file dates"
            >
              <RefreshCw className="w-3 h-3 text-zinc-400" />
              <span>EXIF</span>
            </button>
          )}
        </div>

        {isEditingInspectorLocation && access.edit && (
          <div className="p-2.5 bg-zinc-900/95 border border-emerald-500/40 rounded-xl flex flex-col gap-2 text-xs">
            <div className="flex justify-between items-center text-[11px] font-semibold text-zinc-300">
              <span className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                Set Photo Location
              </span>
              <button
                onClick={() => setIsEditingInspectorLocation(false)}
                className="text-zinc-500 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (citySearchResults.length > 0) {
                  handleAssignCity(citySearchResults[0]);
                } else {
                  handleAssignCustomLocationText(inspectorLocationQuery);
                }
              }}
              className="flex gap-1.5"
            >
              <input
                type="text"
                value={inspectorLocationQuery}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  setInspectorLocationQuery(e.target.value);
                  handleSearchCities(e.target.value);
                }}
                placeholder="City or place (e.g. Meise, Paris)…"
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 select-text focus:outline-none focus:border-emerald-500"
                autoFocus
              />
              <button
                type="submit"
                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium shrink-0"
              >
                Save
              </button>
            </form>

            {citySearchResults.length > 0 && (
              <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                {citySearchResults.map((c) => (
                  <button
                    key={`${c.name}_${c.country}_${c.latitude}_${c.longitude}`}
                    onClick={() => handleAssignCity(c)}
                    className="text-left px-2 py-1 bg-zinc-950 hover:bg-zinc-800 rounded flex justify-between items-center text-zinc-300"
                  >
                    <span className="flex items-center gap-1.5">
                      <MapPin className="w-3 h-3 text-emerald-400" />
                      {c.name}, {c.country}
                    </span>
                    <span className="text-[11px] text-zinc-500 font-mono">
                      {c.latitude.toFixed(2)}, {c.longitude.toFixed(2)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <button
              onClick={() => {
                setIsEditingInspectorLocation(false);
                setSelectedHashes(new Set([activePhoto.hash]));
                setIsPickingMapLocation(true);
                setViewMode("map");
              }}
              className="px-2.5 py-1 bg-emerald-950/60 hover:bg-emerald-900/70 border border-emerald-500/40 text-emerald-300 rounded-lg text-center font-medium transition text-[11px] flex items-center justify-center gap-1.5"
            >
              <Crosshair className="w-3.5 h-3.5" />
              <span>Or Click Directly on Map to Pin GPS</span>
            </button>
          </div>
        )}

        {activePhoto.ai_caption && (
          <div className="p-3 bg-zinc-800/80 border border-zinc-700 rounded-xl text-zinc-200 text-xs italic leading-relaxed">
            "{activePhoto.ai_caption}"
          </div>
        )}

        {/* Tags */}
        <div className="flex flex-col gap-2 p-3 bg-zinc-900/90 rounded-xl border border-zinc-800">
          <span className="text-xs font-medium text-zinc-500">
            Tags ({activePhoto.tags.length})
          </span>
          <div className="flex flex-wrap gap-1.5">
            {activePhoto.tags.length === 0 && (
              <span className="text-xs text-zinc-500 italic">
                {access.edit ? "No tags yet — press A to run AI" : "No tags yet"}
              </span>
            )}
            {activePhoto.tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-zinc-800 text-zinc-200 rounded-md text-[11px]"
              >
                #{t}
                {access.edit && (
                <button
                  onClick={async () => {
                    // As a batch, so in All photos the copies on this PC follow too
                    await call("remove_tag_batch", { hashes: [activePhoto.hash], tag: t });
                    setPhotos((prev) =>
                      prev.map((p) =>
                        p.hash === activePhoto.hash
                          ? { ...p, tags: p.tags.filter((x) => x !== t) }
                          : p
                      )
                    );
                  }}
                  className="hover:text-red-400 text-zinc-500 ml-0.5"
                >
                  <X className="w-3 h-3" />
                </button>
                )}
              </span>
            ))}
          </div>
          {access.edit && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleBatchAddTag(tagInput);
            }}
            className="flex gap-1.5 mt-1"
          >
            <input
              type="text"
              value={tagInput}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="Add tag…"
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 select-text focus:outline-none focus:border-emerald-500/80"
            />
            <button
              type="submit"
              className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-xs rounded-lg font-medium"
            >
              Add
            </button>
          </form>
          )}
        </div>

        {activePhoto.ocr_text && (
          <div className="p-3 bg-zinc-900/90 border border-zinc-800 rounded-xl flex flex-col gap-1 text-xs">
            <span className="text-xs font-medium text-zinc-400 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              Text in the photo
            </span>
            <p className="font-mono text-zinc-200 text-[11px] select-text whitespace-pre-wrap">
              {activePhoto.ocr_text}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
// Pick or reject, colour label and stars as they are, for users who may only look
function ReadOnlyTriage({ photo }: { photo: PhotoItem }) {
  const colors = { red: "bg-red-500", yellow: "bg-yellow-400", green: "bg-green-500", blue: "bg-blue-500" } as const;
  if (!photo.flag && !photo.color_label && photo.rating === 0) return null;
  return (
    <div className="flex items-center gap-3 px-2.5 py-2 bg-zinc-900/90 rounded-xl border border-zinc-800 text-xs">
      {photo.flag && (
        <span className={`flex items-center gap-1 font-medium ${photo.flag === "pick" ? "text-emerald-300" : "text-red-300"}`}>
          <Flag className="w-3.5 h-3.5" />
          {photo.flag === "pick" ? "Pick" : "Reject"}
        </span>
      )}
      {photo.color_label && <span className={`w-3 h-3 rounded-full ${colors[photo.color_label]}`} title={photo.color_label} />}
      {photo.rating > 0 && (
        <span className="flex items-center gap-0.5 ml-auto" title={`${photo.rating} star${photo.rating === 1 ? "" : "s"}`}>
          {[1, 2, 3, 4, 5].map((star) => (
            <Star key={star} className={`w-3.5 h-3.5 ${star <= photo.rating ? "text-amber-400 fill-amber-400" : "text-zinc-700"}`} />
          ))}
        </span>
      )}
    </div>
  );
}

export default memo(RightInspector);
