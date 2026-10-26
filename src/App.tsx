import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLibraryState } from "./hooks/useLibraryState";
import { useKeyboardShortcuts, isEditableTarget } from "./hooks/useKeyboardShortcuts";
import { diskPathOf } from "./utils/rawPairs";
import TopHeaderBar from "./components/layout/TopHeaderBar";
import LeftSidebar from "./components/layout/LeftSidebar";
import RightInspector from "./components/layout/RightInspector";
import BottomStatusBar from "./components/layout/BottomStatusBar";
import SplashScreen from "./components/layout/SplashScreen";
import {
  PhotoContextMenu,
  FolderContextMenu,
  ContextMenuPosition,
} from "./components/layout/ContextMenu";
import TimelineDrawer from "./components/views/TimelineDrawer";
import CompareView from "./components/views/CompareView";
import VirtualPhotoGrid from "./components/views/VirtualPhotoGrid";
import PhotoMap from "./components/views/PhotoMap";
import BulkActionDock from "./components/modals/BulkActionDock";
import CommitModal from "./components/modals/CommitModal";
import HealthXmpModal from "./components/modals/HealthXmpModal";
import LoupeModal from "./components/modals/LoupeModal";
import OperationProgressModal from "./components/modals/OperationProgressModal";
import AiBatchReportModal from "./components/modals/AiBatchReportModal";
import SessionLogModal from "./components/modals/SessionLogModal";
import FaceMatchReviewModal, { UNKNOWN_FACES } from "./components/modals/FaceMatchReviewModal";
import {
  AutoStagePreset,
  OrientationFilter,
  PhotoItem,
  SortOption,
} from "./types/lumina";
import {
  AlertCircle,
  ArrowUpDown,
  Calendar,
  ChevronDown,
  Clock,
  Compass,
  Crosshair,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSync,
  HelpCircle,
  Layers,
  Loader2,
  MapPin,
  ScanFace,
  Sparkles,
  User,
  X,
} from "lucide-react";

export default function App() {
  const lib = useLibraryState();

  // 3-Pane Resizable & Collapsible State
  const [leftWidth, setLeftWidth] = useState<number>(250);
  const [rightWidth, setRightWidth] = useState<number>(380);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState<boolean>(false);
  const [isRightCollapsed, setIsRightCollapsed] = useState<boolean>(false);
  const [centerWidth, setCenterWidth] = useState<number>(960);
  const draggingPaneRef = useRef<"left" | "right" | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const centerMainRef = useRef<HTMLElement>(null);

  // Global Drag-and-Drop State
  const [isDraggingOverWindow, setIsDraggingOverWindow] = useState<boolean>(false);

  // Context Menu State (Photos & Folders)
  const [photoMenuPos, setPhotoMenuPos] = useState<ContextMenuPosition | null>(null);
  const [contextPhoto, setContextPhoto] = useState<PhotoItem | null>(null);
  const [folderMenuPos, setFolderMenuPos] = useState<ContextMenuPosition | null>(null);
  const [contextFolderRel, setContextFolderRel] = useState<string>("");

  // New Subfolder Modal State
  const [isNewFolderModalOpen, setIsNewFolderModalOpen] = useState<boolean>(false);
  const [newFolderInput, setNewFolderInput] = useState<string>("");

  // Pane Resize Listeners
  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!draggingPaneRef.current) return;
      const maxAllowed = Math.floor(window.innerWidth * 0.78);
      if (draggingPaneRef.current === "left") {
        setLeftWidth(Math.max(160, Math.min(maxAllowed, e.clientX)));
      } else if (draggingPaneRef.current === "right") {
        setRightWidth(Math.max(260, Math.min(maxAllowed, window.innerWidth - e.clientX)));
      }
    }
    function handleMouseUp() {
      if (draggingPaneRef.current) {
        draggingPaneRef.current = null;
        document.body.style.cursor = "";
      }
    }
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Global Tauri Drag & Drop Folder/File Listener: registered once (re-registering every render leaked
  // listeners, so one drop could start several concurrent folder loads)
  const loadFolderRef = useRef(lib.handleLoadFolderPath);
  loadFolderRef.current = lib.handleLoadFolderPath;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over" || event.payload.type === "enter") {
            setIsDraggingOverWindow(true);
          } else if (event.payload.type === "drop") {
            setIsDraggingOverWindow(false);
            const droppedPath = event.payload.paths?.[0];
            if (droppedPath) {
              loadFolderRef.current(droppedPath);
            }
          } else {
            setIsDraggingOverWindow(false);
          }
        })
        .then((fn) => {
          // If the component unmounted before registration finished, unregister immediately
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {}
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Global Undo/Redo (`Ctrl+Z` / `Ctrl+Y`), Shortcuts (`?`), and Session Log (`Ctrl+L`) Listener.
  // Registered once; reads the latest handlers through a ref.
  const extraKeysRef = useRef({ lib, isBlockingModalOpen: false });
  useEffect(() => {
    function handleExtraKeys(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      const { lib: l, isBlockingModalOpen: blocked } = extraKeysRef.current;
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;

      if (mod && key === "z" && !e.shiftKey) {
        // Undo/redo would change photos behind an open dialog (Face Review has its own Ctrl+Z)
        if (blocked) return;
        e.preventDefault();
        l.handleUndo();
      } else if (mod && (key === "y" || (e.shiftKey && key === "z"))) {
        if (blocked) return;
        e.preventDefault();
        l.handleRedo();
      } else if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        l.setIsShortcutsModalOpen((prev) => !prev);
      } else if (key === "l" && mod) {
        e.preventDefault();
        l.setIsSessionLogModalOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleExtraKeys);
    return () => window.removeEventListener("keydown", handleExtraKeys);
  }, []);

  // Block native browser right-click menu everywhere except inside text inputs,
  // while opening custom context menus strictly on Photo cards & Folder tree items!
  const handleRootContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const tag = target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      return; // allow normal Cut/Copy/Paste inside text fields
    }
    e.preventDefault();
    setPhotoMenuPos(null);
    setFolderMenuPos(null);
  }, []);

  const handlePhotoContextMenu = useCallback(
    (photo: PhotoItem, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setFolderMenuPos(null);
      setContextPhoto(photo);
      lib.setActiveHash(photo.hash);
      if (!lib.selectedHashes.has(photo.hash)) {
        lib.setSelectedHashes(new Set([photo.hash]));
      }
      setPhotoMenuPos({ x: e.clientX, y: e.clientY });
    },
    [lib.selectedHashes]
  );

  const handleFolderContextMenu = useCallback(
    (folderRelPath: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPhotoMenuPos(null);
      setContextFolderRel(folderRelPath);
      setFolderMenuPos({ x: e.clientX, y: e.clientY });
    },
    []
  );

  // Observe both centerMainRef and gridContainerRef so centerWidth is ALWAYS accurate
  // even when transitioning from 0 photos (onboarding) to a loaded photo library!
  useEffect(() => {
    const mainEl = centerMainRef.current;
    const gridEl = gridContainerRef.current;
    if (!mainEl && !gridEl) return;

    const updateWidth = () => {
      const w = gridEl?.clientWidth || mainEl?.clientWidth || 960;
      if (w > 100) {
        setCenterWidth(w - 32); // subtract 32px for p-4 horizontal grid padding
      }
    };

    updateWidth();

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 100) {
          setCenterWidth(w);
        }
      }
    });

    if (mainEl) ro.observe(mainEl);
    if (gridEl) ro.observe(gridEl);
    return () => ro.disconnect();
  }, [lib.viewMode, lib.photos.length, isLeftCollapsed, isRightCollapsed]);

  const { gridColumns, cardThumbHeight, rowEstimateHeight } = useMemo(() => {
    const safeWidth = Math.max(320, centerWidth);
    const targetCardW = 115 + lib.zoomLevel * 325;
    const cols = Math.max(1, Math.min(12, Math.floor(safeWidth / targetCardW)));
    const actualCardW = Math.floor((safeWidth - (cols - 1) * 14) / cols);
    const thumbH = Math.max(90, Math.min(380, Math.round(actualCardW * 0.74)));
    return {
      gridColumns: cols,
      cardThumbHeight: thumbH,
      rowEstimateHeight: thumbH + 46,
    };
  }, [lib.zoomLevel, centerWidth]);

  const rowCount = Math.ceil(lib.visiblePhotos.length / gridColumns);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => gridContainerRef.current,
    estimateSize: () => rowEstimateHeight,
    overscan: 3,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowEstimateHeight, gridColumns, rowVirtualizer]);

  const navigateByOffset = useCallback(
    (offset: number, extendSelection: boolean) => {
      if (lib.visiblePhotos.length === 0) return;
      const curIdx = lib.activeHash
        ? lib.visiblePhotos.findIndex((p) => p.hash === lib.activeHash)
        : -1;
      const nextIdx =
        curIdx === -1
          ? 0
          : Math.max(0, Math.min(lib.visiblePhotos.length - 1, curIdx + offset));

      const targetPhoto = lib.visiblePhotos[nextIdx];
      if (!targetPhoto) return;

      lib.setActiveHash(targetPhoto.hash);
      const anchorHash = lib.selectionAnchorHashRef.current;
      const anchorIdx = anchorHash
        ? lib.visiblePhotos.findIndex((p) => p.hash === anchorHash)
        : -1;
      if (extendSelection && anchorIdx !== -1) {
        const start = Math.min(anchorIdx, nextIdx);
        const end = Math.max(anchorIdx, nextIdx);
        const nextSet = new Set(lib.selectedHashes);
        for (let i = start; i <= end; i++) nextSet.add(lib.visiblePhotos[i].hash);
        lib.setSelectedHashes(nextSet);
      } else {
        lib.setSelectedHashes(new Set([targetPhoto.hash]));
        lib.selectionAnchorHashRef.current = targetPhoto.hash;
      }

      const targetRow = Math.floor(nextIdx / gridColumns);
      rowVirtualizer.scrollToIndex(targetRow, { align: "auto" });
    },
    [
      lib.visiblePhotos,
      lib.activeHash,
      gridColumns,
      lib.selectedHashes,
      rowVirtualizer,
    ]
  );

  // Explorer-style: right-clicking a photo inside the selection acts on the whole selection,
  // right-clicking any other photo acts on that photo only (and selects it)
  function contextMenuTargets(hash: string): string[] {
    if (lib.selectedHashes.has(hash)) return Array.from(lib.selectedHashes);
    lib.setSelectedHashes(new Set([hash]));
    return [hash];
  }

  // Dialogs that sit on top of the grid: while one is open, grid shortcuts must not touch photos behind it.
  // (The Loupe is deliberately not here: triaging inside the Loupe is the point of it.)
  const isBlockingModalOpen =
    lib.isCommitModalOpen ||
    lib.isHealthModalOpen ||
    lib.isSessionLogModalOpen ||
    lib.isShortcutsModalOpen ||
    Boolean(lib.faceReviewPerson) ||
    Boolean(lib.aiBatchReport) ||
    isNewFolderModalOpen ||
    Boolean(lib.isScanningFolder || lib.scanProgress || lib.ollamaPullProgress);

  const closeBlockingModals = () => {
    lib.setIsCommitModalOpen(false);
    lib.setIsHealthModalOpen(false);
    lib.setIsSessionLogModalOpen(false);
    lib.setIsShortcutsModalOpen(false);
    lib.setAiBatchReport(null);
    setIsNewFolderModalOpen(false);
    // Face Review handles Escape itself (it may first close its own spotlight view)
  };

  // Batch AI speed and remaining time, from the photos finished so far
  const aiBatchRate = (() => {
    const prog = lib.aiBatchProgress;
    if (!prog || prog.current < 2) return null;
    const minutes = (Date.now() - prog.startedAt) / 60000;
    if (minutes <= 0) return null;
    const perMinute = prog.current / minutes;
    const remainingMin = (prog.total - prog.current) / perMinute;
    const etaLabel =
      remainingMin < 1 ? `${Math.max(1, Math.round(remainingMin * 60))} s` : `${Math.round(remainingMin)} min`;
    return { perMinute, etaLabel };
  })();

  extraKeysRef.current = { lib, isBlockingModalOpen };

  useKeyboardShortcuts({
    activeHash: lib.activeHash,
    activePhoto: lib.activePhoto,
    selectedHashes: lib.selectedHashes,
    isLoupeOpen: lib.isLoupeOpen,
    setIsLoupeOpen: lib.setIsLoupeOpen,
    setIsDrawingFace: lib.setIsDrawingFace,
    setDrawnBox: lib.setDrawnBox,
    setActiveBulkPopover: lib.setActiveBulkPopover,
    isBlockingModalOpen,
    closeBlockingModals,
    gridColumns,
    navigateByOffset,
    autoAdvance: lib.autoAdvance,
    searchInputRef,
    handleSetFlag: lib.handleSetFlag,
    handleRejectToTrash: lib.handleRejectToTrash,
    handleBatchRate: lib.handleBatchRate,
    handleSetColorLabel: lib.handleSetColorLabel,
    handleRotateSelection: lib.handleRotateSelection,
    handleAiAnalyzeSingle: lib.handleAiAnalyzeSingle,
    setViewMode: lib.setViewMode,
    setCompareZoom: lib.setCompareZoom,
    setComparePan: lib.setComparePan,
    handleToggleBasketSelection: lib.handleToggleBasketSelection,
  });

  return (
    <div
      onContextMenu={handleRootContextMenu}
      className="flex flex-col h-screen bg-[#090a0f] text-zinc-100 select-none overflow-hidden relative"
    >
      {/* Smooth In-App Startup Splash Overlay */}
      <SplashScreen isReady={lib.isAppReady} />

      {/* Full-Window Drag-and-Drop Overlay */}
      {isDraggingOverWindow && (
        <div className="fixed inset-0 z-[99990] bg-emerald-950/80 backdrop-blur-md border-4 border-dashed border-emerald-400 flex flex-col items-center justify-center gap-3 pointer-events-none animate-in fade-in">
          <FolderOpen className="w-16 h-16 text-emerald-400 animate-bounce" />
          <h2 className="text-xl font-bold text-white">Drop Photo Folder to Open in Lumina</h2>
          <p className="text-xs text-emerald-200 font-mono">
            Instant SQLite WAL indexing & RAW / HEIC preview extraction
          </p>
        </div>
      )}

      <TopHeaderBar
        folder={lib.folder}
        photos={lib.photos}
        visiblePhotos={lib.visiblePhotos}
        stagedPhotosCount={lib.stagedPhotos.length}
        gpsPhotosCount={lib.gpsPhotosCount}
        isLeftCollapsed={isLeftCollapsed}
        setIsLeftCollapsed={setIsLeftCollapsed}
        isRightCollapsed={isRightCollapsed}
        setIsRightCollapsed={setIsRightCollapsed}
        isScanningFolder={lib.isScanningFolder}
        viewMode={lib.viewMode}
        setViewMode={lib.setViewMode}
        setCompareZoom={lib.setCompareZoom}
        setComparePan={lib.setComparePan}
        searchQuery={lib.searchQuery}
        setSearchQuery={lib.setSearchQuery}
        searchInputRef={searchInputRef}
        ollamaStatus={lib.ollamaStatus}
        setOllamaStatus={lib.setOllamaStatus}
        aiModel={lib.aiModel}
        setAiModel={lib.setAiModel}
        isLoadingVram={lib.isLoadingVram}
        setIsLoadingVram={lib.setIsLoadingVram}
        faceScanProgress={lib.faceScanProgress}
        faceModelDownload={lib.faceModelDownload}
        aiBatchProgress={lib.aiBatchProgress}
        handleStopAiBatch={lib.handleStopAiBatch}
        handleOpenFolder={lib.handleOpenFolder}
        handleRescanFolder={lib.handleRescanFolder}
        handleRescanAndProcessFolder={lib.handleRescanAndProcessFolder}
        handleOpenHealthDashboard={lib.handleOpenHealthDashboard}
        setIsCommitModalOpen={lib.setIsCommitModalOpen}
        handleDismissAllStaged={lib.handleDismissAllStaged}
        handleBatchScanFacesOnnx={lib.handleBatchScanFacesOnnx}
        handleCancelFaceScan={lib.handleCancelFaceScan}
        runBatchAiOnList={lib.runBatchAiOnList}
        simpleMode={lib.simpleMode}
        toggleSimpleMode={lib.toggleSimpleMode}
        canUndo={lib.canUndo}
        canRedo={lib.canRedo}
        handleUndo={lib.handleUndo}
        handleRedo={lib.handleRedo}
        setIsShortcutsModalOpen={lib.setIsShortcutsModalOpen}
        setIsSessionLogModalOpen={lib.setIsSessionLogModalOpen}
        sessionLogsCount={lib.sessionLogs.length}
        handlePullDefaultAiModel={lib.handlePullDefaultAiModel}
        totalPendingFaceMatches={Object.values(lib.pendingFaceCounts).reduce((a, b) => a + b, 0)}
        onOpenFaceReviewStudio={() =>
          lib.setFaceReviewPerson(lib.people[0]?.name || UNKNOWN_FACES)
        }
      />

      {/* Live Batch AI Progress Banner with Filename, Success/Fail Telemetry & Stop Button */}
      {lib.aiBatchProgress && (
        <div className="px-5 py-2 bg-indigo-950/90 border-b border-indigo-500/40 flex items-center justify-between gap-4 text-xs shrink-0 z-20">
          <div className="flex items-center gap-2.5 truncate">
            <Loader2 className="w-4 h-4 animate-spin text-indigo-400 shrink-0" />
            <span className="font-semibold text-indigo-100">
              AI Batch Tagging ({lib.aiBatchProgress.current} / {lib.aiBatchProgress.total})
            </span>
            {lib.aiBatchProgress.currentFile && (
              <span className="text-indigo-300 font-mono text-[11px] truncate">
                — {lib.aiBatchProgress.currentFile}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-44 h-2 bg-zinc-900 rounded-full overflow-hidden border border-indigo-500/30">
              <div
                style={{
                  width: `${Math.min(
                    100,
                    Math.round(
                      (lib.aiBatchProgress.current / Math.max(1, lib.aiBatchProgress.total)) * 100
                    )
                  )}%`,
                }}
                className="h-full bg-indigo-500 transition-all duration-200"
              />
            </div>
            <span className="font-mono text-[11px] text-emerald-400">
              ✓ {lib.aiBatchProgress.succeeded}
            </span>
            {lib.aiBatchProgress.failed > 0 && (
              <span className="font-mono text-[11px] text-amber-400">
                ⚠ {lib.aiBatchProgress.failed}
              </span>
            )}
            {aiBatchRate && (
              <span className="font-mono text-[11px] text-indigo-200" title="Photos per minute · estimated time remaining">
                {aiBatchRate.perMinute.toFixed(1)}/min · ~{aiBatchRate.etaLabel} left
              </span>
            )}
            <button
              onClick={lib.handleStopAiBatch}
              disabled={lib.aiBatchProgress.stopping}
              className="px-2.5 py-0.5 bg-red-600 hover:bg-red-500 disabled:opacity-70 text-white rounded font-semibold text-[11px]"
            >
              {lib.aiBatchProgress.stopping ? "Stopping…" : "Stop"}
            </button>
          </div>
        </div>
      )}

      {/* Top People Carousel with Pending Face Match Badges */}
      {lib.people.length > 0 && (
        <div className="px-5 py-1.5 bg-[#0c0d14] border-b border-zinc-800/50 flex items-center gap-2 overflow-x-auto shrink-0">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mr-1 shrink-0">
            People
          </span>

          {lib.people.map((p) => {
            const isSelected = lib.selectedPerson === p.name;
            const pendingCount = lib.pendingFaceCounts[p.name] || 0;
            return (
              <div
                key={p.name}
                className={`flex items-center rounded-full text-xs transition shrink-0 border overflow-hidden ${
                  isSelected
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-sm"
                    : "bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 border-zinc-800/80"
                }`}
              >
                <button
                  onClick={() => lib.setSelectedPerson(isSelected ? null : p.name)}
                  className="flex items-center gap-2 px-2.5 py-1"
                  title={`Filter photos by ${p.name}`}
                >
                  {p.cover_thumb ? (
                    <img
                      src={convertFileSrc(p.cover_thumb)}
                      alt={p.name}
                      className="w-5 h-5 rounded-full object-cover border border-zinc-700"
                    />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-zinc-800 flex items-center justify-center">
                      <User className="w-3 h-3 text-zinc-400" />
                    </div>
                  )}
                  <span className="font-medium text-[11px] capitalize">{p.name}</span>
                  <span className="text-[10px] text-zinc-500 font-mono">{p.photo_count}</span>
                </button>

                {pendingCount > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      lib.setFaceReviewPerson(p.name);
                    }}
                    className="px-2 py-1 bg-amber-500/20 hover:bg-amber-500/35 border-l border-amber-500/30 text-amber-300 font-mono text-[10px] font-bold flex items-center gap-0.5 transition"
                    title={`${pendingCount} unassigned face(s) look like ${p.name} — Click to review & confirm!`}
                  >
                    <span>+{pendingCount}?</span>
                  </button>
                )}
              </div>
            );
          })}

          <button
            onClick={() =>
              lib.setFaceReviewPerson(
                lib.people.find((p) => (lib.pendingFaceCounts[p.name] || 0) > 0)?.name ||
                  lib.people[0]?.name ||
                  ""
              )
            }
            className="ml-auto px-2.5 py-1 rounded-full bg-indigo-950/70 hover:bg-indigo-900 text-indigo-300 border border-indigo-500/40 text-[11px] font-semibold flex items-center gap-1.5 shrink-0 transition"
            title="Open Face Match Review & Confirmation Studio"
          >
            <ScanFace className="w-3.5 h-3.5 text-indigo-400" />
            <span>Review Face Matches</span>
          </button>
        </div>
      )}

      {/* Main Resizable 3-Pane Workspace */}
      <div className="flex flex-1 overflow-hidden relative">
        {!isLeftCollapsed && (
          <>
            <LeftSidebar
              leftWidth={leftWidth}
              photos={lib.photos}
              simpleMode={lib.simpleMode}
              smartFilter={lib.smartFilter}
              setSmartFilter={lib.setSmartFilter}
              selectedPerson={lib.selectedPerson}
              setSelectedPerson={lib.setSelectedPerson}
              activeSubfolder={lib.activeSubfolder}
              setActiveSubfolder={lib.setActiveSubfolder}
              activeEvent={lib.activeEvent}
              setActiveEvent={lib.setActiveEvent}
              activeTag={lib.activeTag}
              setActiveTag={lib.setActiveTag}
              picksCount={lib.picksCount}
              basketCount={lib.basketCount}
              rejectsCount={lib.rejectsCount}
              screenshotPhotosCount={lib.screenshotPhotosCount}
              totalBurstGroups={lib.totalBurstGroups}
              duplicatePhotosCount={lib.duplicatePhotosCount}
              gpsPhotosCount={lib.gpsPhotosCount}
              stagedPhotosCount={lib.stagedPhotos.length}
              folderTree={lib.folderTree}
              expandedFolders={lib.expandedFolders}
              setExpandedFolders={lib.setExpandedFolders}
              autoEvents={lib.autoEvents}
              allLibraryTags={lib.allLibraryTags}
              handleEmptyTrashToRecycleBin={lib.handleEmptyTrashToRecycleBin}
              onFolderContextMenu={handleFolderContextMenu}
            />

            <div
              onMouseDown={() => {
                draggingPaneRef.current = "left";
                document.body.style.cursor = "col-resize";
              }}
              className="w-1 bg-zinc-800/50 hover:bg-emerald-500 active:bg-emerald-400 cursor-col-resize transition-colors shrink-0 z-10"
              title="Drag to resize left pane"
            />
          </>
        )}

        {/* CENTER VIRTUALIZED CANVAS */}
        <main
          ref={centerMainRef}
          className="flex-1 bg-[#090a0f] flex flex-col overflow-hidden relative min-w-[260px]"
        >
          {lib.isTimelineOpen && (
            <TimelineDrawer
              timelineBuckets={lib.timelineBuckets}
              selectedPeriodRange={lib.selectedPeriodRange}
              setSelectedPeriodRange={lib.setSelectedPeriodRange}
              dragAnchorDay={lib.dragAnchorDay}
              setDragAnchorDay={lib.setDragAnchorDay}
              setIsTimelineOpen={lib.setIsTimelineOpen}
            />
          )}

          {/* Streamlined Middle Toolbar */}
          {lib.photos.length > 0 && (
            <div className="bg-[#0c0d14] border-b border-zinc-800/60 px-4 py-1.5 flex items-center justify-between text-xs gap-3 flex-wrap shrink-0">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => lib.setIsTimelineOpen((p) => !p)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                    lib.isTimelineOpen || lib.selectedPeriodRange
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 shadow-sm"
                      : "bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-800"
                  }`}
                  title="Slide out interactive day-by-day Date Timeline Slicer"
                >
                  <Calendar className="w-3.5 h-3.5 text-emerald-400" />
                  <span>
                    {lib.selectedPeriodRange
                      ? `${lib.selectedPeriodRange[0]} ➔ ${lib.selectedPeriodRange[1]}`
                      : lib.simpleMode
                      ? "Filter by Date"
                      : "Timeline"}
                  </span>
                  <ChevronDown
                    className={`w-3 h-3 transition-transform ${
                      lib.isTimelineOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                <label className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={lib.autoAdvance}
                    onChange={(e) => lib.setAutoAdvance(e.target.checked)}
                    className="rounded bg-zinc-800 border-zinc-700 text-emerald-500 focus:ring-0 cursor-pointer"
                  />
                  <span>Auto-Advance</span>
                </label>

                {lib.totalBurstGroups > 0 && (
                  <button
                    onClick={() => lib.setShowAllBurstVersions((prev) => !prev)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                      lib.showAllBurstVersions
                        ? "bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm"
                        : "bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border-zinc-800"
                    }`}
                    title="Expand or collapse all burst / duplicate stacks"
                  >
                    <Layers className="w-3.5 h-3.5 text-amber-400" />
                    <span>
                      {lib.showAllBurstVersions
                        ? "Collapse Bursts"
                        : lib.simpleMode
                        ? "Show Similar Shots"
                        : "Show All Bursts"}
                    </span>
                  </button>
                )}

                {lib.activeSubfolder !== "ALL" && (
                  <span className="bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 px-2.5 py-0.5 rounded-full flex items-center gap-1.5 text-[11px]">
                    <Folder className="w-3 h-3 text-emerald-400" />
                    <span>{lib.activeSubfolder}</span>
                    <button
                      onClick={() => lib.setActiveSubfolder("ALL")}
                      className="hover:text-white ml-0.5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2.5">
                {/* Orientation Filter */}
                <div className="flex bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 text-[11px]">
                  {(["ALL", "LANDSCAPE", "PORTRAIT", "SQUARE"] as OrientationFilter[]).map(
                    (mode) => (
                      <button
                        key={mode}
                        onClick={() => lib.setOrientationFilter(mode)}
                        className={`px-2 py-0.5 rounded transition ${
                          lib.orientationFilter === mode
                            ? "bg-emerald-500/15 text-emerald-300 font-medium"
                            : "text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        {mode === "ALL"
                          ? "All"
                          : mode === "LANDSCAPE"
                          ? "Wide"
                          : mode === "PORTRAIT"
                          ? "Tall"
                          : "Square"}
                      </button>
                    )
                  )}
                </div>

                {/* Sort Selector */}
                <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1">
                  <ArrowUpDown className="w-3.5 h-3.5 text-emerald-400" />
                  <select
                    value={lib.sortBy}
                    onChange={(e) => lib.setSortBy(e.target.value as SortOption)}
                    className="bg-transparent text-zinc-200 font-medium text-xs focus:outline-none cursor-pointer"
                  >
                    <option value="NAME_ASC" className="bg-zinc-900">
                      Alphabetical (A → Z)
                    </option>
                    <option value="NAME_DESC" className="bg-zinc-900">
                      Alphabetical (Z → A)
                    </option>
                    <option value="DATE_DESC" className="bg-zinc-900">
                      Date Captured (Newest)
                    </option>
                    <option value="DATE_ASC" className="bg-zinc-900">
                      Date Captured (Oldest)
                    </option>
                    {!lib.simpleMode && (
                      <>
                        <option value="SCORE_DESC" className="bg-zinc-900">
                          Focus Score (Sharpest)
                        </option>
                        <option value="SCORE_ASC" className="bg-zinc-900">
                          Focus Score (Blurriest)
                        </option>
                      </>
                    )}
                    <option value="RATING_DESC" className="bg-zinc-900">
                      Star Rating (High → Low)
                    </option>
                    <option value="TAG_NAME" className="bg-zinc-900">
                      Primary Tag Name (A → Z)
                    </option>
                    <option value="SIZE_DESC" className="bg-zinc-900">
                      File Size (Largest)
                    </option>
                  </select>
                </div>

                <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                  <select
                    value={lib.autoStagePreset}
                    onChange={(e) =>
                      lib.setAutoStagePreset(e.target.value as AutoStagePreset)
                    }
                    className="bg-transparent text-zinc-300 text-[11px] px-2 py-1 focus:outline-none cursor-pointer border-r border-zinc-800"
                    title="Choose folder structure rule preset"
                  >
                    <option value="YEAR_MONTH_CITY" className="bg-zinc-900">
                      {lib.simpleMode
                        ? "By Year / Month & City"
                        : "Rule: {Year}/{YYYY-MM}_{City}"}
                    </option>
                    <option value="YEAR_MONTH" className="bg-zinc-900">
                      {lib.simpleMode ? "By Year / Month" : "Rule: {Year}/{YYYY-MM}"}
                    </option>
                    <option value="PERSON_YEAR" className="bg-zinc-900">
                      {lib.simpleMode
                        ? "By Person / Year"
                        : "Rule: People/{Person}/{Year}"}
                    </option>
                    <option value="SCREENSHOTS_BY_MONTH" className="bg-zinc-900">
                      {lib.simpleMode
                        ? "Screenshots by Month"
                        : "Rule: _Screenshots/{YYYY-MM}"}
                    </option>
                    <option value="FAVORITES_YEAR" className="bg-zinc-900">
                      {lib.simpleMode ? "Favorites by Year" : "Rule: Favorites/{Year}"}
                    </option>
                  </select>
                  <button
                    onClick={lib.handleAutoOrganizeByPreset}
                    className="flex items-center gap-1.5 text-indigo-200 hover:text-white bg-indigo-950/50 hover:bg-indigo-600 px-2.5 py-1 transition font-medium text-xs"
                    title="Stage visible photos using selected folder rule"
                  >
                    <FolderSync className="w-3.5 h-3.5 text-indigo-400" />
                    <span>{lib.simpleMode ? "Auto-Sort" : "Auto-Stage"}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {(lib.smartFilter === "DUPLICATES" || lib.showAllBurstVersions) &&
            lib.duplicatePhotosCount > 0 && (
              <div className="bg-amber-950/30 border-b border-amber-500/30 px-5 py-2 flex items-center justify-between shrink-0">
                <span className="text-xs text-amber-200">
                  Comparing <strong>{lib.totalBurstGroups}</strong> Burst Groups (
                  {lib.duplicatePhotosCount} items):
                </span>
                <button
                  onClick={lib.handleKeepSharpestInAllGroups}
                  className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow transition"
                >
                  Keep Sharpest & Stage Rest for _Trash
                </button>
              </div>
            )}

          {lib.viewMode === "map" ? (
            <div className="flex-1 flex flex-col overflow-hidden relative">
              <div className="bg-zinc-900/95 border-b border-zinc-800 px-4 py-2 flex items-center justify-between text-xs z-10">
                <div className="flex items-center gap-2">
                  {lib.isPickingMapLocation ? (
                    <Crosshair className="w-4 h-4 text-emerald-400 animate-pulse" />
                  ) : (
                    <Compass className="w-4 h-4 text-emerald-400" />
                  )}
                  <span className="text-zinc-300">
                    {lib.isPickingMapLocation
                      ? `Click anywhere on the map to assign GPS coordinates to ${lib.selectedHashes.size} selected photo(s)...`
                      : `Showing ${lib.gpsPhotosCount} geotagged photos on map.`}
                  </span>
                </div>
                <button
                  onClick={() => lib.setIsPickingMapLocation((p) => !p)}
                  disabled={lib.selectedHashes.size === 0}
                  className={`px-3 py-1 rounded-lg font-semibold transition flex items-center gap-1.5 ${
                    lib.isPickingMapLocation
                      ? "bg-emerald-600 text-white shadow"
                      : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
                  }`}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>
                    {lib.isPickingMapLocation
                      ? "Cancel Map Pick"
                      : `Click Map to Set GPS (${lib.selectedHashes.size})`}
                  </span>
                </button>
              </div>
              <PhotoMap
                photos={lib.visiblePhotos}
                onSelectPhoto={(h) => lib.setActiveHash(h)}
                isPickingLocation={lib.isPickingMapLocation}
                onMapPickCoordinates={lib.handleMapPickCoordinates}
              />
            </div>
          ) : lib.viewMode === "compare" ? (
            <CompareView
              comparePhotos={lib.comparePhotos}
              activeHash={lib.activeHash}
              setActiveHash={lib.setActiveHash}
              compareZoom={lib.compareZoom}
              setCompareZoom={lib.setCompareZoom}
              comparePan={lib.comparePan}
              setComparePan={lib.setComparePan}
              setViewMode={lib.setViewMode}
              photos={lib.photos}
              setSelectedHashes={lib.setSelectedHashes}
              setAutoMatchNotice={lib.setAutoMatchNotice}
              onKeepAndTrashRest={lib.handleKeepAndTrashRest}
            />
          ) : lib.photos.length === 0 ? (
            <div
              ref={gridContainerRef}
              className="flex-1 overflow-y-auto p-6 flex items-center justify-center"
            >
              <div className="max-w-xl w-full rounded-2xl border-2 border-dashed border-zinc-800 bg-[#0c0d14]/90 hover:border-emerald-500/40 p-8 flex flex-col items-center text-center transition">
                <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-4">
                  <FolderOpen className="w-7 h-7 text-emerald-400" />
                </div>
                <h2 className="text-lg font-bold text-zinc-100">
                  Welcome to Lumina Photo Studio
                </h2>
                <p className="text-xs text-zinc-400 mt-1 max-w-md leading-relaxed">
                  Drag and drop any photo folder onto this window, or click below to open your
                  collection. Supports JPEG, PNG, WebP, HEIC, and Camera RAW (.CR2, .CR3, .NEF,
                  .ARW, .DNG).
                </p>

                <button
                  onClick={lib.handleOpenFolder}
                  className="mt-5 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold shadow-lg transition flex items-center gap-2 cursor-pointer"
                >
                  <FolderOpen className="w-4 h-4" />
                  <span>Choose Photo Folder...</span>
                </button>

                {lib.recentFolders.length > 0 && (
                  <div className="w-full mt-6 pt-5 border-t border-zinc-800/80 flex flex-col gap-2 text-left">
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
                      <Clock className="w-3 h-3 text-emerald-400" />
                      Recent Photo Libraries
                    </span>
                    <div className="flex flex-col gap-1.5">
                      {lib.recentFolders.map((rf) => (
                        <button
                          key={rf}
                          onClick={() => lib.handleLoadFolderPath(rf)}
                          className="w-full px-3 py-2 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-300 hover:text-white flex items-center justify-between transition truncate"
                        >
                          <span className="truncate font-mono text-[11px]">{rf}</span>
                          <span className="text-[10px] text-emerald-400 font-semibold ml-2 shrink-0">
                            Open →
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <VirtualPhotoGrid
              gridContainerRef={gridContainerRef}
              rowVirtualizer={rowVirtualizer}
              gridColumns={gridColumns}
              cardThumbHeight={cardThumbHeight}
              visiblePhotos={lib.visiblePhotos}
              selectedHashes={lib.selectedHashes}
              activeHash={lib.activeHash}
              analyzingHashes={lib.analyzingHashes}
              burstGroupCounts={lib.burstGroupCounts}
              sharpestInGroup={lib.sharpestInGroup}
              showAllBurstVersions={lib.showAllBurstVersions}
              expandedBurstGroups={lib.expandedBurstGroups}
              simpleMode={lib.simpleMode}
              handlePhotoClick={lib.handlePhotoClick}
              onPhotoContextMenu={handlePhotoContextMenu}
              setActiveHash={lib.setActiveHash}
              setIsLoupeOpen={lib.setIsLoupeOpen}
              toggleBurstGroupExpand={lib.toggleBurstGroupExpand}
            />
          )}

          <BulkActionDock
            selectedHashes={lib.selectedHashes}
            setSelectedHashes={lib.setSelectedHashes}
            visiblePhotos={lib.visiblePhotos}
            activeBulkPopover={lib.activeBulkPopover}
            setActiveBulkPopover={lib.setActiveBulkPopover}
            bulkInput={lib.bulkInput}
            setBulkInput={lib.setBulkInput}
            citySearchResults={lib.citySearchResults}
            shiftHoursInput={lib.shiftHoursInput}
            setShiftHoursInput={lib.setShiftHoursInput}
            shiftMinutesInput={lib.shiftMinutesInput}
            setShiftMinutesInput={lib.setShiftMinutesInput}
            setIsPickingMapLocation={lib.setIsPickingMapLocation}
            setViewMode={lib.setViewMode}
            setCompareZoom={lib.setCompareZoom}
            setComparePan={lib.setComparePan}
            handleSetFlag={lib.handleSetFlag}
            handleBatchRate={lib.handleBatchRate}
            handleSetColorLabel={lib.handleSetColorLabel}
            handleRotateSelection={lib.handleRotateSelection}
            handleBatchAddTag={lib.handleBatchAddTag}
            handleBatchStageMove={lib.handleBatchStageMove}
            handleSearchCities={lib.handleSearchCities}
            handleAssignCity={lib.handleAssignCity}
            handleShiftTimestamps={lib.handleShiftTimestamps}
            handleToggleBasketSelection={lib.handleToggleBasketSelection}
            handleForceRescanExifSelected={lib.handleForceRescanExifSelected}
            runBatchAiOnList={lib.runBatchAiOnList}
            handleBatchAssignPerson={lib.handleBatchAssignPerson}
          />
        </main>

        {/* RIGHT INSPECTOR PANE */}
        {!isRightCollapsed && lib.activePhoto && (
          <>
            <div
              onMouseDown={() => {
                draggingPaneRef.current = "right";
                document.body.style.cursor = "col-resize";
              }}
              className="w-1 bg-zinc-800/50 hover:bg-emerald-500 active:bg-emerald-400 cursor-col-resize transition-colors shrink-0 z-10"
              title="Drag to resize right inspector freely"
            />

            <RightInspector
              rightWidth={rightWidth}
              simpleMode={lib.simpleMode}
              activePhoto={lib.activePhoto}
              setPhotos={lib.setPhotos}
              selectedFaceId={lib.selectedFaceId}
              setSelectedFaceId={lib.setSelectedFaceId}
              isDrawingFace={lib.isDrawingFace}
              setIsDrawingFace={lib.setIsDrawingFace}
              drawStart={lib.drawStart}
              setDrawStart={lib.setDrawStart}
              drawnBox={lib.drawnBox}
              setDrawnBox={lib.setDrawnBox}
              faceNameInput={lib.faceNameInput}
              setFaceNameInput={lib.setFaceNameInput}
              isDetectingSingleFace={lib.isDetectingSingleFace}
              analyzingHashes={lib.analyzingHashes}
              isEditingInspectorLocation={lib.isEditingInspectorLocation}
              setIsEditingInspectorLocation={lib.setIsEditingInspectorLocation}
              inspectorLocationQuery={lib.inspectorLocationQuery}
              setInspectorLocationQuery={lib.setInspectorLocationQuery}
              citySearchResults={lib.citySearchResults}
              setCitySearchResults={lib.setCitySearchResults}
              tagInput={lib.tagInput}
              setTagInput={lib.setTagInput}
              setIsLoupeOpen={lib.setIsLoupeOpen}
              setViewMode={lib.setViewMode}
              setSelectedHashes={lib.setSelectedHashes}
              setIsPickingMapLocation={lib.setIsPickingMapLocation}
              handleDetectFacesSingleOnnx={lib.handleDetectFacesSingleOnnx}
              handleSaveFaceAndAutomatch={lib.handleSaveFaceAndAutomatch}
              handleSetFlag={lib.handleSetFlag}
              handleBatchRate={lib.handleBatchRate}
              handleRotateSelection={lib.handleRotateSelection}
              handleSetColorLabel={lib.handleSetColorLabel}
              handleAiAnalyzeSingle={lib.handleAiAnalyzeSingle}
              handleForceRescanExifSelected={lib.handleForceRescanExifSelected}
              handleSearchCities={lib.handleSearchCities}
              handleAssignCity={lib.handleAssignCity}
              handleAssignCustomLocationText={lib.handleAssignCustomLocationText}
              handleBatchAddTag={lib.handleBatchAddTag}
              refreshPeople={lib.refreshPeople}
              onOpenFaceReviewModal={(personName) => lib.setFaceReviewPerson(personName)}
            />
          </>
        )}

        {/* Non-Jumping Floating Toast Notification Stack */}
        {(lib.error || lib.autoMatchNotice) && (
          <div className="fixed bottom-10 right-5 z-[9990] flex flex-col gap-2 max-w-md pointer-events-auto">
            {lib.error && (
              <div className="px-4 py-2.5 bg-red-950/95 border border-red-500/50 text-red-200 rounded-xl shadow-2xl backdrop-blur-md text-xs flex items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{lib.error}</span>
                </div>
                <button
                  onClick={() => lib.setError("")}
                  className="text-red-400 hover:text-white shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {lib.autoMatchNotice && (
              <div className="px-4 py-2.5 bg-[#12141d]/95 border border-emerald-500/40 text-emerald-200 rounded-xl shadow-2xl backdrop-blur-md text-xs flex items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{lib.autoMatchNotice}</span>
                </div>
                <button
                  onClick={() => lib.setAutoMatchNotice("")}
                  className="text-zinc-400 hover:text-white shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Permanent Studio Status Bar */}
      <BottomStatusBar
        totalPhotos={lib.photos.length}
        visibleCount={lib.visiblePhotos.length}
        selectedCount={lib.selectedHashes.size}
        viewMode={lib.viewMode}
        zoomLevel={lib.zoomLevel}
        setZoomLevel={lib.setZoomLevel}
        progress={lib.progress}
        faceScanProgress={lib.faceScanProgress}
        aiBatchProgress={lib.aiBatchProgress}
        sessionLogsCount={lib.sessionLogs.length}
        onOpenSessionLog={() => lib.setIsSessionLogModalOpen(true)}
      />

      {/* Right-Click Photo Context Menu */}
      <PhotoContextMenu
        position={photoMenuPos}
        onClose={() => setPhotoMenuPos(null)}
        onOpenDefault={() => {
          if (contextPhoto) {
            lib.handleOpenInDefaultViewer(
              diskPathOf(contextPhoto)
            );
          }
        }}
        onRevealInFolder={() => {
          if (contextPhoto) {
            lib.handleRevealInFileManager(
              diskPathOf(contextPhoto)
            );
          }
        }}
        onCopyFullImage={async () => {
          if (!contextPhoto) return;
          try {
            await invoke("copy_image_to_clipboard", { path: contextPhoto.path });
            lib.addLog(
              "LIBRARY",
              `Copied full-res image to clipboard: ${contextPhoto.name}`
            );
            lib.setAutoMatchNotice(
              `Copied "${contextPhoto.name}" (full resolution) to clipboard!`
            );
            setTimeout(() => lib.setAutoMatchNotice(""), 3500);
          } catch (err) {
            lib.setError(String(err));
          }
        }}
        onCopyPath={() => {
          if (!contextPhoto) return;
          const diskPath = diskPathOf(contextPhoto);
          navigator.clipboard?.writeText(diskPath).catch(() => {});
          lib.setAutoMatchNotice(`Copied file path: ${diskPath}`);
          setTimeout(() => lib.setAutoMatchNotice(""), 3000);
        }}
        onPickPhoto={() => {
          if (contextPhoto) lib.handleSetFlag("pick", contextMenuTargets(contextPhoto.hash));
        }}
        onStageTrash={() => {
          if (contextPhoto) lib.handleRejectToTrash(contextMenuTargets(contextPhoto.hash));
        }}
      />

      {/* Right-Click Folder Tree Context Menu */}
      <FolderContextMenu
        position={folderMenuPos}
        folderPath={contextFolderRel}
        onClose={() => setFolderMenuPos(null)}
        onRevealFolder={() => {
          if (!lib.folder) return;
          const target =
            contextFolderRel === "Root" || !contextFolderRel
              ? lib.folder
              : `${lib.folder}/${contextFolderRel.replace(/ \/ /g, "/")}`;
          lib.handleRevealInFileManager(target);
        }}
        onCreateSubfolder={() => {
          const prefix =
            contextFolderRel && contextFolderRel !== "Root"
              ? `${contextFolderRel.replace(/ \/ /g, "/")}/`
              : "";
          setNewFolderInput(prefix);
          setIsNewFolderModalOpen(true);
        }}
      />

      {/* Create New Subfolder Dialog */}
      {isNewFolderModalOpen && (
        <div
          onClick={() => setIsNewFolderModalOpen(false)}
          className="fixed inset-0 z-[9995] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newFolderInput.trim()) return;
              await lib.handleCreateSubfolder(newFolderInput.trim());
              setIsNewFolderModalOpen(false);
              setNewFolderInput("");
            }}
            className="bg-[#12141c] border border-zinc-800 rounded-2xl w-full max-w-md p-5 shadow-2xl flex flex-col gap-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-zinc-100 flex items-center gap-2">
                <FolderPlus className="w-4 h-4 text-emerald-400" />
                Create New Subfolder
              </span>
              <button
                type="button"
                onClick={() => setIsNewFolderModalOpen(false)}
                className="text-zinc-500 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              type="text"
              value={newFolderInput}
              onChange={(e) => setNewFolderInput(e.target.value)}
              placeholder="e.g. 2026/Selects or Favorites"
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono text-xs focus:outline-none focus:border-emerald-500"
              autoFocus
            />
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setIsNewFolderModalOpen(false)}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-semibold"
              >
                Create Folder
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Live Operation Progress Modal (Folder Scan, Reprocess & Ollama Model Pull) */}
      <OperationProgressModal
        isOpen={Boolean(
          lib.isScanningFolder || lib.scanProgress || lib.ollamaPullProgress
        )}
        title={
          lib.ollamaPullProgress
            ? `Downloading AI Vision Model (${lib.ollamaPullProgress.model})`
            : "Loading & Indexing Photo Library"
        }
        stage={
          lib.ollamaPullProgress
            ? lib.ollamaPullProgress.status
            : lib.scanProgress?.stage || "Scanning directory & EXIF headers..."
        }
        currentFile={
          lib.ollamaPullProgress
            ? `${lib.ollamaPullProgress.completed_mb} MB / ${lib.ollamaPullProgress.total_mb} MB`
            : lib.scanProgress?.current_file
        }
        completed={
          lib.ollamaPullProgress
            ? lib.ollamaPullProgress.percent
            : lib.scanProgress?.completed ?? 0
        }
        total={
          lib.ollamaPullProgress
            ? 100
            : Math.max(1, lib.scanProgress?.total ?? 100)
        }
      />

      {/* Batch AI Post-Run Report Modal with 1-Click Retry Failures */}
      <AiBatchReportModal
        isOpen={Boolean(lib.aiBatchReport)}
        onClose={() => lib.setAiBatchReport(null)}
        succeededCount={lib.aiBatchReport?.succeededCount ?? 0}
        failures={lib.aiBatchReport?.failures ?? []}
        onRetryFailures={(failures) => {
          const retryPhotos = failures.map((f) => f.photo);
          lib.setAiBatchReport(null);
          lib.runBatchAiOnList(retryPhotos, { reanalyze: true });
        }}
      />

      {/* Session Activity Log Modal */}
      <SessionLogModal
        isOpen={lib.isSessionLogModalOpen}
        onClose={() => lib.setIsSessionLogModalOpen(false)}
        logs={lib.sessionLogs}
        onClearLogs={lib.clearSessionLogs}
      />

      {/* Keyboard Shortcuts Cheat Sheet Modal */}
      {lib.isShortcutsModalOpen && (
        <div
          onClick={() => lib.setIsShortcutsModalOpen(false)}
          className="fixed inset-0 z-[9995] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[#12141c] border border-zinc-800 rounded-2xl w-full max-w-lg p-5 shadow-2xl flex flex-col gap-3 text-xs"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <span className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-emerald-400" />
                Lumina Keyboard Shortcuts
              </span>
              <button
                onClick={() => lib.setIsShortcutsModalOpen(false)}
                className="text-zinc-500 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {[
                ["Space", "Open / Close Fullscreen Loupe"],
                ["P / X / U", "Pick / Reject (_Trash) / Unflag"],
                ["1 – 5 / 0", "Set Star Rating / Clear Rating"],
                ["6 / 7 / 8 / 9", "Red / Yellow / Green / Blue Label"],
                ["[ / ]", "Rotate Left / Right 90°"],
                ["B", "Toggle Pinboard Basket"],
                ["A", "Run AI Vision on Active Photo"],
                ["C / G / M", "Compare / Grid / Map View"],
                ["Ctrl + Z / Y", "Undo / Redo Last Action"],
                ["Ctrl + L", "Open Session Activity Log"],
              ].map(([key, desc]) => (
                <div
                  key={key}
                  className="p-2 rounded-lg bg-zinc-900/70 border border-zinc-800/80 flex items-center justify-between gap-2"
                >
                  <span className="text-zinc-400">{desc}</span>
                  <kbd className="px-1.5 py-0.5 bg-zinc-950 border border-zinc-700 rounded text-emerald-300 font-mono text-[10px] shrink-0">
                    {key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <CommitModal
        isOpen={lib.isCommitModalOpen}
        onClose={() => lib.setIsCommitModalOpen(false)}
        stagedPhotos={lib.stagedPhotos}
        setPhotos={lib.setPhotos}
        smartRenameOnCommit={lib.smartRenameOnCommit}
        setSmartRenameOnCommit={lib.setSmartRenameOnCommit}
        handleDismissAllStaged={lib.handleDismissAllStaged}
        handleCommitAllStaged={lib.handleCommitAllStaged}
      />

      <HealthXmpModal
        isOpen={lib.isHealthModalOpen}
        onClose={() => lib.setIsHealthModalOpen(false)}
        healthStats={lib.healthStats}
        isExportingXmp={lib.isExportingXmp}
        handlePruneCache={lib.handlePruneCache}
        handleExportXmp={lib.handleExportXmp}
      />

      <FaceMatchReviewModal
        isOpen={Boolean(lib.faceReviewPerson)}
        initialPerson={lib.faceReviewPerson}
        onClose={() => lib.setFaceReviewPerson(null)}
        people={lib.people}
        pendingCounts={lib.pendingFaceCounts}
        setPhotos={lib.setPhotos}
        refreshPeople={lib.refreshPeople}
        folder={lib.folder}
      />

      <LoupeModal
        isOpen={lib.isLoupeOpen}
        onClose={() => lib.setIsLoupeOpen(false)}
        activePhoto={lib.activePhoto}
        visiblePhotos={lib.visiblePhotos}
        setActiveHash={lib.setActiveHash}
        setSelectedHashes={lib.setSelectedHashes}
        autoAdvance={lib.autoAdvance}
        navigateByOffset={navigateByOffset}
        handleSetFlag={lib.handleSetFlag}
        handleBatchStageMove={lib.handleBatchStageMove}
        handleBatchRate={lib.handleBatchRate}
        handleSetColorLabel={lib.handleSetColorLabel}
        handleToggleBasketSelection={lib.handleToggleBasketSelection}
        handleRotateSelection={lib.handleRotateSelection}
        handleAiAnalyzeSingle={lib.handleAiAnalyzeSingle}
      />
    </div>
  );
}
