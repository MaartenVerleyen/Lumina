import { useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { CitySearchResult, FaceInstance, PhotoItem } from "../../types/lumina";
import {
  Calendar,
  Camera,
  Crosshair,
  FileText,
  Flag,
  Folder,
  Loader2,
  MapPin,
  Maximize2,
  Pencil,
  RefreshCw,
  RotateCcw as RotateLeft,
  RotateCw,
  ScanFace,
  Sparkles,
  Star,
  X,
  XCircle,
} from "lucide-react";

interface RightInspectorProps {
  rightWidth: number;
  activePhoto: PhotoItem;
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
  setViewMode: React.Dispatch<React.SetStateAction<"grid" | "map" | "compare">>;
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
}

export default function RightInspector({
  rightWidth,
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
}: RightInspectorProps) {
  const previewImgWrapRef = useRef<HTMLDivElement>(null);

  function handlePreviewMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!isDrawingFace || !previewImgWrapRef.current) return;
    const rect = previewImgWrapRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setDrawStart({ x, y });
    setDrawnBox({ x, y, w: 0.01, h: 0.01 });
    setSelectedFaceId(null);
  }

  function handlePreviewMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!isDrawingFace || !drawStart || !previewImgWrapRef.current) return;
    const rect = previewImgWrapRef.current.getBoundingClientRect();
    const curX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const curY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
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
  }

  return (
    <aside
      style={{ width: `${rightWidth}px` }}
      className="bg-[#0c0d14] flex flex-col p-4 gap-3.5 overflow-y-auto shrink-0"
    >
      {/* Proportional Preview with Aspect-Ratio Lock & Face Canvas */}
      <div className="flex flex-col gap-2 shrink-0">
        <div className="relative w-full bg-zinc-950 rounded-xl overflow-hidden border border-zinc-800 flex items-center justify-center p-1">
          <div
            ref={previewImgWrapRef}
            onMouseDown={handlePreviewMouseDown}
            onMouseMove={handlePreviewMouseMove}
            onMouseUp={handlePreviewMouseUp}
            className={`relative inline-block max-w-full ${
              isDrawingFace ? "cursor-crosshair ring-2 ring-indigo-500 rounded" : ""
            }`}
          >
            <img
              src={convertFileSrc(activePhoto.path)}
              alt={activePhoto.name}
              draggable={false}
              style={{ transform: `rotate(${activePhoto.rotation}deg)` }}
              className="block max-w-full w-auto h-auto max-h-[48vh] object-contain rounded select-none pointer-events-none transition-transform duration-150"
            />

            {/* Face Boxes */}
            {activePhoto.faces.map((face, idx) => {
              const isSelected = selectedFaceId === face.face_id;
              return (
                <div
                  key={face.face_id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedFaceId(face.face_id);
                    setDrawnBox(null);
                    setFaceNameInput(face.person_name || "");
                  }}
                  style={{
                    left: `${face.bbox_x * 100}%`,
                    top: `${face.bbox_y * 100}%`,
                    width: `${face.bbox_w * 100}%`,
                    height: `${face.bbox_h * 100}%`,
                  }}
                  className={`absolute rounded-md border-2 transition cursor-pointer ${
                    isSelected
                      ? "border-indigo-400 bg-indigo-500/20 shadow-[0_0_12px_rgba(99,102,241,0.6)]"
                      : face.person_name
                      ? "border-emerald-400/80 hover:border-emerald-300 bg-emerald-500/10"
                      : "border-amber-400/80 hover:border-amber-300 bg-amber-500/10"
                  }`}
                >
                  <span
                    className={`absolute -top-5 left-0 px-1.5 py-0.2 rounded text-[9px] font-bold whitespace-nowrap shadow ${
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
                <span className="absolute -top-5 left-0 px-1.5 py-0.2 rounded bg-indigo-600 text-white text-[9px] font-bold">
                  Selected Face
                </span>
              </div>
            )}
          </div>

          {/* Draw Face Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsDrawingFace((p) => !p);
              setSelectedFaceId(null);
            }}
            className={`absolute top-2.5 left-2.5 px-2.5 py-1 rounded-md text-[10px] font-semibold flex items-center gap-1 transition backdrop-blur shadow ${
              isDrawingFace
                ? "bg-indigo-600 text-white"
                : "bg-black/70 hover:bg-zinc-800 text-zinc-200 border border-white/10"
            }`}
          >
            <Crosshair className="w-3 h-3" />
            <span>{isDrawingFace ? "Drag over a face..." : "Draw Face Box"}</span>
          </button>

          <button
            onClick={() => setIsLoupeOpen(true)}
            className="absolute bottom-2.5 right-2.5 p-1.5 bg-black/70 hover:bg-zinc-800 rounded-md text-white transition backdrop-blur shadow"
            title="Fullscreen (Space)"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Face Strip & Namer */}
        <div className="p-2.5 bg-zinc-900/90 border border-zinc-800 rounded-xl flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
              <ScanFace className="w-3.5 h-3.5 text-indigo-400" />
              Faces in Photo ({activePhoto.faces.length})
            </span>
            <button
              onClick={handleDetectFacesSingleOnnx}
              disabled={isDetectingSingleFace}
              className="px-2 py-0.5 rounded bg-indigo-950/70 hover:bg-indigo-900 text-indigo-300 border border-indigo-500/40 text-[10px] font-semibold transition flex items-center gap-1"
              title="Run Pure-Rust ONNX Neural Face Detector on this photo"
            >
              {isDetectingSingleFace ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <ScanFace className="w-3 h-3" />
              )}
              <span>{isDetectingSingleFace ? "Scanning..." : "Detect Faces (ONNX)"}</span>
            </button>
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
                    }}
                    className={`relative flex items-center gap-1.5 p-1 pr-2 rounded-full border cursor-pointer transition shrink-0 ${
                      isSel
                        ? "bg-indigo-500/25 border-indigo-400 text-indigo-200"
                        : f.person_name
                        ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-200"
                        : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-600"
                    }`}
                  >
                    <img
                      src={convertFileSrc(f.face_thumb)}
                      alt="face"
                      className="w-6 h-6 rounded-full object-cover"
                    />
                    <span className="text-[11px] font-medium">
                      {f.person_name || `Face #${idx + 1}`}
                    </span>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        const rem = await invoke<FaceInstance[]>("remove_face_box", {
                          faceId: f.face_id,
                          hash: activePhoto.hash,
                        });
                        setPhotos((prev) =>
                          prev.map((p) =>
                            p.hash === activePhoto.hash ? { ...p, faces: rem } : p
                          )
                        );
                      }}
                      className="text-zinc-500 hover:text-red-400 ml-0.5 text-xs"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <form onSubmit={handleSaveFaceAndAutomatch} className="flex gap-1.5">
            <input
              type="text"
              value={faceNameInput}
              onChange={(e) => setFaceNameInput(e.target.value)}
              placeholder={
                selectedFaceId || drawnBox
                  ? "Enter name to auto-match..."
                  : "Click face or 'Draw Face Box'..."
              }
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shrink-0"
            >
              Save & Match
            </button>
          </form>
        </div>
      </div>

      {/* Complete Triage Action Bar (Pick/Reject, 1-5 Star Rating, Rotate, Color Labels) */}
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
              title="Set Pick Flag (P)"
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
              title="Set Reject Flag (X)"
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
              title="Rotate Left ([)"
            >
              <RotateLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => handleRotateSelection(90)}
              className="p-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white"
              title="Rotate Right (])"
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
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
            Star Rating (1–5)
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
                  className="p-0.5 hover:scale-110 transition"
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
                className="ml-1 text-[10px] text-zinc-500 hover:text-zinc-300"
                title="Clear rating (0)"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

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
              <span>•</span>
              <span className="font-mono text-emerald-400">
                Score: {activePhoto.sharpness}
              </span>
            </div>
          </div>
          <button
            onClick={handleAiAnalyzeSingle}
            disabled={analyzingHashes.has(activePhoto.hash)}
            className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 text-white rounded-lg text-xs font-medium shrink-0 shadow-sm"
          >
            {analyzingHashes.has(activePhoto.hash) ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            <span>{analyzingHashes.has(activePhoto.hash) ? "Tagging..." : "AI (A)"}</span>
          </button>
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
                title="View on Map"
              >
                <MapPin className="w-3 h-3 text-emerald-400" />
                <span>{activePhoto.location}</span>
              </button>
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
            </div>
          ) : (
            <button
              onClick={() => {
                setIsEditingInspectorLocation((p) => !p);
                setInspectorLocationQuery("");
                setCitySearchResults([]);
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-dashed border-zinc-700 text-zinc-300 hover:text-white transition"
            >
              <MapPin className="w-3 h-3 text-emerald-400" />
              <span>+ Add Location</span>
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
          <button
            onClick={handleForceRescanExifSelected}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white transition"
            title="Force refresh EXIF & OS file dates"
          >
            <RefreshCw className="w-3 h-3 text-zinc-400" />
            <span>EXIF</span>
          </button>
        </div>

        {isEditingInspectorLocation && (
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
                onChange={(e) => {
                  setInspectorLocationQuery(e.target.value);
                  handleSearchCities(e.target.value);
                }}
                placeholder="City or place (e.g. Meise, Paris)..."
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500"
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
                    key={`${c.name}_${c.country}`}
                    onClick={() => handleAssignCity(c)}
                    className="text-left px-2 py-1 bg-zinc-950 hover:bg-zinc-800 rounded flex justify-between items-center text-zinc-300"
                  >
                    <span className="flex items-center gap-1.5">
                      <MapPin className="w-3 h-3 text-emerald-400" />
                      {c.name}, {c.country}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono">
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
          <div className="p-3 bg-indigo-950/25 border border-indigo-500/30 rounded-xl text-indigo-200 text-xs italic leading-relaxed">
            "{activePhoto.ai_caption}"
          </div>
        )}

        {/* Tags */}
        <div className="flex flex-col gap-2 p-3 bg-zinc-900/90 rounded-xl border border-zinc-800">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
            Tags ({activePhoto.tags.length})
          </span>
          <div className="flex flex-wrap gap-1.5">
            {activePhoto.tags.length === 0 && (
              <span className="text-xs text-zinc-500 italic">
                No tags yet — press A to run AI
              </span>
            )}
            {activePhoto.tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-zinc-800 text-zinc-200 rounded-md text-[11px]"
              >
                #{t}
                <button
                  onClick={async () => {
                    await invoke("remove_tag", { hash: activePhoto.hash, tag: t });
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
              </span>
            ))}
          </div>
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
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="Add tag..."
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-xs rounded-lg font-medium"
            >
              Add
            </button>
          </form>
        </div>

        {activePhoto.ocr_text && (
          <div className="p-3 bg-zinc-900/90 border border-zinc-800 rounded-xl flex flex-col gap-1 text-xs">
            <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              Detected Text (OCR)
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
