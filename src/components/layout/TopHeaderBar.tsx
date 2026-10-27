import { useState, useRef, useEffect, RefObject } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import luminaMark from "../../assets/lumina-mark.svg";
import type { GridStyle, CardDetails } from "../views/VirtualPhotoGrid";
import { completeTerm, termBeingTyped, TermKey } from "../../utils/searchQuery";

const SEARCH_HINTS = ["rating:>=4", "flag:pick", "person:", "tag:", "date:2024-06", "place:", "camera:", "has:gps", "is:raw", "album:", "-flag:reject"];
import {
  OllamaStatus,
  FaceScanProgress,
  FaceModelDownloadProgress,
  PhotoItem,
  ViewMode,
} from "../../types/lumina";
import {
  FolderOpen,
  MapPin,
  LayoutGrid,
  Search,
  Sparkles,
  Power,
  Cpu,
  CheckCircle,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Loader2,
  RotateCcw,
  ScanFace,
  RefreshCw,
  Zap,
  HardDrive,
  ChevronDown,
  X,
  XCircle,
  Undo2,
  Redo2,
  HelpCircle,
  Download,
  Sliders,
  FileText,
  Library,
} from "lucide-react";

interface TopHeaderBarProps {
  // Values for search autocomplete (people, tags, cameras, albums, ...)
  getSearchSuggestions: (key: TermKey, partial: string) => string[];
  smartSearch: boolean;
  onToggleSmartSearch: () => void;
  gridStyle: GridStyle;
  setGridStyle: (value: GridStyle) => void;
  cardDetails: CardDetails;
  setCardDetails: (value: CardDetails) => void;
  folder: string;
  photos: PhotoItem[];
  visiblePhotos: PhotoItem[];
  stagedPhotosCount: number;
  gpsPhotosCount: number;
  isLeftCollapsed: boolean;
  setIsLeftCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  isRightCollapsed: boolean;
  setIsRightCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  isScanningFolder: boolean;
  viewMode: ViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  ollamaStatus: OllamaStatus | null;
  setOllamaStatus: React.Dispatch<React.SetStateAction<OllamaStatus | null>>;
  aiModel: string;
  setAiModel: React.Dispatch<React.SetStateAction<string>>;
  isLoadingVram: boolean;
  setIsLoadingVram: React.Dispatch<React.SetStateAction<boolean>>;
  faceScanProgress: FaceScanProgress | null;
  faceModelDownload: FaceModelDownloadProgress | null;
  aiBatchProgress: {
    current: number;
    total: number;
    succeeded: number;
    failed: number;
    currentFile?: string;
    startedAt: number;
    stopping?: boolean;
  } | null;
  handleStopAiBatch: () => Promise<void>;
  handleOpenFolder: () => Promise<void>;
  handleRescanFolder: () => Promise<void>;
  handleRescanAndProcessFolder: () => Promise<void>;
  handleOpenHealthDashboard: () => Promise<void>;
  setIsCommitModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleDismissAllStaged: () => Promise<void>;
  handleBatchScanFacesOnnx: () => Promise<void>;
  handleCancelFaceScan: () => Promise<void>;
  runBatchAiOnList: (targets: PhotoItem[], options?: { reanalyze?: boolean }) => Promise<void>;
  simpleMode?: boolean;
  toggleSimpleMode?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  handleUndo?: () => Promise<void>;
  handleRedo?: () => Promise<void>;
  setIsShortcutsModalOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  onOpenWelcomeTour?: () => void;
  setIsSessionLogModalOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  sessionLogsCount?: number;
  handlePullDefaultAiModel?: (modelName?: string) => Promise<void>;
  totalPendingFaceMatches?: number;
  onOpenFaceReviewStudio?: () => void;
}

export default function TopHeaderBar({
  getSearchSuggestions,
  smartSearch,
  onToggleSmartSearch,
  gridStyle,
  setGridStyle,
  cardDetails,
  setCardDetails,
  folder,
  photos,
  visiblePhotos,
  stagedPhotosCount,
  gpsPhotosCount,
  isLeftCollapsed,
  setIsLeftCollapsed,
  isRightCollapsed,
  setIsRightCollapsed,
  isScanningFolder,
  viewMode,
  setViewMode,
  searchQuery,
  setSearchQuery,
  searchInputRef,
  ollamaStatus,
  setOllamaStatus,
  aiModel,
  setAiModel,
  isLoadingVram,
  setIsLoadingVram,
  faceScanProgress,
  faceModelDownload,
  aiBatchProgress,
  handleStopAiBatch,
  handleOpenFolder,
  handleRescanFolder,
  handleRescanAndProcessFolder,
  handleOpenHealthDashboard,
  setIsCommitModalOpen,
  handleDismissAllStaged,
  handleBatchScanFacesOnnx,
  handleCancelFaceScan,
  runBatchAiOnList,
  simpleMode = false,
  toggleSimpleMode,
  canUndo,
  canRedo,
  handleUndo,
  handleRedo,
  setIsShortcutsModalOpen,
  onOpenWelcomeTour,
  setIsSessionLogModalOpen,
  sessionLogsCount = 0,
  handlePullDefaultAiModel,
  totalPendingFaceMatches = 0,
  onOpenFaceReviewStudio,
}: TopHeaderBarProps) {
  const [isLibraryMenuOpen, setIsLibraryMenuOpen] = useState(false);
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  // Flash attention: when Ollama runs without it, offer to switch it on (saves a Windows setting, restarts Ollama)
  const [flashAttention, setFlashAttention] = useState<{ value: string | null; canEnable: boolean } | null>(null);
  const [tuningState, setTuningState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [tuningError, setTuningError] = useState("");
  useEffect(() => {
    if (!isAiMenuOpen) return;
    invoke<{ flash_attention: string | null; can_enable: boolean }>("ollama_tuning_status")
      .then((s) => setFlashAttention({ value: s.flash_attention, canEnable: s.can_enable }))
      .catch(() => {});
  }, [isAiMenuOpen]);
  const flashAttentionOff =
    flashAttention !== null && flashAttention.canEnable && !["1", "true"].includes((flashAttention.value || "").toLowerCase());

  async function enableFlashAttention() {
    const ok = await ask(
      "Ollama runs about 10–15% faster with flash attention, with the same results.\n\nLumina saves OLLAMA_FLASH_ATTENTION=1 in your Windows user settings and restarts Ollama. Anything else using Ollama pauses for a few seconds.",
      { title: "Faster AI tagging", kind: "info", okLabel: "Turn on and restart Ollama", cancelLabel: "Not now" }
    );
    if (!ok) return;
    setTuningState("working");
    setTuningError("");
    try {
      await invoke("enable_ollama_flash_attention");
      setFlashAttention((f) => (f ? { ...f, value: "1" } : f));
      setOllamaStatus(await invoke<OllamaStatus>("check_ollama_status"));
      setTuningState("done");
    } catch (err) {
      setTuningError(String(err));
      setTuningState("error");
    }
  }
  const [isToolsMenuOpen, setIsToolsMenuOpen] = useState(false);

  const libraryMenuRef = useRef<HTMLDivElement>(null);
  const aiMenuRef = useRef<HTMLDivElement>(null);
  const toolsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (libraryMenuRef.current && !libraryMenuRef.current.contains(e.target as Node)) {
        setIsLibraryMenuOpen(false);
      }
      if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) {
        setIsAiMenuOpen(false);
      }
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target as Node)) {
        setIsToolsMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const hasVisionModel = (ollamaStatus?.installed_models.length ?? 0) > 0;

  // Search box: suggestions for the `key:value` term being typed, syntax hints when empty
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const typing = termBeingTyped(searchQuery);
  const suggestions = typing ? getSearchSuggestions(typing.key, typing.partial) : [];
  const showSearchPopup = isSearchFocused && ((typing !== null && suggestions.length > 0) || searchQuery.trim() === "");

  const [isStartingOllama, setIsStartingOllama] = useState(false);
  // Batch AI needs a running Ollama: start it from here instead of letting every photo fail
  async function startOllama() {
    setIsStartingOllama(true);
    try {
      await invoke("start_ollama_service");
      // Ollama needs a moment before it answers
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 800));
        try {
          const s = await invoke<OllamaStatus>("check_ollama_status");
          if (s.running) {
            setOllamaStatus(s);
            break;
          }
        } catch {}
      }
    } catch (err) {
      console.error("Could not start Ollama:", err);
    } finally {
      setIsStartingOllama(false);
    }
  }

  async function triggerModelPull(model = "qwen3-vl:8b") {
    const ok = await ask(
      `Batch AI needs a vision model. Download ${model} now?

It is about 6 GB and is stored by Ollama. You can cancel the download at any time.`,
      { title: "Download AI model", kind: "info", okLabel: "Download", cancelLabel: "Not now" }
    );
    if (!ok) return;
    if (handlePullDefaultAiModel) {
      await handlePullDefaultAiModel(model);
    } else {
      await invoke("pull_ollama_model", { modelName: model });
      const s = await invoke<OllamaStatus>("check_ollama_status");
      setOllamaStatus(s);
      setAiModel(model);
    }
  }

  return (
    <header className="flex items-center justify-between px-4 py-2 bg-card/95 backdrop-blur-md border-b border-zinc-800/70 z-30 gap-3 shrink-0">
      {/* ZONE 1: Left Navigation, Unified Library Split-Pill, View Switcher & Undo/Redo */}
      <div className="flex items-center gap-2.5 shrink-0">
        <button
          onClick={() => setIsLeftCollapsed((p) => !p)}
          className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition"
          title={isLeftCollapsed ? "Expand Left Sidebar" : "Collapse Left Sidebar"}
        >
          {isLeftCollapsed ? (
            <PanelLeftOpen className="w-4 h-4" />
          ) : (
            <PanelLeftClose className="w-4 h-4" />
          )}
        </button>

        <div className="flex items-center gap-2 mr-0.5">
          <img src={luminaMark} alt="Lumina" className="w-6 h-6 object-contain" />
          <span className="text-zinc-100 font-bold tracking-tight text-sm hidden sm:inline">
            Lumina
          </span>
        </div>

        {/* Unified Library Split Button (Open Folder + Rescan / Deep Reprocess Dropdown) */}
        <div ref={libraryMenuRef} className="relative flex items-center">
          <div className="flex items-center bg-zinc-900 border border-zinc-700/80 rounded-lg overflow-hidden shadow-sm">
            <button
              onClick={handleOpenFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-zinc-800 text-zinc-100 text-xs font-medium transition"
              title={folder || "Open a photo library folder"}
            >
              <FolderOpen className="w-3.5 h-3.5 text-emerald-400" />
              <span>{folder ? folder.split(/[\\/]/).pop() : "Open Library"}</span>
            </button>
            {folder && (
              <button
                onClick={() => setIsLibraryMenuOpen((p) => !p)}
                disabled={isScanningFolder}
                className="px-1.5 py-1.5 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border-l border-zinc-800 transition"
                title="Library Rescan & Folder Options"
              >
                {isScanningFolder ? (
                  <RefreshCw className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </button>
            )}
          </div>

          {isLibraryMenuOpen && (
            <div className="absolute left-0 top-full mt-1.5 w-64 bg-raised border border-zinc-700/80 rounded-xl shadow-2xl p-1.5 z-50 text-xs">
              <button
                onClick={() => {
                  setIsLibraryMenuOpen(false);
                  handleOpenFolder();
                }}
                className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-zinc-800/80 text-left transition"
              >
                <FolderOpen className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-zinc-200">Switch Library Folder...</div>
                  <div className="text-[11px] text-zinc-500 truncate max-w-[180px]">
                    {folder}
                  </div>
                </div>
              </button>
              <div className="h-[1px] bg-zinc-800/80 my-1" />
              <button
                onClick={() => {
                  setIsLibraryMenuOpen(false);
                  handleRescanFolder();
                }}
                className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-zinc-800/80 text-left transition"
              >
                <RefreshCw className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-zinc-200">Quick Rescan</div>
                  <div className="text-[11px] text-zinc-500">
                    Detect added/removed files & refresh EXIF
                  </div>
                </div>
              </button>
              <button
                onClick={() => {
                  setIsLibraryMenuOpen(false);
                  handleRescanAndProcessFolder();
                }}
                className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-zinc-800/80 text-left transition mt-0.5"
              >
                <Zap className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-zinc-200">Deep Reprocess Thumbnails</div>
                  <div className="text-[11px] text-zinc-500">
                    Rebuild 360px thumbs, dHash & focus scores
                  </div>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Top-level tabs: Photos (grid / compare) · Map · People · Collections (Ctrl+1…4) */}
        <nav role="tablist" aria-label="Sections" className="flex bg-zinc-900/90 p-0.5 rounded-lg border border-zinc-800">
          {(
            [
              { id: "photos", label: "Photos", icon: <LayoutGrid className="w-3.5 h-3.5" />, mode: "grid", key: "1" },
              { id: "map", label: `Map${gpsPhotosCount ? ` (${gpsPhotosCount})` : ""}`, icon: <MapPin className="w-3.5 h-3.5" />, mode: "map", key: "2" },
              { id: "people", label: "People", icon: <ScanFace className="w-3.5 h-3.5" />, mode: "people", key: "3" },
              { id: "collections", label: "Collections", icon: <Library className="w-3.5 h-3.5" />, mode: "collections", key: "4" },
            ] as const
          ).map((tab) => {
            const active = tab.id === "photos" ? viewMode === "grid" || viewMode === "compare" : viewMode === tab.mode;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active}
                onClick={() => setViewMode(tab.mode)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition ${
                  active
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200 border border-transparent"
                }`}
                title={`${tab.label} (Ctrl+${tab.key})`}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.id === "people" && totalPendingFaceMatches > 0 && (
                  <span className="px-1.5 rounded-full bg-amber-500 text-zinc-950 font-mono text-[11px] font-bold">
                    {totalPendingFaceMatches}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Compact Undo / Redo */}
        {handleUndo && handleRedo && photos.length > 0 && (
          <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
            <button
              onClick={handleUndo}
              disabled={!canUndo}
              className="p-1.5 rounded-md text-zinc-400 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition"
              title="Undo Last Action (Ctrl+Z)"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleRedo}
              disabled={!canRedo}
              className="p-1.5 rounded-md text-zinc-400 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition"
              title="Redo Action (Ctrl+Y)"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* ZONE 2: Center Global Search Bar */}
      {photos.length > 0 && (
        <div className="relative flex-1 max-w-md mx-2">
          <Search className="w-3.5 h-3.5 absolute left-3.5 top-2 text-zinc-500" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            role="combobox"
            aria-expanded={showSearchPopup}
            aria-autocomplete="list"
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => setIsSearchFocused(false)}
            onKeyDown={(e) => {
              // Ctrl+P (command palette) still reaches the app; other keys stay in the box
              if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p")) e.stopPropagation();
              if (suggestions.length > 0 && typing) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  setSuggestionIndex((i) => (i + step + suggestions.length) % suggestions.length);
                  return;
                }
                if (e.key === "Tab" || e.key === "Enter") {
                  e.preventDefault();
                  const pick = suggestions[Math.min(suggestionIndex, suggestions.length - 1)];
                  setSearchQuery(completeTerm(searchQuery, typing.key, pick));
                  setSuggestionIndex(0);
                  return;
                }
              }
              if (e.key === "Escape") (e.target as HTMLInputElement).blur();
            }}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSuggestionIndex(0);
              // Results show in the photo grid: searching from Collections goes to Photos
              if (viewMode === "collections") setViewMode("grid");
            }}
            placeholder={
              smartSearch
                ? "Describe the photo… (e.g. dog on the beach, verjaardagstaart)"
                : "Search people, tags, OCR text, places... (Ctrl+K)"
            }
            className={`w-full bg-zinc-900/90 border hover:border-zinc-700 rounded-full pl-9 pr-24 py-1.5 text-xs text-zinc-200 select-text focus:outline-none transition placeholder-zinc-500 ${
              smartSearch ? "border-indigo-500/60 focus:border-indigo-400" : "border-zinc-800 focus:border-emerald-500/80"
            }`}
          />
          {showSearchPopup && (
            <div
              // Clicking inside must not blur the input first
              onMouseDown={(e) => e.preventDefault()}
              role="listbox"
              className="absolute left-0 right-0 top-full mt-1.5 bg-raised border border-zinc-700/80 rounded-xl shadow-2xl p-1.5 z-50 text-xs"
            >
              {typing && suggestions.length > 0 ? (
                suggestions.map((value, i) => (
                  <div
                    key={value}
                    role="option"
                    aria-selected={i === suggestionIndex}
                    onMouseMove={() => setSuggestionIndex(i)}
                    onClick={() => {
                      setSearchQuery(completeTerm(searchQuery, typing.key, value));
                      setSuggestionIndex(0);
                    }}
                    className={`px-2.5 py-1.5 rounded-lg cursor-pointer flex items-center justify-between ${
                      i === suggestionIndex ? "bg-emerald-500/15 text-emerald-100" : "text-zinc-300"
                    }`}
                  >
                    <span>
                      <span className="text-zinc-500">{typing.key}:</span>
                      {value}
                    </span>
                    {i === suggestionIndex && <kbd className="text-[11px] text-zinc-500">Tab</kbd>}
                  </div>
                ))
              ) : (
                <div className="p-1.5 flex flex-col gap-1.5">
                  <span className="text-[11px] text-zinc-500">
                    Filter with terms (combine freely, "-" excludes), or just type words:
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {SEARCH_HINTS.map((hint) => (
                      <button
                        key={hint}
                        onClick={() => setSearchQuery(`${searchQuery ? `${searchQuery.trimEnd()} ` : ""}${hint}`)}
                        className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 hover:border-emerald-500/50 text-zinc-300 font-mono text-[11px]"
                      >
                        {hint}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="absolute right-1.5 top-1 flex items-center gap-1">
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="p-0.5 text-zinc-500 hover:text-zinc-300"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={onToggleSmartSearch}
              aria-pressed={smartSearch}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border transition ${
                smartSearch
                  ? "bg-indigo-600 text-white border-indigo-400"
                  : "bg-zinc-800/80 text-zinc-400 border-zinc-700 hover:text-indigo-200"
              }`}
              title="Smart search: find photos by describing them, in any language (runs locally)"
            >
              <Sparkles className="w-3 h-3" />
              <span>Smart</span>
            </button>
          </div>
        </div>
      )}

      {/* ZONE 3: Staged Commit, Unified AI & Faces Hub, and Studio Tools Menu */}
      <div className="flex items-center gap-2 shrink-0">
        {stagedPhotosCount > 0 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsCommitModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 rounded-lg text-xs font-semibold shadow-sm transition"
            >
              <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
              <span>Commit ({stagedPhotosCount})</span>
            </button>
            <button
              onClick={handleDismissAllStaged}
              className="p-1.5 bg-zinc-900 hover:bg-red-950/60 text-zinc-400 hover:text-red-300 border border-zinc-800 hover:border-red-800/50 rounded-lg transition"
              title="Dismiss all staged moves"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Unified AI & Face Recognition Studio Split-Button */}
        {photos.length > 0 && (
          <div ref={aiMenuRef} className="relative flex items-center">
            <div className="flex items-center rounded-lg overflow-hidden border border-indigo-500/40 bg-indigo-950/60 shadow-sm">
              {/* Primary Action: Scan Faces or Show Progress */}
              {faceScanProgress ? (
                <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-indigo-200 text-xs font-mono">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                  <span title={faceModelDownload ? `${faceModelDownload.downloaded_mb} / ${faceModelDownload.total_mb} MB (one-time download)` : undefined}>
                    {faceModelDownload
                      ? `Face models ${faceModelDownload.percent}%`
                      : `Faces ${faceScanProgress.completed}/${faceScanProgress.total}`}
                  </span>
                  <button
                    onClick={handleCancelFaceScan}
                    className="ml-1 p-0.5 rounded hover:bg-indigo-800/80 text-indigo-300 hover:text-white transition"
                    title="Stop the face scan after the current batch (photos not yet scanned keep their faces)"
                    aria-label="Stop face scan"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </span>
              ) : (
                <button
                  onClick={handleBatchScanFacesOnnx}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-indigo-900/80 text-indigo-200 text-xs font-medium transition border-r border-indigo-500/30"
                  title="Scan every photo in this folder with the ONNX face detector & match against confirmed people"
                >
                  <ScanFace className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Scan Faces</span>
                  {totalPendingFaceMatches > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-zinc-950 font-mono text-[11px] font-bold">
                      +{totalPendingFaceMatches}
                    </span>
                  )}
                </button>
              )}

              {/* Secondary Action: Batch AI Tagging */}
              {aiBatchProgress ? (
                <button
                  onClick={handleStopAiBatch}
                  disabled={aiBatchProgress.stopping}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-70 text-white text-xs font-semibold transition"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>
                    {aiBatchProgress.stopping
                      ? "Stopping…"
                      : `Stop (${aiBatchProgress.current}/${aiBatchProgress.total})`}
                  </span>
                </button>
              ) : ollamaStatus && !ollamaStatus.running ? (
                <button
                  onClick={startOllama}
                  disabled={isStartingOllama}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-70 text-zinc-100 text-xs font-semibold transition"
                  title="Batch AI needs Ollama, which isn't running. Click to start it."
                >
                  {isStartingOllama ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Power className="w-3.5 h-3.5 text-red-300" />
                  )}
                  <span>{isStartingOllama ? "Starting Ollama…" : "Start Ollama"}</span>
                </button>
              ) : ollamaStatus?.running && !hasVisionModel ? (
                <button
                  onClick={() => triggerModelPull("qwen3-vl:8b")}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
                  title="No vision model installed yet: download one to use Batch AI"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Get AI Model</span>
                </button>
              ) : (
                <button
                  onClick={() => runBatchAiOnList(visiblePhotos)}
                  disabled={!ollamaStatus}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold transition"
                  title="Run AI captioning & tagging on the visible photos (photos that already have AI results are skipped unless you choose otherwise)"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Batch AI</span>
                </button>
              )}

              {/* Dropdown Trigger for AI Engine / Model / VRAM / Face Review */}
              <button
                onClick={() => setIsAiMenuOpen((p) => !p)}
                className="px-1.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-indigo-100 border-l border-indigo-400/30 transition flex items-center gap-1"
                title="AI Model, GPU VRAM & Face Review Studio"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    ollamaStatus?.active_vram_model
                      ? "bg-emerald-300 shadow-[0_0_6px_#6ee7b7]"
                      : ollamaStatus?.running
                      ? "bg-emerald-400"
                      : "bg-red-400"
                  }`}
                />
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>

            {isAiMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-76 bg-raised border border-zinc-700/80 rounded-xl shadow-2xl p-3 z-50 flex flex-col gap-2.5 text-xs">
                {onOpenFaceReviewStudio && (
                  <button
                    onClick={() => {
                      setIsAiMenuOpen(false);
                      onOpenFaceReviewStudio();
                    }}
                    className="w-full p-2.5 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-200 flex items-center justify-between transition"
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      <ScanFace className="w-4 h-4 text-indigo-400" />
                      <span>Open Face Match Review Studio</span>
                    </span>
                    {totalPendingFaceMatches > 0 && (
                      <span className="px-2 py-0.5 rounded-full bg-amber-500 text-zinc-950 font-mono text-[11px] font-bold">
                        +{totalPendingFaceMatches} matches
                      </span>
                    )}
                  </button>
                )}

                <div className="h-[1px] bg-zinc-800/80" />

                <div className="flex items-center justify-between text-zinc-400 font-semibold text-[11px]">
                  <span className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                    Ollama Vision Engine
                  </span>
                  {ollamaStatus?.running ? (
                    <span className="text-[11px] text-emerald-400 font-mono">
                      {ollamaStatus.active_vram_model ? "VRAM Active" : "Online"}
                    </span>
                  ) : (
                    <button
                      onClick={startOllama}
                      disabled={isStartingOllama}
                      className="text-[11px] bg-red-950/60 border border-red-800/60 text-red-300 px-2 py-0.5 rounded hover:bg-red-900/60"
                    >
                      {isStartingOllama ? "Starting…" : "Start Ollama"}
                    </button>
                  )}
                </div>

                {(flashAttentionOff || tuningState === "done" || tuningState === "error") && (
                  <div className="p-2 rounded-lg bg-emerald-950/30 border border-emerald-500/30 flex flex-col gap-1.5">
                    {tuningState === "done" ? (
                      <span className="text-[11px] text-emerald-300">
                        Flash attention is on: AI tagging is now about 10–15% faster.
                      </span>
                    ) : (
                      <>
                        <span className="text-[11px] text-zinc-300">
                          Ollama runs without flash attention. Turning it on makes AI tagging about 10–15% faster.
                        </span>
                        <button
                          onClick={enableFlashAttention}
                          disabled={tuningState === "working" || Boolean(aiBatchProgress)}
                          title={aiBatchProgress ? "Wait for Batch AI to finish" : undefined}
                          className="self-start flex items-center gap-1 text-[11px] bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 text-white px-2.5 py-1 rounded-lg font-medium"
                        >
                          <Zap className="w-3 h-3" />
                          <span>{tuningState === "working" ? "Restarting Ollama…" : "Turn on flash attention"}</span>
                        </button>
                        {tuningState === "error" && <span className="text-[11px] text-red-300">{tuningError}</span>}
                      </>
                    )}
                  </div>
                )}

                {ollamaStatus?.running &&
                  (hasVisionModel ? (
                    <>
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] text-zinc-500 uppercase font-bold">
                          Active Vision Model
                        </label>
                        <select
                          value={aiModel}
                          onChange={(e) => setAiModel(e.target.value)}
                          className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-zinc-200 font-mono text-[11px] focus:outline-none focus:border-indigo-500"
                        >
                          {ollamaStatus.installed_models.map((m) => (
                            <option
                              key={m.name}
                              value={m.name}
                              className="bg-zinc-900 text-zinc-200"
                            >
                              {m.name} ({m.size_gb}GB)
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="pt-1 border-t border-zinc-800/80 flex items-center justify-between">
                        <span className="text-[11px] text-zinc-400">
                          {ollamaStatus.active_vram_model
                            ? "Loaded in GPU VRAM"
                            : "In Disk Cache"}
                        </span>
                        {ollamaStatus.active_vram_model ? (
                          <button
                            onClick={async () => {
                              if (ollamaStatus.active_vram_model) {
                                await invoke("unload_ollama_vram", {
                                  modelName: ollamaStatus.active_vram_model,
                                });
                                const s = await invoke<OllamaStatus>("check_ollama_status");
                                setOllamaStatus(s);
                              }
                            }}
                            className="flex items-center gap-1 text-[11px] bg-red-950/60 border border-red-800/50 text-red-300 hover:bg-red-900/60 px-2.5 py-1 rounded-lg transition font-medium"
                          >
                            <Power className="w-3 h-3" />
                            <span>Eject VRAM</span>
                          </button>
                        ) : (
                          <button
                            onClick={async () => {
                              setIsLoadingVram(true);
                              try {
                                await invoke("preload_ollama_vram", { modelName: aiModel });
                                const s = await invoke<OllamaStatus>("check_ollama_status");
                                setOllamaStatus(s);
                              } catch (err) {
                                console.error("Warm up VRAM failed:", err);
                              } finally {
                                // Never leave the button stuck in its disabled "loading" state
                                setIsLoadingVram(false);
                              }
                            }}
                            disabled={isLoadingVram}
                            className="flex items-center gap-1 text-[11px] bg-indigo-950/60 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-900/60 px-2.5 py-1 rounded-lg transition font-medium"
                          >
                            <Cpu className="w-3 h-3" />
                            <span>{isLoadingVram ? "Loading..." : "Warm Up VRAM"}</span>
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        setIsAiMenuOpen(false);
                        triggerModelPull("qwen3-vl:8b");
                      }}
                      className="w-full py-2 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-semibold flex items-center justify-center gap-1.5 shadow transition"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download Qwen3-VL:8B</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* Unified Studio Tools & Settings Menu (Replaces 4 separate buttons!) */}
        <div ref={toolsMenuRef} className="relative">
          <button
            onClick={() => setIsToolsMenuOpen((p) => !p)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 text-xs font-medium transition"
            title="Studio Tools, Mode Switch, Health & Shortcuts"
          >
            <Sliders className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden xl:inline">{simpleMode ? "Simple" : "Studio"}</span>
            <ChevronDown className="w-3 h-3 text-zinc-500" />
          </button>

          {isToolsMenuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-64 bg-raised border border-zinc-700/80 rounded-xl shadow-2xl p-2 z-50 flex flex-col gap-1 text-xs">
              {toggleSimpleMode && (
                <div className="p-2 rounded-lg bg-zinc-900/80 flex items-center justify-between mb-1">
                  <span className="text-[11px] font-semibold text-zinc-300">
                    Interface Mode
                  </span>
                  <div className="flex bg-zinc-950 border border-zinc-800 rounded-md p-0.5 text-[11px]">
                    <button
                      onClick={() => {
                        if (!simpleMode) toggleSimpleMode();
                      }}
                      className={`px-2 py-0.5 rounded ${
                        simpleMode
                          ? "bg-emerald-500/20 text-emerald-300 font-bold"
                          : "text-zinc-500"
                      }`}
                    >
                      Simple
                    </button>
                    <button
                      onClick={() => {
                        if (simpleMode) toggleSimpleMode();
                      }}
                      className={`px-2 py-0.5 rounded ${
                        !simpleMode
                          ? "bg-indigo-500/20 text-indigo-300 font-bold"
                          : "text-zinc-500"
                      }`}
                    >
                      Pro
                    </button>
                  </div>
                </div>
              )}

              {[
                {
                  label: "Grid",
                  value: gridStyle,
                  set: setGridStyle,
                  options: [
                    ["justified", "Justified", "Rows keep each photo's shape"],
                    ["square", "Square", "Equal cards with a name line"],
                  ],
                },
                {
                  label: "Card details",
                  value: cardDetails,
                  set: setCardDetails,
                  options: [
                    ["hover", "On hover", "Extra badges show on hover and on the selected photo"],
                    ["always", "Always", "All badges always visible"],
                  ],
                },
              ].map((setting) => (
                <div
                  key={setting.label}
                  className="p-2 rounded-lg bg-zinc-900/80 flex items-center justify-between mb-1"
                >
                  <span className="text-[11px] font-semibold text-zinc-300">{setting.label}</span>
                  <div className="flex bg-zinc-950 border border-zinc-800 rounded-md p-0.5 text-[11px]">
                    {setting.options.map(([value, text, hint]) => (
                      <button
                        key={value}
                        onClick={() => (setting.set as (v: string) => void)(value)}
                        title={hint}
                        className={`px-2 py-0.5 rounded ${
                          setting.value === value
                            ? "bg-emerald-500/20 text-emerald-300 font-bold"
                            : "text-zinc-500"
                        }`}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {photos.length > 0 && (
                <button
                  onClick={() => {
                    setIsToolsMenuOpen(false);
                    handleOpenHealthDashboard();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
                >
                  <HardDrive className="w-4 h-4 text-emerald-400 shrink-0" />
                  <div>
                    <div className="font-medium">Storage Health & XMP</div>
                    <div className="text-[11px] text-zinc-500">
                      Cache stats & Lightroom sidecars
                    </div>
                  </div>
                </button>
              )}

              {setIsSessionLogModalOpen && (
                <button
                  onClick={() => {
                    setIsToolsMenuOpen(false);
                    setIsSessionLogModalOpen(true);
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
                >
                  <span className="flex items-center gap-2.5">
                    <FileText className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>Session Activity Log</span>
                  </span>
                  {sessionLogsCount > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full bg-emerald-500/15 text-emerald-300 font-mono text-[11px]">
                      {sessionLogsCount}
                    </span>
                  )}
                </button>
              )}

              {setIsShortcutsModalOpen && (
                <button
                  onClick={() => {
                    setIsToolsMenuOpen(false);
                    setIsShortcutsModalOpen(true);
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
                >
                  <span className="flex items-center gap-2.5">
                    <HelpCircle className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Keyboard Shortcuts</span>
                  </span>
                  <kbd className="px-1.5 py-0.2 bg-zinc-950 border border-zinc-700 rounded text-[11px] font-mono text-zinc-400">
                    ?
                  </kbd>
                </button>
              )}

              {onOpenWelcomeTour && (
                <button
                  onClick={() => {
                    setIsToolsMenuOpen(false);
                    onOpenWelcomeTour();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
                >
                  <Sparkles className="w-4 h-4 text-indigo-300 shrink-0" />
                  <span>Welcome Tour</span>
                </button>
              )}
            </div>
          )}
        </div>

        <button
          onClick={() => setIsRightCollapsed((p) => !p)}
          className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition"
          title={isRightCollapsed ? "Expand Right Inspector" : "Collapse Right Inspector"}
        >
          {isRightCollapsed ? (
            <PanelRightOpen className="w-4 h-4" />
          ) : (
            <PanelRightClose className="w-4 h-4" />
          )}
        </button>
      </div>
    </header>
  );
}
