import { useState, useRef, useEffect, RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import luminaMark from "../../assets/lumina-mark.svg";
import {
  OllamaStatus,
  OllamaPullProgress,
  FaceScanProgress,
  PhotoItem,
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
  Columns,
  HardDrive,
  ChevronDown,
  X,
  Undo2,
  Redo2,
  HelpCircle,
  Download,
  Sliders,
  FileText,
} from "lucide-react";

interface TopHeaderBarProps {
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
  viewMode: "grid" | "map" | "compare";
  setViewMode: React.Dispatch<React.SetStateAction<"grid" | "map" | "compare">>;
  setCompareZoom: React.Dispatch<React.SetStateAction<number>>;
  setComparePan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
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
  aiBatchProgress: {
    current: number;
    total: number;
    succeeded: number;
    failed: number;
    currentFile?: string;
  } | null;
  cancelBatchRef: RefObject<boolean>;
  handleOpenFolder: () => Promise<void>;
  handleRescanFolder: () => Promise<void>;
  handleRescanAndProcessFolder: () => Promise<void>;
  handleOpenHealthDashboard: () => Promise<void>;
  setIsCommitModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleDismissAllStaged: () => Promise<void>;
  handleBatchScanFacesOnnx: () => Promise<void>;
  runBatchAiOnList: (targets: PhotoItem[]) => Promise<void>;
  // Optional extended props so TopHeaderBar works seamlessly with both App.tsx signatures
  simpleMode?: boolean;
  toggleSimpleMode?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  handleUndo?: () => Promise<void>;
  handleRedo?: () => Promise<void>;
  setIsShortcutsModalOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  setIsSessionLogModalOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  sessionLogsCount?: number;
  ollamaPullProgress?: OllamaPullProgress | null;
  handlePullDefaultAiModel?: (modelName?: string) => Promise<void>;
}

export default function TopHeaderBar({
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
  setCompareZoom,
  setComparePan,
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
  aiBatchProgress,
  cancelBatchRef,
  handleOpenFolder,
  handleRescanFolder,
  handleRescanAndProcessFolder,
  handleOpenHealthDashboard,
  setIsCommitModalOpen,
  handleDismissAllStaged,
  handleBatchScanFacesOnnx,
  runBatchAiOnList,
  simpleMode = false,
  toggleSimpleMode,
  canUndo,
  canRedo,
  handleUndo,
  handleRedo,
  setIsShortcutsModalOpen,
  setIsSessionLogModalOpen,
  sessionLogsCount = 0,
  ollamaPullProgress,
  handlePullDefaultAiModel,
}: TopHeaderBarProps) {
  const [isRescanMenuOpen, setIsRescanMenuOpen] = useState(false);
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  const rescanMenuRef = useRef<HTMLDivElement>(null);
  const aiMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rescanMenuRef.current && !rescanMenuRef.current.contains(e.target as Node)) {
        setIsRescanMenuOpen(false);
      }
      if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) {
        setIsAiMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const hasVisionModel = (ollamaStatus?.installed_models.length ?? 0) > 0;

  async function triggerModelPull(model = "qwen3-vl:8b") {
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
    <header className="flex items-center justify-between px-4 py-2 bg-[#10121a]/90 backdrop-blur-md border-b border-zinc-800/70 z-30 gap-3 shrink-0">
      {/* Left Navigation & Library Controls */}
      <div className="flex items-center gap-2">
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

        <div className="flex items-center gap-2 mr-1">
          <img src={luminaMark} alt="Lumina" className="w-6 h-6 object-contain" />
          <span className="text-zinc-100 font-bold tracking-tight text-sm">Lumina</span>
          <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 px-1.5 py-0.2 rounded font-mono">
            v3.6
          </span>
        </div>

        <button
          onClick={handleOpenFolder}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800/90 hover:bg-zinc-700/90 text-zinc-100 border border-zinc-700/60 rounded-lg text-xs font-medium transition shadow-sm"
        >
          <FolderOpen className="w-3.5 h-3.5 text-emerald-400" />
          <span>{simpleMode ? "Open Photos" : "Open Library"}</span>
        </button>

        {/* Streamlined Split-Button Rescan Dropdown */}
        {folder && (
          <div ref={rescanMenuRef} className="relative flex items-center">
            <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <button
                onClick={handleRescanFolder}
                disabled={isScanningFolder}
                className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 text-xs font-medium transition"
                title="Quickly scan folder for added/removed files & missing EXIF"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 text-emerald-400 ${
                    isScanningFolder ? "animate-spin" : ""
                  }`}
                />
                <span>{simpleMode ? "Refresh" : "Rescan"}</span>
              </button>
              <button
                onClick={() => setIsRescanMenuOpen((p) => !p)}
                disabled={isScanningFolder}
                className="px-1.5 py-1.5 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border-l border-zinc-800 transition"
                title="More scan options"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>

            {isRescanMenuOpen && (
              <div className="absolute left-0 top-full mt-1.5 w-60 bg-[#12141d] border border-zinc-700/80 rounded-xl shadow-2xl p-1.5 z-50 text-xs">
                <button
                  onClick={() => {
                    setIsRescanMenuOpen(false);
                    handleRescanFolder();
                  }}
                  className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-zinc-800/80 text-left transition"
                >
                  <RefreshCw className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-zinc-200">Quick Rescan</div>
                    <div className="text-[10px] text-zinc-500">
                      Detect new/removed files & refresh EXIF
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => {
                    setIsRescanMenuOpen(false);
                    handleRescanAndProcessFolder();
                  }}
                  className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-zinc-800/80 text-left transition mt-0.5"
                >
                  <Zap className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-zinc-200">Deep Reprocess (No AI)</div>
                    <div className="text-[10px] text-zinc-500">
                      Rebuild 360px thumbs, dHash & focus scores
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Optional Undo / Redo Buttons if passed */}
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

        {/* Unified Emerald View Mode Switcher */}
        <div className="flex bg-zinc-900/90 p-0.5 rounded-lg border border-zinc-800">
          <button
            onClick={() => setViewMode("grid")}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition ${
              viewMode === "grid"
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 border border-transparent"
            }`}
            title="Grid View (G)"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>Grid</span>
          </button>
          <button
            onClick={() => {
              setCompareZoom(1);
              setComparePan({ x: 0, y: 0 });
              setViewMode("compare");
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition ${
              viewMode === "compare"
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 border border-transparent"
            }`}
            title="Synchronized Side-by-Side Compare Mode (C)"
          >
            <Columns className="w-3.5 h-3.5" />
            <span>Compare</span>
          </button>
          <button
            onClick={() => setViewMode("map")}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition ${
              viewMode === "map"
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 border border-transparent"
            }`}
            title="Map View (M)"
          >
            <MapPin className="w-3.5 h-3.5" />
            <span>Map ({gpsPhotosCount})</span>
          </button>
        </div>

        {!simpleMode && photos.length > 0 && (
          <button
            onClick={handleOpenHealthDashboard}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 rounded-lg text-xs font-medium transition"
            title="Library Storage Health & XMP Sidecar Export"
          >
            <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden 2xl:inline">Health & XMP</span>
          </button>
        )}

        {setIsSessionLogModalOpen && (
          <button
            onClick={() => setIsSessionLogModalOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 rounded-lg text-xs font-medium transition"
            title="Open Session Activity Log (Ctrl+L)"
          >
            <FileText className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden xl:inline">Log</span>
            {sessionLogsCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-emerald-500/15 text-emerald-300 font-mono text-[10px]">
                {sessionLogsCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Center Global Search Pill */}
      {photos.length > 0 && (
        <div className="relative flex-1 max-w-xs xl:max-w-md mx-2">
          <Search className="w-3.5 h-3.5 absolute left-3.5 top-2 text-zinc-500" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={
              simpleMode
                ? "Search people, places, or objects... (Ctrl+K)"
                : "Search objects, OCR, people, places... (Ctrl+K)"
            }
            className="w-full bg-zinc-900/90 border border-zinc-800 hover:border-zinc-700 focus:border-emerald-500/80 rounded-full pl-9 pr-8 py-1.5 text-xs text-zinc-200 focus:outline-none transition placeholder-zinc-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-2 text-zinc-500 hover:text-zinc-300"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Right Staged Commit & Neural AI Dock */}
      <div className="flex items-center gap-2">
        {stagedPhotosCount > 0 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsCommitModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 rounded-lg text-xs font-semibold shadow-sm transition"
            >
              <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                {simpleMode
                  ? `Apply ${stagedPhotosCount} Change${stagedPhotosCount === 1 ? "" : "s"}`
                  : `Commit (${stagedPhotosCount})`}
              </span>
            </button>
            <button
              onClick={handleDismissAllStaged}
              className="p-1.5 bg-zinc-900 hover:bg-red-950/60 text-zinc-400 hover:text-red-300 border border-zinc-800 hover:border-red-800/50 rounded-lg transition"
              title="Dismiss and clear all staged moves"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Segmented Simple | Pro Switch if toggleSimpleMode is passed */}
        {toggleSimpleMode && (
          <div
            className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 text-xs"
            title="Switch between Simple Mode (Plain English) and Pro Mode (Full technical controls)"
          >
            <button
              onClick={() => {
                if (!simpleMode) toggleSimpleMode();
              }}
              className={`px-2 py-1 rounded-md font-medium transition ${
                simpleMode
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Simple
            </button>
            <button
              onClick={() => {
                if (simpleMode) toggleSimpleMode();
              }}
              className={`px-2 py-1 rounded-md font-medium transition flex items-center gap-1 ${
                !simpleMode
                  ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/40"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Sliders className="w-3 h-3" />
              <span>Pro</span>
            </button>
          </div>
        )}

        {/* Compact Ollama Hardware Pill + 1-Click Model Downloader Popover */}
        {!simpleMode && (
          <div ref={aiMenuRef} className="relative">
            {ollamaPullProgress ? (
              <div className="flex items-center gap-2 px-2.5 py-1.5 bg-indigo-950/80 border border-indigo-500/50 rounded-lg text-xs text-indigo-200 font-mono">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                <span>Pulling AI: {ollamaPullProgress.percent}%</span>
              </div>
            ) : ollamaStatus?.running ? (
              <button
                onClick={() => setIsAiMenuOpen((p) => !p)}
                className="flex items-center gap-2 px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg text-xs transition"
                title="Configure Local AI Model & GPU VRAM"
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    ollamaStatus.active_vram_model
                      ? "bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.8)]"
                      : hasVisionModel
                      ? "bg-emerald-500"
                      : "bg-amber-400"
                  }`}
                />
                <span className="font-mono text-[11px] text-zinc-200 max-w-[110px] truncate">
                  {hasVisionModel ? aiModel.split(":")[0] : "Setup AI"}
                </span>
                {ollamaStatus.active_vram_model && (
                  <span className="text-[9px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-1 rounded font-mono">
                    VRAM
                  </span>
                )}
                <ChevronDown className="w-3 h-3 text-zinc-500" />
              </button>
            ) : (
              <button
                onClick={() => invoke("start_ollama_service")}
                className="flex items-center gap-1.5 text-xs bg-red-950/40 border border-red-800/60 text-red-300 px-2.5 py-1.5 rounded-lg hover:bg-red-900/60 transition"
              >
                <Power className="w-3.5 h-3.5" />
                <span>Start Ollama</span>
              </button>
            )}

            {isAiMenuOpen && ollamaStatus?.running && (
              <div className="absolute right-0 top-full mt-1.5 w-72 bg-[#12141d] border border-zinc-700/80 rounded-xl shadow-2xl p-3 z-50 flex flex-col gap-2.5 text-xs">
                <div className="flex items-center justify-between text-zinc-400 font-semibold text-[11px]">
                  <span className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                    Ollama Vision Engine
                  </span>
                  <span className="text-[10px] text-emerald-400 font-mono">Online</span>
                </div>

                {hasVisionModel ? (
                  <>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] text-zinc-500 uppercase font-bold">
                        Active Model
                      </label>
                      <select
                        value={aiModel}
                        onChange={(e) => setAiModel(e.target.value)}
                        className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-zinc-200 font-mono text-[11px] focus:outline-none focus:border-indigo-500"
                      >
                        {ollamaStatus.installed_models.map((m) => (
                          <option key={m.name} value={m.name} className="bg-zinc-900 text-zinc-200">
                            {m.name} ({m.size_gb}GB)
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="pt-1 border-t border-zinc-800/80 flex items-center justify-between">
                      <span className="text-[11px] text-zinc-400">
                        {ollamaStatus.active_vram_model ? "Loaded in GPU VRAM" : "In Disk Cache"}
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
                            await invoke("preload_ollama_vram", { modelName: aiModel });
                            const s = await invoke<OllamaStatus>("check_ollama_status");
                            setOllamaStatus(s);
                            setIsLoadingVram(false);
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
                  <div className="flex flex-col gap-2 py-1">
                    <p className="text-[11px] text-zinc-300 leading-relaxed">
                      No vision models found in Ollama yet. Click below to install{" "}
                      <code className="text-indigo-300">qwen3-vl:8b</code> automatically:
                    </p>
                    <button
                      onClick={() => {
                        setIsAiMenuOpen(false);
                        triggerModelPull("qwen3-vl:8b");
                      }}
                      className="w-full py-2 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-semibold flex items-center justify-center gap-1.5 shadow transition"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download Smart Photo AI (qwen3-vl:8b)</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Neural & AI Batch Actions */}
        {photos.length > 0 && (
          <>
            {!faceScanProgress ? (
              <button
                onClick={handleBatchScanFacesOnnx}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-950/60 hover:bg-indigo-900/70 text-indigo-300 border border-indigo-500/40 rounded-lg text-xs font-medium transition shadow-sm"
                title="Run local ONNX Neural Face Detector across visible photos & auto-match known people"
              >
                <ScanFace className="w-3.5 h-3.5 text-indigo-400" />
                <span className="hidden xl:inline">
                  {simpleMode ? "Find People" : "Scan Faces"}
                </span>
              </button>
            ) : (
              <span className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-950/90 border border-indigo-500/50 text-indigo-300 rounded-lg text-xs font-mono">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                <span>
                  {faceScanProgress.completed}/{faceScanProgress.total}
                </span>
              </span>
            )}

            {!aiBatchProgress ? (
              <button
                onClick={() => {
                  if (ollamaStatus?.running && !hasVisionModel) {
                    triggerModelPull("qwen3-vl:8b");
                    return;
                  }
                  const targets = visiblePhotos.filter(
                    (p) => p.tags.length === 0 && !p.ai_caption
                  );
                  runBatchAiOnList(targets.length > 0 ? targets : visiblePhotos);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition shadow-sm"
                title="Run Qwen3-VL AI Vision tagging across untagged visible photos"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{simpleMode ? "Auto-Tag Photos" : "Batch AI"}</span>
              </button>
            ) : (
              <button
                onClick={() => {
                  cancelBatchRef.current = true;
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-semibold transition"
              >
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>
                  Stop ({aiBatchProgress.current}/{aiBatchProgress.total})
                </span>
              </button>
            )}
          </>
        )}

        {setIsShortcutsModalOpen && (
          <button
            onClick={() => setIsShortcutsModalOpen(true)}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition"
            title="Keyboard Shortcuts Cheat Sheet (?)"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        )}

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
