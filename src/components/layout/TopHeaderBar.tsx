import { useState, useRef, useEffect, RefObject } from "react";
import { AccountMenu } from "../auth/AccountMenu";
import { ServerLibraryList } from "../servers/Servers";
import { WebUploadButton } from "../servers/WebUpload";
import { platform } from "../../api/platform";
import { useAccess } from "../auth/ServerGate";
import { confirmDialog } from "../../confirm";
import { ALL_PHOTOS, call, callLocal, inDesktopApp } from "../../api";
import { libraryName } from "../../utils/photoHelpers";
import luminaMark from "../../assets/lumina-mark.svg";
import { completeTerm, termBeingTyped, TermKey } from "../../utils/searchQuery";
import type { FaceScanScope } from "../../hooks/library/usePeople";
import { DEFAULT_AI_MODEL } from "../../hooks/library/shared";

const SEARCH_HINTS = ["rating:>=4", "flag:pick", "person:", "tag:", "date:2024-06", "place:", "camera:", "has:gps", "is:raw", "album:", "-flag:reject"];
import {
  OllamaStatus,
  FaceScanProgress,
  FaceModelDownloadProgress,
  PhotoItem,
  ViewMode,
} from "../../types/lumina";
import {
  FolderInput,
  FolderOpen,
  MapPin,
  LayoutGrid,
  Search,
  Sparkles,
  Power,
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
  Undo2,
  Redo2,
  HelpCircle,
  Download,
  Settings,
  FileText,
  Library,
  Upload,
  Layers,
} from "lucide-react";
import { plural } from "../../utils/plural";

interface TopHeaderBarProps {
  // Values for search autocomplete (people, tags, cameras, albums, ...)
  getSearchSuggestions: (key: TermKey, partial: string) => string[];
  smartSearch: boolean;
  onToggleSmartSearch: () => void;
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
  onOpenImport?: () => void;
  // Client mode: open a server's library, upload to the open one, and its server's short name
  onOpenServerLibrary?: (root: string, server: string) => void;
  // Libraries on this computer opened before, to switch back to from a server's (desktop app)
  recentFolders?: string[];
  // This PC's folders and the servers' libraries in one view
  onOpenAllPhotos?: () => void;
  onOpenRecentFolder?: (path: string) => void;
  onUpload?: () => void;
  serverLabel?: string;
  handleRescanFolder: () => Promise<void>;
  setIsCommitModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleDismissAllStaged: () => Promise<void>;
  handleBatchScanFacesOnnx: (scope?: FaceScanScope, visible?: PhotoItem[]) => Promise<void>;
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
  onOpenSettings?: () => void;
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
  onOpenImport,
  onOpenServerLibrary,
  recentFolders = [],
  onOpenRecentFolder,
  onOpenAllPhotos,
  onUpload,
  serverLabel,
  handleRescanFolder,
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
  onOpenSettings,
  setIsSessionLogModalOpen,
  sessionLogsCount = 0,
  handlePullDefaultAiModel,
  totalPendingFaceMatches = 0,
  onOpenFaceReviewStudio,
}: TopHeaderBarProps) {
  const access = useAccess();
  const [isLibraryMenuOpen, setIsLibraryMenuOpen] = useState(false);
  // The folders opened on this PC (its libraries), by name so the list stays put; recent folders until known
  const [localFolders, setLocalFolders] = useState<string[] | null>(null);
  const loadLocalFolders = () =>
    callLocal<{ root: string }[]>("local_libraries")
      .then((list) => setLocalFolders(list.map((l) => l.root).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))))
      .catch(() => setLocalFolders(null));
  useEffect(() => {
    if (isLibraryMenuOpen && inDesktopApp && onOpenRecentFolder) loadLocalFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLibraryMenuOpen]);
  const forgetFolder = async (path: string) => {
    const ok = await confirmDialog(
      `Lumina forgets "${path}": its photos' ratings, tags, names and album places in Lumina go, and it leaves All photos. The files stay in the folder; opening it again starts afresh.`,
      { title: "Forget this folder", okLabel: "Forget", kind: "danger" }
    );
    if (!ok) return;
    await callLocal("forget_local_library", { root: path }).catch((e) => console.error(e));
    loadLocalFolders();
  };
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  // Flash attention: when Ollama runs without it, offer to switch it on (saves a Windows setting, restarts Ollama)
  const [flashAttention, setFlashAttention] = useState<{ value: string | null; canEnable: boolean } | null>(null);
  const [tuningState, setTuningState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [tuningError, setTuningError] = useState("");
  useEffect(() => {
    // The server's Ollama is set up in its container, not from a browser
    if (!isAiMenuOpen || !platform.localFiles) return;
    call<{ flash_attention: string | null; can_enable: boolean }>("ollama_tuning_status")
      .then((s) => setFlashAttention({ value: s.flash_attention, canEnable: s.can_enable }))
      .catch(() => {});
  }, [isAiMenuOpen]);
  const flashAttentionOff =
    flashAttention !== null && flashAttention.canEnable && !["1", "true"].includes((flashAttention.value || "").toLowerCase());

  async function enableFlashAttention() {
    const ok = await confirmDialog(
      "Ollama runs about 10–15% faster with flash attention, with the same results.\n\nLumina saves OLLAMA_FLASH_ATTENTION=1 in your Windows user settings and restarts Ollama. Anything else using Ollama pauses for a few seconds.",
      { title: "Faster AI captions", kind: "info", okLabel: "Turn on and restart Ollama", cancelLabel: "Not now" }
    );
    if (!ok) return;
    setTuningState("working");
    setTuningError("");
    try {
      await call("enable_ollama_flash_attention");
      setFlashAttention((f) => (f ? { ...f, value: "1" } : f));
      setOllamaStatus(await call<OllamaStatus>("check_ollama_status"));
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
      await call("start_ollama_service");
      // Ollama needs a moment before it answers
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 800));
        try {
          const s = await call<OllamaStatus>("check_ollama_status");
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

  async function triggerModelPull(model = DEFAULT_AI_MODEL) {
    const ok = await confirmDialog(
      `AI captions need a vision model. Download ${model} now?

It is about 6 GB and is stored by Ollama. You can cancel the download at any time.`,
      { title: "Download AI model", kind: "info", okLabel: "Download", cancelLabel: "Not now" }
    );
    if (!ok) return;
    if (handlePullDefaultAiModel) {
      await handlePullDefaultAiModel(model);
    } else {
      await call("pull_ollama_model", { modelName: model });
      const s = await call<OllamaStatus>("check_ollama_status");
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
          title={isLeftCollapsed ? "Expand left sidebar" : "Collapse left sidebar"}
        >
          {isLeftCollapsed ? (
            <PanelLeftOpen className="w-4 h-4" />
          ) : (
            <PanelLeftClose className="w-4 h-4" />
          )}
        </button>

        <div className="flex items-center gap-2 mr-0.5">
          <img src={luminaMark} alt="Lumina" className="w-6 h-6 object-contain" />
          <span className="text-zinc-100 font-semibold tracking-tight text-sm hidden sm:inline">
            Lumina
          </span>
        </div>

        {/* Unified Library Split Button (Open Folder + Rescan / Deep Reprocess Dropdown) */}
        <div ref={libraryMenuRef} className="relative flex items-center">
          <div className="flex items-center bg-zinc-900 border border-zinc-700/80 rounded-lg overflow-hidden shadow-sm">
            <button
              // With a library open, its name opens the Library menu (switch, import); without one, a folder picker
              onClick={folder ? () => setIsLibraryMenuOpen((p) => !p) : handleOpenFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-zinc-800 text-zinc-100 text-xs font-medium transition"
              title={folder || "Open a photo library folder"}
            >
              <FolderOpen className="w-3.5 h-3.5 text-emerald-400" />
              <span>{folder ? libraryName(folder) : "Open library"}</span>
              {folder && serverLabel && <span className="text-[11px] text-zinc-500">on {serverLabel}</span>}
            </button>
            {folder && (
              <button
                onClick={() => setIsLibraryMenuOpen((p) => !p)}
                disabled={isScanningFolder}
                className="px-1.5 py-1.5 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border-l border-zinc-800 transition"
                title="Libraries and import"
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
              {onOpenAllPhotos && (
                <button
                  onClick={() => {
                    setIsLibraryMenuOpen(false);
                    onOpenAllPhotos();
                  }}
                  className={`w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-zinc-800/80 text-left transition ${
                    folder === ALL_PHOTOS ? "bg-zinc-800/60" : ""
                  }`}
                >
                  <Layers className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-zinc-200">All photos</div>
                    <div className="text-[11px] text-zinc-500">
                      {inDesktopApp ? "This PC and your servers in one view" : "Every library of the server in one view"}
                    </div>
                  </div>
                </button>
              )}
              <button
                onClick={() => {
                  setIsLibraryMenuOpen(false);
                  handleOpenFolder();
                }}
                className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-zinc-800/80 text-left transition"
              >
                <FolderOpen className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-zinc-200">{serverLabel || folder === ALL_PHOTOS ? "Open a folder on this PC…" : "Open another folder…"}</div>
                  <div className="text-[11px] text-zinc-500 truncate max-w-[180px]">
                    Choose a folder on this PC
                  </div>
                </div>
              </button>
              {onOpenImport && (
                <button
                  onClick={() => {
                    setIsLibraryMenuOpen(false);
                    onOpenImport();
                  }}
                  className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-zinc-800/80 text-left transition"
                >
                  <FolderInput className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-zinc-200">Import photos…</div>
                    <div className="text-[11px] text-zinc-500">From a memory card, drive or folder</div>
                  </div>
                </button>
              )}
              {onUpload && (
                <button
                  onClick={() => {
                    setIsLibraryMenuOpen(false);
                    onUpload();
                  }}
                  className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-zinc-800/80 text-left transition"
                >
                  <Upload className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-zinc-200">Upload photos…</div>
                    <div className="text-[11px] text-zinc-500">To {serverLabel}; or drop files and folders on the window</div>
                  </div>
                </button>
              )}
              {onOpenRecentFolder && (localFolders ?? recentFolders).length > 0 && (
                <div className="px-1 py-1.5 flex flex-col gap-1">
                  <div className="text-xs font-medium text-zinc-500 flex items-center gap-1.5 px-1">
                    <HardDrive className="w-3 h-3" /> On this PC
                  </div>
                  {(localFolders ?? recentFolders).map((path) => (
                    <div key={path} className="group flex items-center gap-1">
                      <button
                        onClick={() => {
                          setIsLibraryMenuOpen(false);
                          onOpenRecentFolder(path);
                        }}
                        className={`flex-1 min-w-0 rounded-lg text-left px-2 py-1.5 hover:bg-zinc-800/80 transition ${
                          !serverLabel && path === folder ? "text-emerald-200" : "text-zinc-200"
                        }`}
                        title={path}
                      >
                        <div className="truncate text-[13px] font-medium">{path.split(/[\\/]/).filter(Boolean).pop() || path}</div>
                        <div className="truncate text-[11px] text-zinc-500">{path}</div>
                      </button>
                      {localFolders && path !== folder && (
                        <button
                          onClick={() => void forgetFolder(path)}
                          className="shrink-0 px-1.5 py-1 rounded text-[11px] text-zinc-500 hover:text-red-300 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 focus:opacity-100"
                          title="Forget this folder (its files stay)"
                        >
                          Forget
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {onOpenServerLibrary && (
                <div className="px-1 py-1.5">
                  <ServerLibraryList
                    compact
                    onOpen={(root, server) => {
                      setIsLibraryMenuOpen(false);
                      onOpenServerLibrary(root, server);
                    }}
                  />
                </div>
              )}
              <div className="h-[1px] bg-zinc-800/80 my-1" />
              <button
                onClick={() => {
                  setIsLibraryMenuOpen(false);
                  handleRescanFolder();
                }}
                className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-zinc-800/80 text-left transition"
              >
                <RefreshCw className="w-4 h-4 text-zinc-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-zinc-200">{platform.localFiles ? "Look for new photos" : "Reload library"}</div>
                  <div className="text-[11px] text-zinc-500">
                    {platform.localFiles ? "Photos added or removed outside Lumina" : "Get the latest from the server"}
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
                  <span className="px-1.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[11px] tabular-nums" title="Faces to check">
                    {totalPendingFaceMatches}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Compact Undo / Redo */}
        {handleUndo && handleRedo && photos.length > 0 && access.edit && (
          <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
            <button
              onClick={handleUndo}
              disabled={!canUndo}
              className="p-1.5 rounded-md text-zinc-400 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition"
              title="Undo last action (Ctrl+Z)"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleRedo}
              disabled={!canRedo}
              className="p-1.5 rounded-md text-zinc-400 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition"
              title="Redo action (Ctrl+Y)"
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
                ? "Describe it: emma with the dog at the beach, kerst 2023… (Ctrl+K)"
                : "Search: anna at the beach in 2024, place, text… (Ctrl+K)"
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
        {stagedPhotosCount > 0 && !access.admin && access.edit && (
          <span
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 text-emerald-300/80 border border-emerald-500/30 rounded-lg text-xs font-semibold"
            title="Planned moves and photos for _Trash: an admin applies them"
          >
            <CheckCircle className="w-3.5 h-3.5 text-emerald-400/70" />
            <span>{stagedPhotosCount} to apply</span>
          </span>
        )}
        {stagedPhotosCount > 0 && access.admin && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsCommitModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 rounded-lg text-xs font-semibold shadow-sm transition"
            >
              <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
              <span>Apply changes ({stagedPhotosCount})</span>
            </button>
            <button
              onClick={handleDismissAllStaged}
              className="p-1.5 bg-zinc-900 hover:bg-red-950/60 text-zinc-400 hover:text-red-300 border border-zinc-800 hover:border-red-800/50 rounded-lg transition"
              title="Cancel all changes"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* AI: one button for faces and captions; while a job runs it shows how far it is */}
        {photos.length > 0 && access.edit && (
          <div ref={aiMenuRef} className="relative flex items-center">
            <button
              onClick={() => setIsAiMenuOpen((p) => !p)}
              aria-expanded={isAiMenuOpen}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 text-xs font-medium transition"
              title="Faces and AI captions"
            >
              {faceScanProgress || aiBatchProgress ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-zinc-400" />
              )}
              <span className="tabular-nums">
                {faceScanProgress
                  ? faceModelDownload
                    ? `Face models ${faceModelDownload.percent}%`
                    : `Faces ${faceScanProgress.completed}/${faceScanProgress.total}`
                  : aiBatchProgress
                  ? `Captions ${aiBatchProgress.current}/${aiBatchProgress.total}`
                  : "AI"}
              </span>
              {totalPendingFaceMatches > 0 && !faceScanProgress && !aiBatchProgress && (
                <span className="px-1.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[11px] tabular-nums" title="Faces to check">
                  {totalPendingFaceMatches}
                </span>
              )}
              <ChevronDown className="w-3 h-3 text-zinc-500" />
            </button>

            {isAiMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-80 bg-raised border border-zinc-700/80 rounded-xl shadow-2xl p-3 z-50 flex flex-col gap-3 text-xs">
                {onOpenFaceReviewStudio && (
                  <button
                    onClick={() => {
                      setIsAiMenuOpen(false);
                      onOpenFaceReviewStudio();
                    }}
                    className="w-full px-2.5 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 flex items-center justify-between transition"
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <ScanFace className="w-4 h-4 text-zinc-400" />
                      <span>Check faces and names</span>
                    </span>
                    {totalPendingFaceMatches > 0 && (
                      <span className="text-[11px] text-emerald-300 tabular-nums">{plural(totalPendingFaceMatches, "face")} to check</span>
                    )}
                  </button>
                )}

                {/* Face scans and the caption model: admin work on a server */}
                {access.admin && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs text-zinc-500 font-medium">Find faces</span>
                      {faceScanProgress ? (
                        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800">
                          <span className="text-zinc-300 tabular-nums">
                            {faceModelDownload
                              ? `Downloading face models: ${faceModelDownload.downloaded_mb} of ${faceModelDownload.total_mb} MB`
                              : `${faceScanProgress.completed.toLocaleString()} of ${plural(faceScanProgress.total, "photo")}`}
                          </span>
                          <button onClick={handleCancelFaceScan} className="text-zinc-400 hover:text-zinc-100" title="Photos not scanned yet keep their faces">
                            Stop
                          </button>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-1">
                          {(
                            [
                              ["all", "In everything"],
                              ["visible", `In what's shown (${visiblePhotos.length.toLocaleString()})`],
                              ["photos", "In photos only"],
                              ["videos", "In videos only"],
                            ] as const
                          ).map(([scope, label]) => (
                            <button
                              key={scope}
                              disabled={scope === "visible" && visiblePhotos.length === 0}
                              onClick={() => {
                                setIsAiMenuOpen(false);
                                handleBatchScanFacesOnnx(scope, visiblePhotos);
                              }}
                              className="px-2 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 text-left disabled:opacity-40"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="h-px bg-zinc-800/80" />

                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-zinc-500 font-medium">AI captions</span>
                        <span className={`text-[11px] ${ollamaStatus?.running ? "text-zinc-500" : "text-red-300"}`}>
                          {ollamaStatus?.running ? "Ollama is running" : "Ollama isn't running"}
                        </span>
                      </div>
                      <span className="text-[11px] text-zinc-500">A caption, tags and the text in each photo, written on this computer.</span>
                      {aiBatchProgress ? (
                        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800">
                          <span className="text-zinc-300 tabular-nums">
                            {aiBatchProgress.stopping ? "Stopping…" : `${aiBatchProgress.current.toLocaleString()} of ${plural(aiBatchProgress.total, "photo")}`}
                          </span>
                          <button onClick={handleStopAiBatch} disabled={aiBatchProgress.stopping} className="text-zinc-400 hover:text-zinc-100 disabled:opacity-50">
                            Stop
                          </button>
                        </div>
                      ) : platform.localFiles && ollamaStatus && !ollamaStatus.running ? (
                        <button
                          onClick={startOllama}
                          disabled={isStartingOllama}
                          className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-100 disabled:opacity-60"
                        >
                          {isStartingOllama ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
                          <span>{isStartingOllama ? "Starting Ollama…" : "Start Ollama"}</span>
                        </button>
                      ) : ollamaStatus?.running && !hasVisionModel ? (
                        <button
                          onClick={() => {
                            setIsAiMenuOpen(false);
                            triggerModelPull(DEFAULT_AI_MODEL);
                          }}
                          className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Download the AI model (about 6 GB)</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setIsAiMenuOpen(false);
                            runBatchAiOnList(visiblePhotos);
                          }}
                          disabled={!ollamaStatus || visiblePhotos.length === 0}
                          className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50"
                          title="Photos that already have a caption are skipped unless you choose otherwise"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>Write captions for the {plural(visiblePhotos.length, "photo")} shown</span>
                        </button>
                      )}
                    </div>

                    {(flashAttentionOff || tuningState === "done" || tuningState === "error") && (
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col gap-1.5">
                        {tuningState === "done" ? (
                          <span className="text-[11px] text-zinc-300">Faster captions are on: about 10–15% faster.</span>
                        ) : (
                          <>
                            <span className="text-[11px] text-zinc-300">Captions can be about 10–15% faster, with the same results.</span>
                            <button
                              onClick={enableFlashAttention}
                              disabled={tuningState === "working" || Boolean(aiBatchProgress)}
                              title={aiBatchProgress ? "Wait for the AI captions to finish" : "Turns on Ollama's flash attention and restarts Ollama"}
                              className="self-start flex items-center gap-1 text-[11px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-60 text-zinc-100 px-2.5 py-1 rounded-lg font-medium"
                            >
                              <Zap className="w-3 h-3" />
                              <span>{tuningState === "working" ? "Restarting Ollama…" : "Make captions faster"}</span>
                            </button>
                            {tuningState === "error" && <span className="text-[11px] text-red-300">{tuningError}</span>}
                          </>
                        )}
                      </div>
                    )}

                    {ollamaStatus?.running && hasVisionModel && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-zinc-500 font-medium">AI model</label>
                        <select
                          value={aiModel}
                          onChange={(e) => setAiModel(e.target.value)}
                          className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-zinc-200 text-[11px] focus:outline-none focus:border-emerald-500/80"
                        >
                          {ollamaStatus.installed_models.map((m) => (
                            <option key={m.name} value={m.name} className="bg-zinc-900 text-zinc-200">
                              {m.name} ({m.size_gb} GB)
                            </option>
                          ))}
                        </select>
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-zinc-500">
                            {ollamaStatus.active_vram_model ? "Ready on the graphics card" : "Loads with the first photo"}
                          </span>
                          {ollamaStatus.active_vram_model ? (
                            <button
                              onClick={async () => {
                                if (ollamaStatus.active_vram_model) {
                                  await call("unload_ollama_vram", { modelName: ollamaStatus.active_vram_model });
                                  setOllamaStatus(await call<OllamaStatus>("check_ollama_status"));
                                }
                              }}
                              className="text-[11px] text-zinc-400 hover:text-zinc-100"
                              title="Frees the graphics card's memory for other programs"
                            >
                              Free memory
                            </button>
                          ) : (
                            <button
                              onClick={async () => {
                                setIsLoadingVram(true);
                                try {
                                  await call("preload_ollama_vram", { modelName: aiModel });
                                  setOllamaStatus(await call<OllamaStatus>("check_ollama_status"));
                                } catch (err) {
                                  console.error("Loading the AI model failed:", err);
                                } finally {
                                  // Never leave the button stuck in its disabled "loading" state
                                  setIsLoadingVram(false);
                                }
                              }}
                              disabled={isLoadingVram}
                              className="text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
                              title="Loads the model now, so the first caption doesn't wait for it"
                            >
                              {isLoadingVram ? "Loading…" : "Load now"}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Settings and help: Settings first, the interface mode, then help */}
        <div ref={toolsMenuRef} className="relative">
          <button
            onClick={() => setIsToolsMenuOpen((p) => !p)}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 transition"
            title="Settings and help"
            aria-label="Settings and help"
          >
            <Settings className="w-4 h-4" />
          </button>

          {isToolsMenuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-64 bg-raised border border-zinc-700/80 rounded-xl shadow-2xl p-2 z-50 flex flex-col gap-1 text-xs">
              {onOpenSettings && (
                <button
                  onClick={() => {
                    setIsToolsMenuOpen(false);
                    onOpenSettings();
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
                >
                  <span className="flex items-center gap-2.5">
                    <Settings className="w-4 h-4 text-zinc-400 shrink-0" />
                    <span>Settings</span>
                  </span>
                  <kbd className="px-1.5 py-0.2 bg-zinc-950 border border-zinc-700 rounded text-[11px] font-mono text-zinc-400">Ctrl+,</kbd>
                </button>
              )}

              {toggleSimpleMode && (
                <div className="p-2 rounded-lg bg-zinc-900/80 flex items-center justify-between" title="Simple hides the more technical tools; Advanced shows everything">
                  <span className="text-xs text-zinc-300">Interface</span>
                  <div className="flex bg-zinc-950 border border-zinc-800 rounded-md p-0.5 text-[11px]">
                    {([
                      [true, "Simple"],
                      [false, "Advanced"],
                    ] as const).map(([simple, label]) => (
                      <button
                        key={label}
                        onClick={() => {
                          if (simpleMode !== simple) toggleSimpleMode();
                        }}
                        className={`px-2 py-0.5 rounded ${
                          simpleMode === simple ? "bg-emerald-500/15 text-emerald-300 font-semibold" : "text-zinc-500"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="my-1 border-t border-zinc-800" />

              {setIsShortcutsModalOpen && (
                <button
                  onClick={() => {
                    setIsToolsMenuOpen(false);
                    setIsShortcutsModalOpen(true);
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
                >
                  <span className="flex items-center gap-2.5">
                    <HelpCircle className="w-4 h-4 text-zinc-400 shrink-0" />
                    <span>Keyboard shortcuts</span>
                  </span>
                  <kbd className="px-1.5 py-0.2 bg-zinc-950 border border-zinc-700 rounded text-[11px] font-mono text-zinc-400">?</kbd>
                </button>
              )}

              {onOpenWelcomeTour && (
                <button
                  onClick={() => {
                    setIsToolsMenuOpen(false);
                    onOpenWelcomeTour();
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
                >
                  <span className="flex items-center gap-2.5">
                    <Sparkles className="w-4 h-4 text-zinc-400 shrink-0" />
                    <span>Welcome tour</span>
                  </span>
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
                    <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
                    <span>What Lumina did</span>
                  </span>
                  {sessionLogsCount > 0 && <span className="text-[11px] text-zinc-500 tabular-nums">{sessionLogsCount}</span>}
                </button>
              )}
            </div>
          )}
        </div>

        {!platform.fileDialogs && <WebUploadButton className="!rounded-lg !p-1.5 [&_svg]:!w-4 [&_svg]:!h-4" />}
        <AccountMenu />

        <button
          onClick={() => setIsRightCollapsed((p) => !p)}
          className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition"
          title={isRightCollapsed ? "Expand right inspector" : "Collapse right inspector"}
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
