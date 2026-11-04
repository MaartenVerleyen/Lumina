import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { ALL_PHOTOS, call, inDesktopApp, OPEN_ADMIN_EVENT, openLibraryIsLocal, READ_ONLY_EVENT } from "./api";
import { platform } from "./api/platform";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLibraryState } from "./hooks/useLibraryState";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { diskPathOf } from "./utils/rawPairs";
import TopHeaderBar from "./components/layout/TopHeaderBar";
import LeftSidebar from "./components/layout/LeftSidebar";
import RightInspector from "./components/layout/RightInspector";
import BottomStatusBar from "./components/layout/BottomStatusBar";
import ToastStack from "./components/layout/ToastStack";
import PhotoToolbar from "./components/layout/PhotoToolbar";
import ExportModal from "./components/modals/ExportModal";
import CollectionsView from "./components/views/CollectionsView";
import PeopleSidebar from "./components/layout/PeopleSidebar";
import ProfilePicturePicker from "./components/modals/ProfilePicturePicker";
import CommandPalette from "./components/modals/CommandPalette";
import { usePhotoDrag, DropTarget } from "./hooks/usePhotoDrag";
import {
  PhotoContextMenu,
  FolderContextMenu,
  ContextMenuPosition,
} from "./components/layout/ContextMenu";
import TimelineDrawer from "./components/views/TimelineDrawer";
import CompareView from "./components/views/CompareView";
import VirtualPhotoGrid, { SQUARE_FOOTER_HEIGHT } from "./components/views/VirtualPhotoGrid";
import {
  buildJustifiedLayout,
  buildSquareLayout,
  monthKeyOf,
  monthLabel,
  verticalNeighbor,
} from "./utils/gridLayout";
import BulkActionDock from "./components/modals/BulkActionDock";
import CommitModal from "./components/modals/CommitModal";
import HealthXmpModal from "./components/modals/HealthXmpModal";
import LoupeModal from "./components/modals/LoupeModal";
import OperationProgressModal from "./components/modals/OperationProgressModal";
import AiBatchReportModal from "./components/modals/AiBatchReportModal";
import SessionLogModal from "./components/modals/SessionLogModal";
import WelcomeTour from "./components/modals/WelcomeTour";
import { useWelcomeTour } from "./hooks/useWelcomeTour";
import FaceMatchReviewModal, { UNKNOWN_FACES } from "./components/modals/FaceMatchReviewModal";
import { PhotoItem } from "./types/lumina";
import { FolderOpen, Loader2 } from "lucide-react";
import { usePaneLayout } from "./app/usePaneLayout";
import { useWindowFileDrop } from "./app/useWindowFileDrop";
import { useClientMode } from "./app/useClientMode";
import { useAppKeys } from "./app/useAppKeys";
import { backgroundJobsOf } from "./app/backgroundJobs";
import { useSearchSuggestions } from "./app/useSearchSuggestions";
import { buildPaletteActions } from "./app/paletteActions";
import FilterBar from "./components/layout/FilterBar";
import ResultBanners from "./components/layout/ResultBanners";
import DragGhost from "./components/layout/DragGhost";
import MapPane from "./components/views/MapPane";
import { NoLibrary, NoMatches } from "./components/views/EmptyStates";
import NewFolderModal from "./components/modals/NewFolderModal";
import ShortcutsModal from "./components/modals/ShortcutsModal";
import ImportModal from "./components/modals/ImportModal";
import HighlightsModal from "./components/modals/HighlightsModal";
import DuplicatesModal from "./components/modals/DuplicatesModal";
import GalleryModal from "./components/modals/GalleryModal";
import RestoreModal from "./components/modals/RestoreModal";
import { scopeTitle } from "./components/layout/PhotoToolbar";
import OnThisDay from "./components/views/OnThisDay";
import SettingsModal, { SettingsSection } from "./components/modals/SettingsModal";
import UpdateBanner from "./components/layout/UpdateBanner";
import { useUpdater } from "./hooks/useUpdater";
import { useThrottled } from "./hooks/useThrottled";
import { useSettings } from "./settings";
import ConfirmDialog from "./components/modals/ConfirmDialog";
import ShareAlbumDialog from "./components/modals/ShareAlbumDialog";
import AdminPage from "./components/admin/AdminPage";
import { useConfirmRequest } from "./confirm";
import { useAccess } from "./components/auth/ServerGate";

export default function App() {
  const lib = useLibraryState();
  const access = useAccess();
  // Best of focuses on the starred people
  const bestOfFocus = useMemo(
    () => ({ starred: new Set(lib.people.filter((p) => p.starred).map((p) => p.name.toLowerCase())) }),
    [lib.people]
  );
  const welcome = useWelcomeTour();
  const settings = useSettings();
  const updater = useUpdater(settings.checkForUpdates);

  const {
    leftWidth,
    rightWidth,
    isLeftCollapsed,
    setIsLeftCollapsed,
    isRightCollapsed,
    setIsRightCollapsed,
    collapsedSections,
    setCollapsedSections,
    isDraggingPane,
    startPaneDrag,
  } = usePaneLayout(lib);
  const [centerWidth, setCenterWidth] = useState<number>(960);


  const searchInputRef = useRef<HTMLInputElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const centerMainRef = useRef<HTMLElement>(null);

  const client = useClientMode(lib, access);
  const isDraggingOverWindow = useWindowFileDrop(client.onDropPaths);


  // Context Menu State (Photos & Folders)
  const [photoMenuPos, setPhotoMenuPos] = useState<ContextMenuPosition | null>(null);
  const [contextPhoto, setContextPhoto] = useState<PhotoItem | null>(null);
  const [folderMenuPos, setFolderMenuPos] = useState<ContextMenuPosition | null>(null);
  const [contextFolderRel, setContextFolderRel] = useState<string>("");

  // New Subfolder Modal State
  const [isNewFolderModalOpen, setIsNewFolderModalOpen] = useState<boolean>(false);
  const [newFolderInput, setNewFolderInput] = useState<string>("");
  const [isPaletteOpen, setIsPaletteOpen] = useState<boolean>(false);
  // The album whose sharing dialog is open (web client)
  const [shareAlbum, setShareAlbum] = useState<{ id: number; name: string; kind?: "album" | "search" } | null>(null);
  // The server's admin page (web client, admins; opened from the account menu)
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  useEffect(() => {
    const open = () => setIsAdminOpen(true);
    window.addEventListener(OPEN_ADMIN_EVENT, open);
    return () => window.removeEventListener(OPEN_ADMIN_EVENT, open);
  }, []);
  // All photos: an edit left photos shared with this user alone (they can look, not change)
  const { setAutoMatchNotice } = lib;
  useEffect(() => {
    const note = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      setAutoMatchNotice(`${n} photo${n === 1 ? " is" : "s are"} shared with you and can't be changed.`);
    };
    window.addEventListener(READ_ONLY_EVENT, note);
    return () => window.removeEventListener(READ_ONLY_EVENT, note);
  }, [setAutoMatchNotice]);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");

  const extraKeysRef = useAppKeys(lib);


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
    // Collections has no grid: measuring the panel there (no scrollbar) would change the width and lay out
    // every photo again, twice (going in and coming back), for nothing
    if (lib.viewMode === "collections") return;

    // Always the same basis: the grid's inner width (clientWidth excludes the scrollbar) minus its p-4
    // padding. Observing two elements and mixing their widths made the column count flicker.
    const target = gridEl || mainEl!;
    const updateWidth = () => {
      const w = target.clientWidth - 32;
      if (w > 100) setCenterWidth(w);
    };

    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(target);
    return () => ro.disconnect();
  }, [lib.viewMode, lib.photos.length, isLeftCollapsed, isRightCollapsed]);

  // Grid layout: rows (and month headers when sorted by date) computed up front for the virtualizer.
  // Smart search ranks by relevance, so its results get no month headers.
  const isDateSorted =
    (lib.gridSortBy === "DATE_DESC" || lib.gridSortBy === "DATE_ASC") && lib.gridSmartFilter !== "DUPLICATES" && !lib.semanticScores;
  const gridGap = lib.gridStyle === "justified" ? 8 : 14;
  // Laying out every photo again for each frame of a divider drag is what made dragging stutter
  const layoutWidth = useThrottled(centerWidth, isDraggingPane, 120);
  const layout = useMemo(() => {
    const width = Math.max(320, layoutWidth);
    const photos = lib.visiblePhotos;
    // Each photo's month worked out once (the layout asks for it more than once per photo)
    const months = isDateSorted ? photos.map((p) => monthKeyOf(p.captured_at)) : [];
    const grouping = isDateSorted ? { groupKey: (i: number) => months[i], groupLabel: monthLabel } : {};
    if (lib.gridStyle === "justified") {
      return buildJustifiedLayout(photos, {
        width,
        gap: gridGap,
        headerHeight: 44,
        targetRowHeight: Math.round(110 + lib.zoomLevel * 300),
        ...grouping,
      });
    }
    const targetCardW = 115 + lib.zoomLevel * 325;
    const columns = Math.max(1, Math.min(12, Math.floor(width / targetCardW)));
    const cardW = Math.floor((width - (columns - 1) * gridGap) / columns);
    const thumbH = Math.max(90, Math.min(380, Math.round(cardW * 0.74)));
    return buildSquareLayout(photos.length, {
      width,
      gap: gridGap,
      headerHeight: 44,
      columns,
      cardHeight: thumbH + SQUARE_FOOTER_HEIGHT,
      ...grouping,
    });
  }, [lib.visiblePhotos, lib.gridStyle, lib.zoomLevel, layoutWidth, isDateSorted, gridGap]);

  const rowVirtualizer = useVirtualizer({
    count: layout.rows.length,
    getScrollElement: () => gridContainerRef.current,
    estimateSize: (i) => {
      const row = layout.rows[i];
      if (!row) return 0;
      return row.kind === "photos" ? row.height + gridGap : row.height;
    },
    overscan: 3,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [layout, rowVirtualizer]);

  // A new order starts at the top: otherwise the grid stays where it was scrolled and the change is easy to miss
  const firstSortRef = useRef(true);
  useEffect(() => {
    if (firstSortRef.current) {
      firstSortRef.current = false;
      return;
    }
    rowVirtualizer.scrollToOffset(0);
  }, [lib.gridSortBy]);

  const navigateToIndex = useCallback(
    (nextIdx: number, extendSelection: boolean) => {
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

      rowVirtualizer.scrollToIndex(layout.rowOfPhoto[nextIdx] ?? 0, { align: "auto" });
    },
    [lib.visiblePhotos, layout, lib.selectedHashes, rowVirtualizer]
  );

  const activeIndex = () =>
    lib.activeHash ? lib.visiblePhotos.findIndex((p) => p.hash === lib.activeHash) : -1;

  // Left/right (and the Loupe): previous/next photo in the list
  const navigateByOffset = (offset: number, extendSelection: boolean) => {
    if (lib.visiblePhotos.length === 0) return;
    const cur = activeIndex();
    const next = cur === -1 ? 0 : Math.max(0, Math.min(lib.visiblePhotos.length - 1, cur + offset));
    navigateToIndex(next, extendSelection);
  };

  // Up/down: the photo in the row above/below that is visually closest (rows differ in length)
  const navigateVertical = (direction: 1 | -1, extendSelection: boolean) => {
    if (lib.visiblePhotos.length === 0) return;
    const cur = activeIndex();
    navigateToIndex(cur === -1 ? 0 : verticalNeighbor(layout, cur, direction), extendSelection);
  };

  // Explorer-style: right-clicking a photo inside the selection acts on the whole selection,
  // right-clicking any other photo acts on that photo only (and selects it)
  function contextMenuTargets(hash: string): string[] {
    if (lib.selectedHashes.has(hash)) return Array.from(lib.selectedHashes);
    lib.setSelectedHashes(new Set([hash]));
    return [hash];
  }

  // People tab: the person whose profile picture is being chosen
  const [coverPickerPerson, setCoverPickerPerson] = useState<string | null>(null);

  // Dialogs that sit on top of the grid: while one is open, grid shortcuts must not touch photos behind it.
  // (The Loupe is deliberately not here: triaging inside the Loupe is the point of it.)
  const confirmRequest = useConfirmRequest();
  const isDialogOpen =
    confirmRequest !== null ||
    isPaletteOpen ||
    isSettingsOpen ||
    lib.importSource !== null ||
    lib.highlights !== null ||
    lib.duplicates !== null ||
    lib.galleryTarget !== null ||
    lib.restoreTarget !== null ||
    welcome.isOpen ||
    lib.exportTargets !== null ||
    lib.isCommitModalOpen ||
    lib.isHealthModalOpen ||
    lib.isSessionLogModalOpen ||
    lib.isShortcutsModalOpen ||
    Boolean(lib.aiBatchReport) ||
    isNewFolderModalOpen ||
    Boolean(lib.faceReviewPerson) ||
    coverPickerPerson !== null ||
    Boolean(lib.isScanningFolder || lib.scanProgress || lib.ollamaPullProgress);
  // Collections shows no photo grid: grid shortcuts (P, X, 1-5 ...) must not act on a hidden selection
  const anyFilterActive =
    lib.smartFilter !== "ALL" ||
    lib.mediaFilter !== "ALL" ||
    lib.searchQuery.trim() !== "" ||
    lib.activeSubfolder !== "ALL" ||
    lib.activeEvent !== "ALL" ||
    lib.activeTag !== "ALL" ||
    lib.activeAlbumId !== null ||
    lib.peopleFilter !== null ||
    lib.hashFilter !== null ||
    lib.selectedPeriodRange !== null;
  const isPhotoTab = lib.viewMode !== "collections";
  const isBlockingModalOpen = isDialogOpen || !isPhotoTab;

  const closeBlockingModals = () => {
    setIsPaletteOpen(false);
    setIsSettingsOpen(false);
    lib.setImportSource(null);
    lib.setHighlights(null);
    lib.setDuplicates(null);
    lib.setGalleryTarget(null);
    lib.setRestoreTarget(null);
    lib.setExportTargets(null);
    lib.setIsCommitModalOpen(false);
    lib.setIsHealthModalOpen(false);
    lib.setIsSessionLogModalOpen(false);
    lib.setIsShortcutsModalOpen(false);
    lib.setAiBatchReport(null);
    setIsNewFolderModalOpen(false);
    // Face Review handles Escape itself (it may first close its own spotlight view)
  };

  // Collections and People open the Photos tab filtered to one album, smart album, trip or person
  const openInPhotos = (apply: () => void) => {
    lib.clearAllFilters();
    apply();
    lib.setViewMode("grid");
  };

  const openFaceReview = () =>
    lib.setFaceReviewPerson(
      lib.people.find((p) => (lib.pendingFaceCounts[p.name] || 0) > 0)?.name || UNKNOWN_FACES
    );


  // The palette opens over the app, but not on top of another dialog
  const togglePalette = () => {
    if (isPaletteOpen) setIsPaletteOpen(false);
    else if (!isDialogOpen) setIsPaletteOpen(true);
  };
  const openSettings = (section: SettingsSection = "general") => {
    setSettingsSection(section);
    setIsSettingsOpen(true);
  };
  extraKeysRef.current = { lib, isBlockingModalOpen, isDialogOpen, canEdit: access.edit, togglePalette, openSettings };

  // ---------- Drag photos onto folders, people and quick filters ----------
  const hashesForDrag = (hash: string): string[] => {
    if (lib.selectedHashes.has(hash)) return Array.from(lib.selectedHashes);
    lib.setSelectedHashes(new Set([hash]));
    lib.setActiveHash(hash);
    lib.selectionAnchorHashRef.current = hash;
    return [hash];
  };
  const handleDropPhotos = (hashes: string[], target: DropTarget) => {
    switch (target.kind) {
      case "folder":
        lib.handleBatchStageMove(target.value, hashes);
        break;
      case "person":
        lib.handleBatchAssignPerson(target.value, hashes);
        break;
      case "trash":
        lib.handleRejectToTrash(hashes);
        break;
      case "pick":
        lib.handleSetFlag("pick", hashes);
        break;
      case "basket":
        lib.handleToggleBasketSelection(hashes, true);
        break;
      default:
        return;
    }
    lib.setAutoMatchNotice(`${target.label}: ${hashes.length} photo(s). Ctrl+Z undoes it.`);
  };
  const { drag, onCardPointerDown: startPhotoDrag } = usePhotoDrag(hashesForDrag, handleDropPhotos);
  // Dropping photos on a folder, person or filter changes them: not for users who may only look
  const onCardPointerDown: typeof startPhotoDrag = access.edit ? startPhotoDrag : () => {};
  const dragPhoto = drag ? lib.visiblePhotos.find((p) => p.hash === drag.thumbHash) : undefined;

  const jobs = [...backgroundJobsOf(lib), ...client.jobs];

  const getSearchSuggestions = useSearchSuggestions(lib);


  // Save the current search as a smart album (input in the filter bar)
  const [saveSearchName, setSaveSearchName] = useState<string | null>(null);

  const paletteActions = buildPaletteActions({
    access,
    lib,
    searchInputRef,
    setSaveSearchName,
    openFaceReview,
    openWelcomeTour: welcome.open,
    openSettings,
    checkForUpdates: updater.checkNow,
    isLeftCollapsed,
    setIsLeftCollapsed,
    isRightCollapsed,
    setIsRightCollapsed,
  });


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
    navigateByOffset,
    navigateVertical,
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
    canEdit: access.edit,
  });

  return (
    <div
      onContextMenu={handleRootContextMenu}
      className="flex flex-col h-screen bg-surface text-zinc-100 select-none overflow-hidden relative"
    >
      {/* Startup splash is the native splash window (closed by close_splashscreen once React runs) */}
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
        onOpenImport={platform.localFiles ? () => lib.openImport() : undefined}
        onOpenServerLibrary={inDesktopApp ? (root, server) => lib.handleLoadFolderPath(root, server) : undefined}
        recentFolders={lib.recentFolders}
        onOpenAllPhotos={inDesktopApp ? () => lib.handleLoadFolderPath(ALL_PHOTOS) : undefined}
        onOpenRecentFolder={platform.fullApp ? (path) => lib.handleLoadFolderPath(path) : undefined}
        onUpload={client.pickAndUpload}
        serverLabel={client.server ? client.serverLabel : undefined}
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
        gridStyle={lib.gridStyle}
        setGridStyle={lib.setGridStyle}
        cardDetails={lib.cardDetails}
        setCardDetails={lib.setCardDetails}
        smartSearch={lib.smartSearch}
        onToggleSmartSearch={lib.toggleSmartSearch}
        getSearchSuggestions={getSearchSuggestions}
        canUndo={lib.canUndo}
        canRedo={lib.canRedo}
        handleUndo={lib.handleUndo}
        handleRedo={lib.handleRedo}
        setIsShortcutsModalOpen={lib.setIsShortcutsModalOpen}
        onOpenWelcomeTour={welcome.open}
        onOpenSettings={() => openSettings()}
        setIsSessionLogModalOpen={lib.setIsSessionLogModalOpen}
        sessionLogsCount={lib.sessionLogs.length}
        handlePullDefaultAiModel={lib.handlePullDefaultAiModel}
        totalPendingFaceMatches={Object.values(lib.pendingFaceCounts).reduce((a, b) => a + b, 0)}
        onOpenFaceReviewStudio={openFaceReview}
      />

      {/* Main Resizable 3-Pane Workspace */}
      <div className="flex flex-1 overflow-hidden relative">
        {!isLeftCollapsed && isPhotoTab && (
          <>
            {lib.viewMode === "people" ? (
              <PeopleSidebar
                width={leftWidth}
                people={lib.people}
                pendingCounts={lib.pendingFaceCounts}
                totalPhotos={lib.photos.length}
                filter={lib.peopleFilter}
                onChange={lib.setPeopleFilter}
                onReview={(name) => lib.setFaceReviewPerson(name)}
                onWhoIsThis={() => lib.setFaceReviewPerson(UNKNOWN_FACES)}
                onChooseCover={setCoverPickerPerson}
                onRename={lib.handleRenamePerson}
                onSetHidden={lib.handleSetPersonHidden}
                onSetStarred={lib.handleSetPersonStarred}
                collapsedSections={collapsedSections}
                onToggleSection={(id) =>
                  setCollapsedSections((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
                }
              />
            ) : (
            <LeftSidebar
              leftWidth={leftWidth}
              photos={lib.photos}
              simpleMode={lib.simpleMode}
              smartFilter={lib.smartFilter}
              setSmartFilter={lib.setSmartFilter}
              hasPeopleFilter={lib.peopleFilter !== null}
              clearPeopleFilter={() => lib.setPeopleFilter(null)}
              activeSubfolder={lib.activeSubfolder}
              setActiveSubfolder={lib.setActiveSubfolder}
              activeEvent={lib.activeEvent}
              setActiveEvent={lib.setActiveEvent}
              setActiveTag={lib.setActiveTag}
              picksCount={lib.picksCount}
              basketCount={lib.basketCount}
              rejectsCount={lib.rejectsCount}
              screenshotPhotosCount={lib.screenshotPhotosCount}
              whatsappPhotosCount={lib.whatsappPhotosCount}
              totalBurstGroups={lib.totalBurstGroups}
              duplicatePhotosCount={lib.duplicatePhotosCount}
              gpsPhotosCount={lib.gpsPhotosCount}
              stagedPhotosCount={lib.stagedPhotos.length}
              eyesClosedCount={lib.eyesClosedCount}
              softFocusCount={lib.softFocusCount}
              videosCount={lib.videosCount}
              mediaFilter={lib.mediaFilter}
              setMediaFilter={lib.setMediaFilter}
              stillsCount={lib.stillsCount}
              shownCount={lib.shownCount}
              folderTree={lib.folderTree}
              expandedFolders={lib.expandedFolders}
              setExpandedFolders={lib.setExpandedFolders}
              handleEmptyTrashToRecycleBin={access.admin ? lib.handleEmptyTrashToRecycleBin : undefined}
              onFolderContextMenu={handleFolderContextMenu}
              collapsedSections={collapsedSections}
              onToggleSection={(id) =>
                setCollapsedSections((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
              }
            />
            )}

            <div
              onMouseDown={() => startPaneDrag("left")}
              className="w-1 bg-zinc-800/50 hover:bg-emerald-500 active:bg-emerald-400 cursor-col-resize transition-colors shrink-0 z-10"
              title="Drag to resize left pane"
            />
          </>
        )}

        {/* CENTER VIRTUALIZED CANVAS */}
        <main
          ref={centerMainRef}
          className="flex-1 bg-surface flex flex-col overflow-hidden relative min-w-[260px]"
        >
          {lib.viewMode === "collections" ? (
            <CollectionsView
              albums={lib.albums}
              albumCounts={lib.albumCounts}
              savedSearches={lib.savedSearches}
              trips={lib.trips}
              tripEntries={lib.autoEvents}
              photoByHash={lib.photoByHash}
              onOpenAlbum={(id) => openInPhotos(() => lib.setActiveAlbumId(id))}
              onOpenSavedSearch={(saved) => openInPhotos(() => lib.runSavedSearch(saved))}
              onOpenTrip={(id) => openInPhotos(() => lib.setActiveEvent(id))}
              onCreateAlbum={(name) => lib.handleCreateAlbum(name)}
              onRenameAlbum={lib.handleRenameAlbum}
              onDeleteAlbum={lib.handleDeleteAlbum}
              onDeleteSavedSearch={lib.handleDeleteSavedSearch}
              onRenameTrip={lib.handleRenameTrip}
              // Albums are shared with the accounts of the server the library is on (the web client's, or one
              // the desktop app opened a library of)
              onShareAlbum={!openLibraryIsLocal() && access.edit ? setShareAlbum : undefined}
              pickHighlights={lib.pickHighlights}
              bestOfFocus={bestOfFocus}
              onShareGallery={platform.localFiles ? (title, hashes) => lib.openGallery(title, hashes) : undefined}
              onHighlights={(title, hashes, count, focus) =>
                lib.openHighlights(
                  title,
                  hashes.map((h) => lib.photoByHash.get(h)).filter((p): p is PhotoItem => Boolean(p)),
                  count,
                  focus
                )
              }
            />
          ) : (
          <>
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

          {lib.photos.length > 0 && <PhotoToolbar lib={lib} />}

          <FilterBar lib={lib} saveSearchName={saveSearchName} setSaveSearchName={setSaveSearchName} />

          <ResultBanners lib={lib} />
          {lib.isGridUpdating && (
            <div className="absolute top-28 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/95 border border-zinc-700 text-xs text-zinc-200 shadow-xl pointer-events-none">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
              {lib.gridSortBy !== lib.sortBy ? "Sorting…" : "Filtering…"}
            </div>
          )}
          {settings.onThisDay && lib.viewMode === "grid" && !anyFilterActive && (
            <OnThisDay
              photos={lib.photos}
              culling={lib.culling}
              onOpenDay={(date, hashes) => {
                lib.setHashFilter({
                  label: `On this day · ${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`,
                  hashes: new Set(hashes),
                });
              }}
            />
          )}

          {lib.viewMode === "map" ? (
            <MapPane lib={lib} />
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
              compareCandidateCount={lib.compareCandidateCount}
              culling={lib.culling}
            />
          ) : lib.photos.length === 0 ? (
            <NoLibrary lib={lib} gridContainerRef={gridContainerRef} />
          ) : lib.visiblePhotos.length === 0 ? (
            <NoMatches lib={lib} gridContainerRef={gridContainerRef} />
          ) : (
            <VirtualPhotoGrid
              gridContainerRef={gridContainerRef}
              rowVirtualizer={rowVirtualizer}
              layout={layout}
              gridStyle={lib.gridStyle}
              cardDetails={lib.cardDetails}
              visiblePhotos={lib.visiblePhotos}
              selectedHashes={lib.selectedHashes}
              activeHash={lib.activeHash}
              analyzingHashes={lib.analyzingHashes}
              burstGroupCounts={lib.burstGroupCounts}
              sharpestInGroup={lib.sharpestInGroup}
              culling={lib.culling}
              showAllBurstVersions={lib.showAllBurstVersions}
              expandedBurstGroups={lib.expandedBurstGroups}
              simpleMode={lib.simpleMode}
              handlePhotoClick={lib.handlePhotoClick}
              onPhotoContextMenu={handlePhotoContextMenu}
              onCardPointerDown={onCardPointerDown}
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
            cityQuery={lib.cityQuery}
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
            albums={lib.albums}
            handleAddToAlbum={lib.handleAddToAlbum}
            handleCreateAlbum={lib.handleCreateAlbum}
            onExport={platform.localFiles ? () => lib.openExport() : undefined}
            onDownload={client.downloadSelection}
            onRemoveLocal={client.removeLocalSelection}
          />
          </>
          )}
        </main>

        {/* RIGHT INSPECTOR PANE */}
        {!isRightCollapsed && isPhotoTab && lib.activePhoto && (
          <>
            <div
              onMouseDown={() => startPaneDrag("right")}
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

        <ToastStack
          toasts={lib.toasts}
          onDismiss={lib.dismissToast}
          onOpenSessionLog={() => lib.setIsSessionLogModalOpen(true)}
        />
      </div>

      {/* Permanent Studio Status Bar */}
      <BottomStatusBar
        totalPhotos={lib.photos.length}
        visibleCount={lib.visiblePhotos.length}
        selectedCount={lib.selectedHashes.size}
        viewMode={lib.viewMode}
        zoomLevel={lib.zoomLevel}
        setZoomLevel={lib.setZoomLevel}
        jobs={jobs}
        sessionLogsCount={lib.sessionLogs.length}
        onOpenSessionLog={() => lib.setIsSessionLogModalOpen(true)}
      />

      <CommandPalette isOpen={isPaletteOpen} onClose={() => setIsPaletteOpen(false)} actions={paletteActions} />

      <DragGhost drag={drag} dragPhoto={dragPhoto} />


      {/* Right-Click Photo Context Menu */}
      <PhotoContextMenu
        position={photoMenuPos}
        onClose={() => setPhotoMenuPos(null)}
        onOpenDefault={!platform.localFiles ? undefined : () => {
          if (contextPhoto) {
            lib.handleOpenInDefaultViewer(
              diskPathOf(contextPhoto)
            );
          }
        }}
        onRevealInFolder={!platform.localFiles ? undefined : () => {
          if (contextPhoto) {
            lib.handleRevealInFileManager(
              diskPathOf(contextPhoto)
            );
          }
        }}
        onCopyFullImage={!platform.localFiles ? undefined : async () => {
          if (!contextPhoto) return;
          try {
            await call("copy_image_to_clipboard", { path: contextPhoto.path });
            lib.addLog(
              "LIBRARY",
              `Copied full-res image to clipboard: ${contextPhoto.name}`
            );
            lib.setAutoMatchNotice(
              `Copied "${contextPhoto.name}" (full resolution) to clipboard!`
            );
          } catch (err) {
            lib.setError(String(err));
          }
        }}
        onCopyPath={!platform.localFiles ? undefined : () => {
          if (!contextPhoto) return;
          const diskPath = diskPathOf(contextPhoto);
          navigator.clipboard?.writeText(diskPath).catch(() => {});
          lib.setAutoMatchNotice(`Copied file path: ${diskPath}`);
        }}
        onPickPhoto={!access.edit ? undefined : () => {
          if (contextPhoto) lib.handleSetFlag("pick", contextMenuTargets(contextPhoto.hash));
        }}
        onStageTrash={!access.edit ? undefined : () => {
          if (contextPhoto) lib.handleRejectToTrash(contextMenuTargets(contextPhoto.hash));
        }}
        onFindSimilar={() => {
          if (contextPhoto) lib.handleFindSimilar(contextPhoto);
        }}
        onExport={!platform.localFiles ? undefined : () => {
          if (contextPhoto) lib.openExport(contextMenuTargets(contextPhoto.hash));
        }}
        onShareGallery={!platform.localFiles ? undefined : () => {
          if (contextPhoto) lib.openGallery(scopeTitle(lib), contextMenuTargets(contextPhoto.hash));
        }}
        albums={lib.albums}
        onAddToAlbum={!access.edit ? undefined : (albumId) => {
          if (contextPhoto) lib.handleAddToAlbum(albumId, contextMenuTargets(contextPhoto.hash));
        }}
        onCreateAlbum={!access.edit ? undefined : (name) => {
          if (contextPhoto) lib.handleCreateAlbum(name, contextMenuTargets(contextPhoto.hash));
        }}
        onRemoveFromAlbum={
          lib.activeAlbumId !== null && access.edit
            ? () => {
                if (contextPhoto && lib.activeAlbumId !== null) {
                  lib.handleRemoveFromAlbum(lib.activeAlbumId, contextMenuTargets(contextPhoto.hash));
                }
              }
            : undefined
        }
      />

      {/* Right-Click Folder Tree Context Menu */}
      <FolderContextMenu
        position={folderMenuPos}
        folderPath={contextFolderRel}
        onClose={() => setFolderMenuPos(null)}
        onRevealFolder={!platform.localFiles ? undefined : () => {
          if (!lib.folder) return;
          const target =
            contextFolderRel === "Root" || !contextFolderRel
              ? lib.folder
              : `${lib.folder}/${contextFolderRel.replace(/ \/ /g, "/")}`;
          lib.handleRevealInFileManager(target);
        }}
        onCreateSubfolder={!platform.localFiles ? undefined : () => {
          const prefix =
            contextFolderRel && contextFolderRel !== "Root"
              ? `${contextFolderRel.replace(/ \/ /g, "/")}/`
              : "";
          setNewFolderInput(prefix);
          setIsNewFolderModalOpen(true);
        }}
      />

      <NewFolderModal
        isNewFolderModalOpen={isNewFolderModalOpen}
        setIsNewFolderModalOpen={setIsNewFolderModalOpen}
        newFolderInput={newFolderInput}
        setNewFolderInput={setNewFolderInput}
        onCreate={lib.handleCreateSubfolder}
      />


      {/* Live Operation Progress Modal (Folder Scan, Reprocess & Ollama Model Pull) */}
      <OperationProgressModal
        isOpen={Boolean(
          lib.isScanningFolder || lib.scanProgress || lib.ollamaPullProgress
        )}
        title={
          lib.ollamaPullProgress
            ? `Downloading AI Vision Model (${lib.ollamaPullProgress.model})`
            : lib.progressTitle ?? "Loading & Indexing Photo Library"
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
        total={lib.ollamaPullProgress ? 100 : lib.scanProgress?.total ?? 0}
        onCancel={lib.handleCancelOperation}
        cancelLabel={lib.ollamaPullProgress ? "Cancel Download" : "Cancel"}
        showRate={!lib.ollamaPullProgress}
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

      {/* First-run / after-update welcome tour */}
      <WelcomeTour
        isOpen={welcome.isOpen}
        version={welcome.version}
        notes={welcome.notes}
        hidden={welcome.hidden}
        hasFolder={Boolean(lib.folder)}
        onClose={welcome.close}
        onOpenFolder={lib.handleOpenFolder}
      />

      <ShortcutsModal lib={lib} />

      <DuplicatesModal
        duplicates={lib.duplicates}
        photoByHash={lib.photoByHash}
        folder={lib.folder}
        onClose={() => lib.setDuplicates(null)}
        onStage={lib.stageDuplicates}
        confirmAction={lib.confirmAction}
      />

      <HighlightsModal
        highlights={lib.highlights}
        photoByHash={lib.photoByHash}
        onClose={() => lib.setHighlights(null)}
        onCount={lib.setHighlightsCount}
        onShowInGrid={lib.showHighlightsInGrid}
        onSaveAsAlbum={access.edit ? lib.saveHighlightsAsAlbum : undefined}
        onShareGallery={!platform.localFiles ? undefined : () => {
          if (!lib.highlights?.hashes) return;
          const { title, hashes } = lib.highlights;
          lib.setHighlights(null);
          lib.openGallery(title, hashes);
        }}
        onOpenPhoto={(hash) => {
          lib.showHighlightsInGrid();
          lib.setActiveHash(hash);
          lib.setSelectedHashes(new Set([hash]));
          lib.setIsLoupeOpen(true);
        }}
      />

      <GalleryModal
        target={lib.galleryTarget}
        onClose={() => lib.setGalleryTarget(null)}
        onCreate={lib.runGallery}
      />

      <ConfirmDialog />

      <ShareAlbumDialog album={shareAlbum} onClose={() => setShareAlbum(null)} />
      <AdminPage isOpen={isAdminOpen} onClose={() => setIsAdminOpen(false)} />

      <RestoreModal
        target={lib.restoreTarget}
        busy={lib.backupBusy === "restore"}
        onClose={() => lib.setRestoreTarget(null)}
        onRestore={lib.runRestore}
      />

      <ImportModal
        isOpen={lib.importSource !== null}
        initialSource={lib.importSource ?? ""}
        defaultDest={lib.defaultImportDest}
        onClose={() => lib.setImportSource(null)}
        onImport={lib.runImport}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        initialSection={settingsSection}
        onClose={() => setIsSettingsOpen(false)}
        lib={lib}
        onOpenWelcomeTour={welcome.open}
        updater={updater}
      />

      {!welcome.isOpen && <UpdateBanner updater={updater} />}


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
        onClose={() => {
          lib.setFaceReviewPerson(null);
          // Confirmed faces sharpen each person's profile, so the suggestions themselves may have changed
          lib.refreshPeople();
        }}
        people={lib.people}
        pendingCounts={lib.pendingFaceCounts}
        reducePendingCount={lib.reducePendingCount}
        setPhotos={lib.setPhotos}
        refreshPeople={lib.refreshPeople}
        folder={lib.folder}
        onRenamePerson={lib.handleRenamePerson}
        onSetPersonHidden={lib.handleSetPersonHidden}
        onSetPersonStarred={lib.handleSetPersonStarred}
        onShowPhotos={(person) => {
          lib.setFaceReviewPerson(null);
          lib.setPeopleFilter({ person });
          if (lib.viewMode === "collections") lib.setViewMode("people");
        }}
      />

      <ProfilePicturePicker
        person={coverPickerPerson}
        currentCover={lib.people.find((p) => p.name === coverPickerPerson)?.cover_thumb ?? ""}
        onPick={(faceId) => (coverPickerPerson ? lib.handleSetPersonCover(coverPickerPerson, faceId) : Promise.resolve())}
        onClose={() => setCoverPickerPerson(null)}
      />

      <ExportModal
        isOpen={lib.exportTargets !== null}
        count={lib.exportTargets?.length ?? 0}
        defaultDir={lib.folder ? `${lib.folder.replace(/[\\/]+$/, "")}\\Export` : ""}
        onClose={() => lib.setExportTargets(null)}
        onExport={lib.runExport}
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
