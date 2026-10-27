import type { RefObject } from "react";
import type { PaletteAction } from "../components/modals/CommandPalette";
import type { SettingsSection } from "../components/modals/SettingsModal";
import { UNKNOWN_FACES } from "../components/modals/FaceMatchReviewModal";
import { diskPathOf } from "../utils/rawPairs";
import { scopeTitle } from "../components/layout/PhotoToolbar";
import type { LibraryState } from "../hooks/useLibraryState";

interface PaletteContext {
  lib: LibraryState;
  searchInputRef: RefObject<HTMLInputElement | null>;
  setSaveSearchName: (name: string | null) => void;
  openFaceReview: () => void;
  openWelcomeTour: () => void;
  openSettings: (section?: SettingsSection) => void;
  checkForUpdates: () => void;
  isLeftCollapsed: boolean;
  setIsLeftCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  isRightCollapsed: boolean;
  setIsRightCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
}

// Every action of the command palette (Ctrl+P), grouped, with its shortcut and when it is available
export function buildPaletteActions({
  lib,
  searchInputRef,
  setSaveSearchName,
  openFaceReview,
  openWelcomeTour,
  openSettings,
  checkForUpdates,
  isLeftCollapsed,
  setIsLeftCollapsed,
  isRightCollapsed,
  setIsRightCollapsed,
}: PaletteContext): PaletteAction[] {
  const hasSelection = lib.selectedHashes.size > 0;
  const hasPhotos = lib.photos.length > 0;
  const selected = () => lib.visiblePhotos.filter((p) => lib.selectedHashes.has(p.hash));
  const paletteActions: PaletteAction[] = [
    { id: "open-folder", group: "Library", label: "Open folder…", keywords: "library switch", run: lib.handleOpenFolder },
    { id: "import", group: "Library", label: "Import photos…", keywords: "card sd camera copy usb phone", enabled: !lib.importProgress, run: () => lib.openImport() },
    ...lib.recentFolders.slice(0, 5).map((f) => ({
      id: `recent-${f}`,
      group: "Library",
      label: `Open recent: ${f.split(/[\\/]/).pop()}`,
      keywords: f,
      run: () => lib.handleLoadFolderPath(f),
    })),
    { id: "rescan", group: "Library", label: "Quick rescan folder", enabled: hasPhotos, run: lib.handleRescanFolder },
    { id: "deep", group: "Library", label: "Deep reprocess thumbnails", enabled: hasPhotos, run: lib.handleRescanAndProcessFolder },
    { id: "health", group: "Library", label: "Library health & XMP export", keywords: "cache sidecar lightroom", enabled: hasPhotos, run: lib.handleOpenHealthDashboard },
    { id: "xmp-all", group: "Library", label: "Export XMP sidecars (all photos)", keywords: "lightroom", enabled: hasPhotos, run: () => lib.handleExportXmp(false) },
    { id: "xmp-sel", group: "Library", label: "Export XMP sidecars (selection)", keywords: "lightroom", enabled: hasSelection, run: () => lib.handleExportXmp(true) },
    { id: "commit", group: "Organize", label: "Review & commit staged moves", keywords: "disk move apply", enabled: lib.stagedPhotos.length > 0, run: () => lib.setIsCommitModalOpen(true) },
    { id: "dismiss", group: "Organize", label: "Dismiss all staged moves", enabled: lib.stagedPhotos.length > 0, run: lib.handleDismissAllStaged },
    { id: "auto-stage", group: "Organize", label: "Auto-stage visible photos by rule", keywords: "organize sort folders", enabled: hasPhotos, run: lib.handleAutoOrganizeByPreset },
    { id: "keep-sharpest", group: "Organize", label: "Keep the best of every burst, stage rest for _Trash", keywords: "duplicates sharpest eyes", enabled: lib.totalBurstGroups > 0, run: lib.handleKeepSharpestInAllGroups },
    { id: "highlights", group: "Select", label: "Highlights of what is shown", keywords: "best of favourites top", enabled: lib.visiblePhotos.length > 1, run: () => lib.openHighlights(scopeTitle(lib), lib.visiblePhotos) },
    { id: "eyes-closed", group: "Select", label: "Show photos with closed eyes", keywords: "blink blinking culling", enabled: lib.eyesClosedCount > 0, run: () => lib.setSmartFilter("EYES_CLOSED") },
    { id: "soft-focus", group: "Select", label: "Show out-of-focus photos", keywords: "blurry soft sharp culling", enabled: lib.softFocusCount > 0, run: () => lib.setSmartFilter("SOFT_FOCUS") },
    { id: "empty-trash", group: "Organize", label: "Empty _Trash to Recycle Bin", keywords: "delete", enabled: hasPhotos, run: lib.handleEmptyTrashToRecycleBin },
    { id: "pick", group: "Triage", label: "Flag as pick", shortcut: "P", enabled: hasSelection, run: () => lib.handleSetFlag("pick") },
    { id: "reject", group: "Triage", label: "Reject & stage for _Trash", shortcut: "X", enabled: hasSelection, run: () => lib.handleRejectToTrash() },
    { id: "unflag", group: "Triage", label: "Remove flag", shortcut: "U", enabled: hasSelection, run: () => lib.handleSetFlag(null) },
    ...[0, 1, 2, 3, 4, 5].map((r) => ({
      id: `rate-${r}`,
      group: "Triage",
      label: r === 0 ? "Clear rating" : `Rate ${r} star${r === 1 ? "" : "s"}`,
      shortcut: String(r),
      enabled: hasSelection,
      run: () => lib.handleBatchRate(r),
    })),
    ...(["red", "yellow", "green", "blue"] as const).map((c, i) => ({
      id: `label-${c}`,
      group: "Triage",
      label: `Color label ${c}`,
      shortcut: String(6 + i),
      enabled: hasSelection,
      run: () => lib.handleSetColorLabel(c),
    })),
    { id: "label-clear", group: "Triage", label: "Clear color label", enabled: hasSelection, run: () => lib.handleSetColorLabel(null) },
    { id: "rotate-left", group: "Triage", label: "Rotate left", shortcut: "[", enabled: hasSelection, run: () => lib.handleRotateSelection(-90) },
    { id: "rotate-right", group: "Triage", label: "Rotate right", shortcut: "]", enabled: hasSelection, run: () => lib.handleRotateSelection(90) },
    { id: "basket", group: "Triage", label: "Pin / unpin in Basket", shortcut: "B", enabled: hasSelection, run: () => lib.handleToggleBasketSelection() },
    { id: "select-all", group: "Select", label: "Select all visible photos", keywords: "everything", enabled: lib.visiblePhotos.length > 0, run: () => lib.setSelectedHashes(new Set(lib.visiblePhotos.map((p) => p.hash))) },
    { id: "select-none", group: "Select", label: "Clear selection", enabled: hasSelection, run: () => lib.setSelectedHashes(new Set()) },
    { id: "clear-filters", group: "Select", label: "Clear all filters", keywords: "reset show everything", enabled: hasPhotos, run: lib.clearAllFilters },
    { id: "save-search", group: "Albums", label: "Save this search as a smart album", enabled: lib.searchQuery.trim() !== "", run: () => setSaveSearchName("") },
    { id: "album-new", group: "Albums", label: "New album from selection", enabled: hasSelection, run: () => { lib.setActiveBulkPopover("album"); lib.setBulkInput(""); } },
    ...lib.albums.map((a) => ({
      id: `album-add-${a.id}`,
      group: "Albums",
      label: `Add selection to "${a.name}"`,
      enabled: hasSelection,
      run: () => lib.handleAddToAlbum(a.id),
    })),
    ...lib.albums.map((a) => ({
      id: `album-show-${a.id}`,
      group: "Albums",
      label: `Show album "${a.name}"`,
      run: () => lib.setActiveAlbumId(a.id),
    })),
    { id: "album-remove", group: "Albums", label: "Remove selection from this album", enabled: hasSelection && lib.activeAlbumId !== null, run: () => lib.activeAlbumId !== null && lib.handleRemoveFromAlbum(lib.activeAlbumId) },
    { id: "search", group: "Select", label: "Search photos", shortcut: "Ctrl+K", enabled: hasPhotos, run: () => searchInputRef.current?.focus() },
    {
      id: "smart-search",
      group: "Select",
      label: lib.smartSearch ? "Turn smart search off" : "Smart search (describe the photo)",
      keywords: "clip semantic ai find",
      enabled: hasPhotos,
      run: async () => {
        await lib.toggleSmartSearch();
        searchInputRef.current?.focus();
      },
    },
    { id: "similar", group: "Select", label: "Find photos similar to this one", keywords: "smart clip like", enabled: Boolean(lib.activePhoto), run: () => lib.activePhoto && lib.handleFindSimilar(lib.activePhoto) },
    { id: "index", group: "Select", label: "Index this folder for smart search", enabled: hasPhotos && Boolean(lib.semanticStatus?.models_ready) && !lib.semanticProgress, run: () => lib.startSemanticIndex() },
    { id: "loupe", group: "View", label: "Open in Loupe", shortcut: "Space", enabled: Boolean(lib.activePhoto), run: () => lib.setIsLoupeOpen(true) },
    { id: "tab-photos", group: "Go to", label: "Photos", shortcut: "Ctrl+1", run: () => lib.setViewMode("grid") },
    { id: "tab-map", group: "Go to", label: "Map", shortcut: "Ctrl+2", run: () => lib.setViewMode("map") },
    { id: "tab-people", group: "Go to", label: "People", shortcut: "Ctrl+3", run: () => lib.setViewMode("people") },
    { id: "tab-collections", group: "Go to", label: "Collections (albums, trips)", shortcut: "Ctrl+4", run: () => lib.setViewMode("collections") },
    { id: "view-grid", group: "View", label: "Grid view", shortcut: "G", run: () => lib.setViewMode("grid") },
    { id: "view-compare", group: "View", label: "Compare view", shortcut: "C", enabled: hasPhotos, run: () => lib.setViewMode("compare") },
    { id: "view-map", group: "View", label: "Map view", shortcut: "M", enabled: hasPhotos, run: () => lib.setViewMode("map") },
    { id: "timeline", group: "View", label: "Show / hide date timeline", enabled: hasPhotos, run: () => lib.setIsTimelineOpen((o) => !o) },
    { id: "bursts", group: "View", label: lib.showAllBurstVersions ? "Collapse burst stacks" : "Expand all burst stacks", enabled: lib.totalBurstGroups > 0, run: () => lib.setShowAllBurstVersions((v) => !v) },
    { id: "grid-justified", group: "View", label: "Grid style: justified", enabled: lib.gridStyle !== "justified", run: () => lib.setGridStyle("justified") },
    { id: "grid-square", group: "View", label: "Grid style: square", enabled: lib.gridStyle !== "square", run: () => lib.setGridStyle("square") },
    { id: "details-hover", group: "View", label: "Card details: on hover", enabled: lib.cardDetails !== "hover", run: () => lib.setCardDetails("hover") },
    { id: "details-always", group: "View", label: "Card details: always", enabled: lib.cardDetails !== "always", run: () => lib.setCardDetails("always") },
    { id: "zoom-in", group: "View", label: "Larger thumbnails", run: () => lib.setZoomLevel((z) => Math.min(1, z + 0.15)) },
    { id: "zoom-out", group: "View", label: "Smaller thumbnails", run: () => lib.setZoomLevel((z) => Math.max(0, z - 0.15)) },
    { id: "left-pane", group: "View", label: isLeftCollapsed ? "Show left sidebar" : "Hide left sidebar", run: () => setIsLeftCollapsed((v) => !v) },
    { id: "right-pane", group: "View", label: isRightCollapsed ? "Show inspector" : "Hide inspector", run: () => setIsRightCollapsed((v) => !v) },
    { id: "mode", group: "View", label: lib.simpleMode ? "Switch to Pro mode" : "Switch to Simple mode", run: lib.toggleSimpleMode },
    { id: "scan-faces", group: "Faces", label: "Scan faces in this folder", enabled: hasPhotos && !lib.faceScanProgress, run: lib.handleBatchScanFacesOnnx },
    { id: "stop-faces", group: "Faces", label: "Stop face scan", enabled: Boolean(lib.faceScanProgress), run: lib.handleCancelFaceScan },
    { id: "review-faces", group: "Faces", label: "Review face matches", keywords: "people suggestions", enabled: hasPhotos, run: openFaceReview },
    { id: "who", group: "Faces", label: "Who is this? (name unknown faces)", keywords: "people clusters", enabled: hasPhotos, run: () => lib.setFaceReviewPerson(UNKNOWN_FACES) },
    { id: "detect-one", group: "Faces", label: "Detect faces in this photo", enabled: Boolean(lib.activePhoto), run: lib.handleDetectFacesSingleOnnx },
    { id: "ai-visible", group: "AI", label: "Batch AI on visible photos", keywords: "caption tags", enabled: hasPhotos && !lib.aiBatchProgress, run: () => lib.runBatchAiOnList(lib.visiblePhotos) },
    { id: "ai-selected", group: "AI", label: "Batch AI on selected photos", keywords: "caption tags", enabled: hasSelection && !lib.aiBatchProgress, run: () => lib.runBatchAiOnList(selected()) },
    { id: "ai-one", group: "AI", label: "AI analyze this photo", shortcut: "A", enabled: Boolean(lib.activePhoto), run: lib.handleAiAnalyzeSingle },
    { id: "ai-stop", group: "AI", label: "Stop Batch AI", enabled: Boolean(lib.aiBatchProgress), run: lib.handleStopAiBatch },
    { id: "export", group: "Photo", label: "Export selected photos…", keywords: "jpeg share save resize", enabled: hasSelection, run: () => lib.openExport() },
    { id: "exif", group: "Photo", label: "Re-read EXIF of selection", keywords: "date camera gps refresh", enabled: hasSelection, run: lib.handleForceRescanExifSelected },
    { id: "reveal", group: "Photo", label: "Show in Explorer", enabled: Boolean(lib.activePhoto), run: () => lib.activePhoto && lib.handleRevealInFileManager(diskPathOf(lib.activePhoto)) },
    { id: "external", group: "Photo", label: "Open in default app", enabled: Boolean(lib.activePhoto), run: () => lib.activePhoto && lib.handleOpenInDefaultViewer(diskPathOf(lib.activePhoto)) },
    { id: "undo", group: "Edit", label: "Undo", shortcut: "Ctrl+Z", enabled: lib.canUndo, run: lib.handleUndo },
    { id: "redo", group: "Edit", label: "Redo", shortcut: "Ctrl+Y", enabled: lib.canRedo, run: lib.handleRedo },
    { id: "log", group: "Help", label: "Session log", shortcut: "Ctrl+L", run: () => lib.setIsSessionLogModalOpen(true) },
    { id: "shortcuts", group: "Help", label: "Keyboard shortcuts", shortcut: "?", run: () => lib.setIsShortcutsModalOpen(true) },
    { id: "settings", group: "Help", label: "Settings", shortcut: "Ctrl+,", keywords: "preferences options", run: () => openSettings() },
    { id: "updates", group: "Help", label: "Check for updates", keywords: "new version upgrade", run: () => { openSettings("updates"); checkForUpdates(); } },
    { id: "welcome", group: "Help", label: "Welcome tour", keywords: "help intro what's new guide", run: openWelcomeTour },
  ];
  return paletteActions;
}
