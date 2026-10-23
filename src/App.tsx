import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLibraryState } from "./hooks/useLibraryState";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import TopHeaderBar from "./components/layout/TopHeaderBar";
import LeftSidebar from "./components/layout/LeftSidebar";
import RightInspector from "./components/layout/RightInspector";
import BottomStatusBar from "./components/layout/BottomStatusBar";
import TimelineDrawer from "./components/views/TimelineDrawer";
import CompareView from "./components/views/CompareView";
import VirtualPhotoGrid from "./components/views/VirtualPhotoGrid";
import PhotoMap from "./components/views/PhotoMap";
import BulkActionDock from "./components/modals/BulkActionDock";
import CommitModal from "./components/modals/CommitModal";
import HealthXmpModal from "./components/modals/HealthXmpModal";
import LoupeModal from "./components/modals/LoupeModal";
import { AutoStagePreset, OrientationFilter, SortOption } from "./types/lumina";
import {
  AlertCircle,
  ArrowUpDown,
  Calendar,
  ChevronDown,
  Compass,
  Crosshair,
  Folder,
  FolderSync,
  Layers,
  MapPin,
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
  const [centerWidth, setCenterWidth] = useState<number>(900);
  const draggingPaneRef = useRef<"left" | "right" | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setCenterWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [lib.viewMode, isLeftCollapsed, isRightCollapsed]);

  const { gridColumns, cardThumbHeight, rowEstimateHeight } = useMemo(() => {
    const targetCardW = 115 + lib.zoomLevel * 325;
    const cols = Math.max(1, Math.min(12, Math.floor(centerWidth / targetCardW)));
    const actualCardW = Math.floor((centerWidth - (cols - 1) * 14) / cols);
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
      if (extendSelection && lib.lastSelectedIndexRef.current !== null) {
        const start = Math.min(lib.lastSelectedIndexRef.current, nextIdx);
        const end = Math.max(lib.lastSelectedIndexRef.current, nextIdx);
        const nextSet = new Set(lib.selectedHashes);
        for (let i = start; i <= end; i++) nextSet.add(lib.visiblePhotos[i].hash);
        lib.setSelectedHashes(nextSet);
      } else {
        lib.setSelectedHashes(new Set([targetPhoto.hash]));
        lib.lastSelectedIndexRef.current = nextIdx;
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

  useKeyboardShortcuts({
    activeHash: lib.activeHash,
    activePhoto: lib.activePhoto,
    selectedHashes: lib.selectedHashes,
    isLoupeOpen: lib.isLoupeOpen,
    setIsLoupeOpen: lib.setIsLoupeOpen,
    setIsCommitModalOpen: lib.setIsCommitModalOpen,
    setIsDrawingFace: lib.setIsDrawingFace,
    setDrawnBox: lib.setDrawnBox,
    setActiveBulkPopover: lib.setActiveBulkPopover,
    gridColumns,
    navigateByOffset,
    autoAdvance: lib.autoAdvance,
    searchInputRef,
    handleSetFlag: lib.handleSetFlag,
    handleBatchStageMove: lib.handleBatchStageMove,
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
    <div className="flex flex-col h-screen bg-[#090a0f] text-zinc-100 select-none overflow-hidden">
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
        aiBatchProgress={lib.aiBatchProgress}
        cancelBatchRef={lib.cancelBatchRef}
        handleOpenFolder={lib.handleOpenFolder}
        handleRescanFolder={lib.handleRescanFolder}
        handleRescanAndProcessFolder={lib.handleRescanAndProcessFolder}
        handleOpenHealthDashboard={lib.handleOpenHealthDashboard}
        setIsCommitModalOpen={lib.setIsCommitModalOpen}
        handleDismissAllStaged={lib.handleDismissAllStaged}
        handleBatchScanFacesOnnx={lib.handleBatchScanFacesOnnx}
        runBatchAiOnList={lib.runBatchAiOnList}
      />

      {/* Top People Carousel */}
      {lib.people.length > 0 && (
        <div className="px-5 py-1.5 bg-[#0c0d14] border-b border-zinc-800/50 flex items-center gap-2 overflow-x-auto shrink-0">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mr-1.5 shrink-0">
            People
          </span>

          {lib.people.map((p) => {
            const isSelected = lib.selectedPerson === p.name;
            return (
              <button
                key={p.name}
                onClick={() => lib.setSelectedPerson(isSelected ? null : p.name)}
                className={`flex items-center gap-2 px-2.5 py-1 rounded-full text-xs transition shrink-0 ${
                  isSelected
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm"
                    : "bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 border border-zinc-800/80"
                }`}
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
            );
          })}
        </div>
      )}

      {/* Main Resizable 3-Pane Workspace */}
      <div className="flex flex-1 overflow-hidden relative">
        {!isLeftCollapsed && (
          <>
            <LeftSidebar
              leftWidth={leftWidth}
              photos={lib.photos}
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
        <main className="flex-1 bg-[#090a0f] flex flex-col overflow-hidden relative min-w-[260px]">
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
                    {lib.showAllBurstVersions ? "Collapse Bursts" : "Show All Bursts"}
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
                  <option value="SCORE_DESC" className="bg-zinc-900">
                    Focus Score (Sharpest)
                  </option>
                  <option value="SCORE_ASC" className="bg-zinc-900">
                    Focus Score (Blurriest)
                  </option>
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
                  onChange={(e) => lib.setAutoStagePreset(e.target.value as AutoStagePreset)}
                  className="bg-transparent text-zinc-300 text-[11px] px-2 py-1 focus:outline-none cursor-pointer border-r border-zinc-800"
                  title="Choose folder structure rule preset"
                >
                  <option value="YEAR_MONTH_CITY" className="bg-zinc-900">
                    Rule: &#123;Year&#125;/&#123;YYYY-MM&#125;_&#123;City&#125;
                  </option>
                  <option value="YEAR_MONTH" className="bg-zinc-900">
                    Rule: &#123;Year&#125;/&#123;YYYY-MM&#125;
                  </option>
                  <option value="PERSON_YEAR" className="bg-zinc-900">
                    Rule: People/&#123;Person&#125;/&#123;Year&#125;
                  </option>
                  <option value="SCREENSHOTS_BY_MONTH" className="bg-zinc-900">
                    Rule: _Screenshots/&#123;YYYY-MM&#125;
                  </option>
                  <option value="FAVORITES_YEAR" className="bg-zinc-900">
                    Rule: Favorites/&#123;Year&#125;
                  </option>
                </select>
                <button
                  onClick={lib.handleAutoOrganizeByPreset}
                  className="flex items-center gap-1.5 text-indigo-200 hover:text-white bg-indigo-950/50 hover:bg-indigo-600 px-2.5 py-1 transition font-medium text-xs"
                  title="Stage visible photos using selected folder rule"
                >
                  <FolderSync className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Auto-Stage</span>
                </button>
              </div>
            </div>
          </div>

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
              setPhotos={lib.setPhotos}
            />
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
              handlePhotoClick={lib.handlePhotoClick}
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
      />

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

      <LoupeModal
        isOpen={lib.isLoupeOpen}
        onClose={() => lib.setIsLoupeOpen(false)}
        activePhoto={lib.activePhoto}
        autoAdvance={lib.autoAdvance}
        navigateByOffset={navigateByOffset}
        handleSetFlag={lib.handleSetFlag}
        handleBatchStageMove={lib.handleBatchStageMove}
        handleBatchRate={lib.handleBatchRate}
        handleRotateSelection={lib.handleRotateSelection}
        handleAiAnalyzeSingle={lib.handleAiAnalyzeSingle}
      />
    </div>
  );
}
