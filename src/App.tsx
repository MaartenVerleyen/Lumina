import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import PhotoMap from "./components/PhotoMap";
import luminaMark from "./assets/lumina-mark.svg";
import {
  FolderOpen,
  MapPin,
  LayoutGrid,
  Search,
  Trash2,
  Sparkles,
  Power,
  Maximize2,
  X,
  CheckSquare,
  Calendar,
  Cpu,
  CheckCircle,
  FolderSync,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ChevronRight,
  ChevronDown,
  ArrowUpDown,
  ChevronLeft,
  Loader2,
  Folder,
  Grid,
  Square,
  RotateCcw,
  ScanFace,
  Crosshair,
  RefreshCw,
  Zap,
  RotateCw,
  RotateCcw as RotateLeft,
  SlidersHorizontal,
  Compass,
  Tag as TagIcon,
  Columns,
  Pin,
  Clock,
  HardDrive,
  FileCode,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

interface FaceInstance {
  face_id: string;
  hash: string;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  person_name?: string | null;
  face_thumb: string;
  confidence: number;
}

interface FaceMatchEvent {
  person_name: string;
  matched_hashes: string[];
  total_matched: number;
}

interface FaceScanProgress {
  completed: number;
  total: number;
  faces_found: number;
  auto_matched: number;
  done: boolean;
}

interface PhotoItem {
  hash: string;
  name: string;
  subfolder: string;
  path: string;
  thumb_path: string;
  size_kb: number;
  width: number;
  height: number;
  thumb_ready: boolean;
  rating: number;
  flag: "pick" | "reject" | null;
  color_label: "red" | "yellow" | "green" | "blue" | null;
  rotation: number;
  in_basket: boolean;
  tags: string[];
  people: string[];
  faces: FaceInstance[];
  ai_caption: string;
  ocr_text: string;
  captured_at: string;
  camera_model: string;
  location: string;
  latitude?: number | null;
  longitude?: number | null;
  dhash: string;
  sharpness: number;
  duplicate_group?: number | null;
  staged_target?: string | null;
}

interface PersonItem {
  id: number;
  name: string;
  photo_count: number;
  cover_thumb: string;
}

interface ThumbBatchItem {
  hash: string;
  thumb_path: string;
  dhash: string;
  sharpness: number;
  width: number;
  height: number;
  auto_tags: string[];
}

interface ThumbBatchProgress {
  items: ThumbBatchItem[];
  duplicate_groups: Record<string, number>;
  completed: number;
  total: number;
}

interface ExifRefreshResult {
  hash: string;
  captured_at: string;
  camera_model: string;
  location: string;
  latitude?: number | null;
  longitude?: number | null;
}

interface TimelineBucket {
  period: string;
  count: number;
}

interface CitySearchResult {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
}

interface TimestampShiftResult {
  hash: string;
  captured_at: string;
}

interface LibraryHealthStats {
  total_photos: number;
  total_library_size_mb: number;
  trash_staged_count: number;
  trash_recoverable_mb: number;
  duplicate_extras_count: number;
  duplicate_recoverable_mb: number;
  cache_files_count: number;
  cache_size_mb: number;
  orphaned_cache_count: number;
  camera_breakdown: [string, number][];
}

type AutoStagePreset = "YEAR_MONTH_CITY" | "YEAR_MONTH" | "PERSON_YEAR" | "SCREENSHOTS_BY_MONTH" | "FAVORITES_YEAR";

interface AiAnalysisResult {
  tags: string[];
  people: string[];
  faces: FaceInstance[];
  caption: string;
  ocr_text: string;
}

interface OllamaStatus {
  running: boolean;
  active_vram_model: string | null;
  installed_models: { name: string; size_gb: number }[];
}

type SmartFilter =
  | "ALL"
  | "PICKS"
  | "REJECTS"
  | "BASKET"
  | "FAVORITES"
  | "UNTAGGED"
  | "AI_TAGGED"
  | "SCREENSHOTS"
  | "DUPLICATES"
  | "HAS_OCR"
  | "HAS_GPS"
  | "STAGED";

type OrientationFilter = "ALL" | "LANDSCAPE" | "PORTRAIT" | "SQUARE";

type SortOption =
  | "NAME_ASC"
  | "NAME_DESC"
  | "DATE_DESC"
  | "DATE_ASC"
  | "SCORE_DESC"
  | "SCORE_ASC"
  | "RATING_DESC"
  | "TAG_NAME"
  | "TAG_COUNT"
  | "SIZE_DESC";

interface FolderTreeNode {
  name: string;
  fullPath: string;
  directCount: number;
  totalCount: number;
  children: FolderTreeNode[];
}

function buildFolderTree(photos: PhotoItem[]): { rootCount: number; nodes: FolderTreeNode[] } {
  const directCounts = new Map<string, number>();
  for (const p of photos) {
    directCounts.set(p.subfolder, (directCounts.get(p.subfolder) || 0) + 1);
  }

  const rootCount = directCounts.get("Root") || 0;
  const nodeMap = new Map<string, FolderTreeNode>();
  const topNodes: FolderTreeNode[] = [];

  const allPaths = Array.from(directCounts.keys())
    .filter((k) => k !== "Root")
    .sort();

  for (const subPath of allPaths) {
    const parts = subPath.split(" / ");
    let currentFull = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const parentFull = currentFull;
      currentFull = currentFull ? `${currentFull} / ${part}` : part;

      if (!nodeMap.has(currentFull)) {
        const newNode: FolderTreeNode = {
          name: part,
          fullPath: currentFull,
          directCount: directCounts.get(currentFull) || 0,
          totalCount: 0,
          children: [],
        };
        nodeMap.set(currentFull, newNode);

        if (i === 0) {
          topNodes.push(newNode);
        } else {
          const parentNode = nodeMap.get(parentFull);
          if (parentNode) {
            parentNode.children.push(newNode);
          }
        }
      }
    }
  }

  function calcTotal(node: FolderTreeNode): number {
    let sum = node.directCount;
    for (const c of node.children) {
      sum += calcTotal(c);
    }
    node.totalCount = sum;
    return sum;
  }

  topNodes.forEach(calcTotal);
  return { rootCount, nodes: topNodes };
}

export default function App() {
  const [folder, setFolder] = useState<string>("");
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [people, setPeople] = useState<PersonItem[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);

  const [smartFilter, setSmartFilter] = useState<SmartFilter>("ALL");
  const [orientationFilter, setOrientationFilter] = useState<OrientationFilter>("ALL");
  const [activeSubfolder, setActiveSubfolder] = useState<string>("ALL");
  const [activeEvent, setActiveEvent] = useState<string>("ALL");
  const [activeTag, setActiveTag] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sortBy, setSortBy] = useState<SortOption>("NAME_ASC");

  // Slide-Out Day-Accurate Click-and-Drag Timeline Slicer State (Hidden by default!)
  const [isTimelineOpen, setIsTimelineOpen] = useState<boolean>(false);
  const [timelineBuckets, setTimelineBuckets] = useState<TimelineBucket[]>([]);
  const [selectedPeriodRange, setSelectedPeriodRange] = useState<[string, string] | null>(null);
  const [dragAnchorDay, setDragAnchorDay] = useState<string | null>(null);

  // Inspector Single-Photo Location Editor State
  const [isEditingInspectorLocation, setIsEditingInspectorLocation] = useState<boolean>(false);
  const [inspectorLocationQuery, setInspectorLocationQuery] = useState<string>("");

  // Phase 3: Neural ONNX Face Scanner Progress State
  const [faceScanProgress, setFaceScanProgress] = useState<FaceScanProgress | null>(null);
  const [isDetectingSingleFace, setIsDetectingSingleFace] = useState<boolean>(false);

  // Auto-Advance Mode Toggle (Advance automatically after Rating or Flagging)
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true);

  // Burst Stacking State
  const [showAllBurstVersions, setShowAllBurstVersions] = useState<boolean>(false);
  const [expandedBurstGroups, setExpandedBurstGroups] = useState<Set<number>>(new Set());

  // Abstract Zoom Slider (0.0 to 1.0)
  const [zoomLevel, setZoomLevel] = useState<number>(0.45);
  const [centerWidth, setCenterWidth] = useState<number>(900);

  const [viewMode, setViewMode] = useState<"grid" | "map" | "compare">("grid");
  const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set());
  const [activeHash, setActiveHash] = useState<string | null>(null);
  const lastSelectedIndexRef = useRef<number | null>(null);
  const [isLoupeOpen, setIsLoupeOpen] = useState<boolean>(false);
  const [isCommitModalOpen, setIsCommitModalOpen] = useState<boolean>(false);
  const [smartRenameOnCommit, setSmartRenameOnCommit] = useState<boolean>(false);
  const [autoStagePreset, setAutoStagePreset] = useState<AutoStagePreset>("YEAR_MONTH_CITY");

  // Phase 2: Synchronized Compare Mode State (Zoom & Pan)
  const [compareZoom, setCompareZoom] = useState<number>(1);
  const [comparePan, setComparePan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const isPanningCompareRef = useRef<boolean>(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Phase 2: Click-on-Map GPS Picker Mode
  const [isPickingMapLocation, setIsPickingMapLocation] = useState<boolean>(false);

  // Phase 2: Camera Clock Shift State
  const [shiftHoursInput, setShiftHoursInput] = useState<number>(0);
  const [shiftMinutesInput, setShiftMinutesInput] = useState<number>(0);

  // Phase 2: Library Health & XMP Modal State
  const [isHealthModalOpen, setIsHealthModalOpen] = useState<boolean>(false);
  const [healthStats, setHealthStats] = useState<LibraryHealthStats | null>(null);
  const [isExportingXmp, setIsExportingXmp] = useState<boolean>(false);

  // 3-Pane Resizable & Collapsible State
  const [leftWidth, setLeftWidth] = useState<number>(250);
  const [rightWidth, setRightWidth] = useState<number>(380);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState<boolean>(false);
  const [isRightCollapsed, setIsRightCollapsed] = useState<boolean>(false);
  const draggingPaneRef = useRef<"left" | "right" | null>(null);

  // Bulk Dock Popover States
  const [activeBulkPopover, setActiveBulkPopover] = useState<"tag" | "person" | "move" | "location" | "time" | null>(null);
  const [bulkInput, setBulkInput] = useState<string>("");
  const [citySearchResults, setCitySearchResults] = useState<CitySearchResult[]>([]);

  // Interactive Face Box State
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(null);
  const [isDrawingFace, setIsDrawingFace] = useState<boolean>(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawnBox, setDrawnBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [faceNameInput, setFaceNameInput] = useState<string>("");
  const [autoMatchNotice, setAutoMatchNotice] = useState<string>("");
  const [isScanningFolder, setIsScanningFolder] = useState<boolean>(false);
  const previewImgWrapRef = useRef<HTMLDivElement>(null);

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Ollama & Progress States
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [aiModel, setAiModel] = useState<string>("qwen3-vl:8b");
  const [analyzingHashes, setAnalyzingHashes] = useState<Set<string>>(new Set());
  const [isLoadingVram, setIsLoadingVram] = useState<boolean>(false);
  const [aiBatchProgress, setAiBatchProgress] = useState<{
    current: number;
    total: number;
    succeeded: number;
    failed: number;
  } | null>(null);
  const cancelBatchRef = useRef<boolean>(false);

  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [error, setError] = useState<string>("");

  const [tagInput, setTagInput] = useState<string>("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);

  // Unrestricted Drag-resize handlers
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
  }, [viewMode, isLeftCollapsed, isRightCollapsed]);

  const { gridColumns, cardThumbHeight, rowEstimateHeight } = useMemo(() => {
    const targetCardW = 115 + zoomLevel * 325;
    const cols = Math.max(1, Math.min(12, Math.floor(centerWidth / targetCardW)));
    const actualCardW = Math.floor((centerWidth - (cols - 1) * 14) / cols);
    const thumbH = Math.max(90, Math.min(380, Math.round(actualCardW * 0.74)));
    return {
      gridColumns: cols,
      cardThumbHeight: thumbH,
      rowEstimateHeight: thumbH + 46,
    };
  }, [zoomLevel, centerWidth]);

  // Poll Ollama status
  useEffect(() => {
    async function checkStatus() {
      try {
        const s = await invoke<OllamaStatus>("check_ollama_status");
        setOllamaStatus(s);
        if (s.installed_models.length > 0 && !s.installed_models.some((m) => m.name === aiModel)) {
          setAiModel(s.installed_models[0].name);
        }
      } catch {
        setOllamaStatus({ running: false, active_vram_model: null, installed_models: [] });
      }
    }
    checkStatus();
    const interval = setInterval(checkStatus, 3500);
    return () => clearInterval(interval);
  }, [aiModel]);

  async function refreshPeople(currentFolder = folder) {
    try {
      const res = await invoke<PersonItem[]>("get_people", {
        rootFolder: currentFolder || null,
      });
      setPeople(res);
    } catch {}
  }

  // Refresh Timeline Buckets
  async function refreshTimeline(currentFolder = folder) {
    try {
      const b = await invoke<TimelineBucket[]>("get_timeline_distribution", {
        rootFolder: currentFolder || null,
      });
      setTimelineBuckets(b);
    } catch {}
  }

  useEffect(() => {
    refreshPeople(folder);
    refreshTimeline(folder);
  }, [photos.length, folder]);

  useEffect(() => {
    const unlisten = listen<FaceMatchEvent>("face-automatch-complete", (event) => {
      const { person_name, matched_hashes, total_matched } = event.payload;
      if (total_matched > 0) {
        const matchedSet = new Set(matched_hashes);
        setPhotos((prev) =>
          prev.map((p) =>
            matchedSet.has(p.hash) && !p.people.includes(person_name)
              ? { ...p, people: [...p.people, person_name].sort() }
              : p
          )
        );
        setAutoMatchNotice(
          `✨ Auto-matched "${person_name}" across ${total_matched} other verified face${total_matched === 1 ? "" : "s"}!`
        );
        setTimeout(() => setAutoMatchNotice(""), 6000);
      } else {
        setAutoMatchNotice(`Saved "${person_name}"!`);
        setTimeout(() => setAutoMatchNotice(""), 3500);
      }
      refreshPeople();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<FaceScanProgress>("face-scan-progress", async (event) => {
      const prog = event.payload;
      if (prog.done) {
        setFaceScanProgress(null);
        setAutoMatchNotice(
          `🧠 Neural ONNX Face Scan complete: detected ${prog.faces_found} human face(s)` +
            (prog.auto_matched > 0 ? ` & auto-matched ${prog.auto_matched} photo(s)!` : "!")
        );
        setTimeout(() => setAutoMatchNotice(""), 6000);
        refreshPeople();
        if (folder) {
          const res = await invoke<PhotoItem[]>("scan_folder", {
            folderPath: folder,
            forceReprocess: false,
          });
          setPhotos(res);
        }
      } else {
        setFaceScanProgress(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [folder]);

  // Batched Thumbnail Progress Listener
  useEffect(() => {
    const unlisten = listen<ThumbBatchProgress>("thumb-batch-ready", (event) => {
      const { items, duplicate_groups, completed, total } = event.payload;
      setProgress(completed < total ? { completed, total } : null);

      const batchMap = new Map<string, ThumbBatchItem>();
      for (const it of items) batchMap.set(it.hash, it);
      const hasDupUpdate = duplicate_groups && Object.keys(duplicate_groups).length > 0;

      setPhotos((prev) =>
        prev.map((p) => {
          const hit = batchMap.get(p.hash);
          const nextDup = hasDupUpdate ? duplicate_groups[p.hash] ?? null : p.duplicate_group;

          if (!hit) {
            return nextDup !== p.duplicate_group ? { ...p, duplicate_group: nextDup } : p;
          }

          const mergedTags =
            hit.auto_tags && hit.auto_tags.length > 0
              ? Array.from(new Set([...p.tags, ...hit.auto_tags])).sort()
              : p.tags;

          return {
            ...p,
            thumb_path: hit.thumb_path,
            dhash: hit.dhash,
            sharpness: hit.sharpness,
            width: hit.width || p.width,
            height: hit.height || p.height,
            tags: mergedTags,
            thumb_ready: true,
            duplicate_group: nextDup,
          };
        })
      );
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  function getPhotoEventName(p: PhotoItem): string {
    const ym = p.captured_at && p.captured_at.length >= 7 ? p.captured_at.slice(0, 7).replace(":", "-") : "";
    const city = p.location ? p.location.split(",")[0] : "";
    if (ym && city) return `${ym} • ${city}`;
    if (ym) return `${ym}`;
    return "";
  }

  const folderTree = useMemo(() => buildFolderTree(photos), [photos]);

  useEffect(() => {
    if (folderTree.nodes.length > 0 && expandedFolders.size === 0) {
      setExpandedFolders(new Set(folderTree.nodes.map((n) => n.fullPath)));
    }
  }, [folderTree.nodes]);

  const autoEvents = useMemo(() => {
    const counts = new Map<string, number>();
    photos.forEach((p) => {
      const ev = getPhotoEventName(p);
      if (ev) counts.set(ev, (counts.get(ev) || 0) + 1);
    });
    return Array.from(counts.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [photos]);

  const allLibraryTags = useMemo(() => {
    const s = new Set<string>();
    photos.forEach((p) => p.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [photos]);

  const stagedPhotos = useMemo(() => photos.filter((p) => Boolean(p.staged_target)), [photos]);
  const gpsPhotosCount = useMemo(() => photos.filter((p) => p.latitude != null && p.longitude != null).length, [photos]);
  const screenshotPhotosCount = useMemo(() => photos.filter((p) => p.tags.includes("screenshot")).length, [photos]);
  const picksCount = useMemo(() => photos.filter((p) => p.flag === "pick").length, [photos]);
  const rejectsCount = useMemo(() => photos.filter((p) => p.flag === "reject").length, [photos]);
  const basketCount = useMemo(() => photos.filter((p) => p.in_basket).length, [photos]);

  const { sharpestInGroup, burstGroupCounts, totalBurstGroups } = useMemo(() => {
    const best = new Map<number, { hash: string; sharpness: number }>();
    const counts = new Map<number, number>();
    photos.forEach((p) => {
      if (!p.duplicate_group || p.subfolder === "_Trash") return;
      counts.set(p.duplicate_group, (counts.get(p.duplicate_group) || 0) + 1);
      const cur = best.get(p.duplicate_group);
      if (!cur || p.sharpness > cur.sharpness) {
        best.set(p.duplicate_group, { hash: p.hash, sharpness: p.sharpness });
      }
    });
    return {
      sharpestInGroup: best,
      burstGroupCounts: counts,
      totalBurstGroups: counts.size,
    };
  }, [photos]);

  const duplicatePhotosCount = useMemo(
    () => photos.filter((p) => p.duplicate_group && p.subfolder !== "_Trash").length,
    [photos]
  );

  // Main Filtered, Sliced & Sorted Photo List
  const visiblePhotos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = photos.filter((p) => {
      if (smartFilter === "PICKS" && p.flag !== "pick") return false;
      if (smartFilter === "REJECTS" && p.flag !== "reject") return false;
      if (smartFilter === "BASKET" && !p.in_basket) return false;
      if (smartFilter === "FAVORITES" && p.rating < 4) return false;
      if (smartFilter === "UNTAGGED" && (p.tags.length > 0 || p.ai_caption.length > 0)) return false;
      if (smartFilter === "AI_TAGGED" && p.tags.length === 0 && !p.ai_caption) return false;
      if (smartFilter === "SCREENSHOTS" && !p.tags.includes("screenshot")) return false;
      if (smartFilter === "DUPLICATES" && (!p.duplicate_group || p.subfolder === "_Trash")) return false;
      if (smartFilter === "HAS_OCR" && !p.ocr_text) return false;
      if (smartFilter === "HAS_GPS" && (p.latitude == null || p.longitude == null)) return false;
      if (smartFilter === "STAGED" && !p.staged_target) return false;

      // Day-Accurate Timeline Slicer Filter ("YYYY-MM-DD")
      if (selectedPeriodRange) {
        const [startDay, endDay] = selectedPeriodRange;
        const pDay = p.captured_at ? p.captured_at.slice(0, 10).replace(/:/g, "-") : "";
        if (!pDay || pDay < startDay || pDay > endDay) return false;
      }

      // Orientation Filter (True image dimensions + non-destructive rotation)
      if (orientationFilter !== "ALL") {
        const swapped = p.rotation === 90 || p.rotation === 270;
        const effW = swapped ? p.height : p.width;
        const effH = swapped ? p.width : p.height;
        if (effW > 0 && effH > 0) {
          const isSquare = Math.abs(effW - effH) / Math.max(effW, effH) <= 0.05;
          if (orientationFilter === "SQUARE" && !isSquare) return false;
          if (orientationFilter === "PORTRAIT" && (isSquare || effH <= effW)) return false;
          if (orientationFilter === "LANDSCAPE" && (isSquare || effW <= effH)) return false;
        } else {
          // Fallback if dimensions are not yet indexed
          if (orientationFilter === "PORTRAIT" && !swapped) return false;
          if (orientationFilter === "LANDSCAPE" && swapped) return false;
          if (orientationFilter === "SQUARE") return false;
        }
      }

      if (selectedPerson && !p.people.includes(selectedPerson)) return false;
      if (activeSubfolder !== "ALL") {
        if (activeSubfolder === "Root") {
          if (p.subfolder !== "Root") return false;
        } else {
          if (p.subfolder !== activeSubfolder && !p.subfolder.startsWith(activeSubfolder + " / ")) {
            return false;
          }
        }
      }
      if (activeEvent !== "ALL" && getPhotoEventName(p) !== activeEvent) return false;
      if (activeTag !== "ALL" && !p.tags.includes(activeTag)) return false;

      if (q) {
        const mName = p.name.toLowerCase().includes(q);
        const mCaption = p.ai_caption.toLowerCase().includes(q);
        const mOcr = p.ocr_text.toLowerCase().includes(q);
        const mTag = p.tags.some((t) => t.toLowerCase().includes(q));
        const mLoc = p.location.toLowerCase().includes(q);
        const mPerson = p.people.some((pe) => pe.toLowerCase().includes(q));
        if (!mName && !mCaption && !mOcr && !mTag && !mLoc && !mPerson) return false;
      }
      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      if (smartFilter === "DUPLICATES") {
        return (a.duplicate_group || 0) - (b.duplicate_group || 0) || b.sharpness - a.sharpness;
      }
      switch (sortBy) {
        case "NAME_ASC":
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        case "NAME_DESC":
          return b.name.localeCompare(a.name, undefined, { numeric: true });
        case "DATE_DESC":
          return (b.captured_at || "").localeCompare(a.captured_at || "") || a.name.localeCompare(b.name);
        case "DATE_ASC":
          return (a.captured_at || "9999").localeCompare(b.captured_at || "9999") || a.name.localeCompare(b.name);
        case "SCORE_DESC":
          return b.sharpness - a.sharpness;
        case "SCORE_ASC":
          return a.sharpness - b.sharpness;
        case "RATING_DESC":
          return b.rating - a.rating || b.sharpness - a.sharpness;
        case "TAG_NAME": {
          const tA = a.tags[0] || "zzzz";
          const tB = b.tags[0] || "zzzz";
          return tA.localeCompare(tB) || a.name.localeCompare(b.name);
        }
        case "TAG_COUNT":
          return b.tags.length - a.tags.length || a.name.localeCompare(b.name);
        case "SIZE_DESC":
          return b.size_kb - a.size_kb;
        default:
          return 0;
      }
    });

    if (viewMode === "map") return sorted;

    const groupMembers = new Map<number, PhotoItem[]>();
    for (const p of sorted) {
      if (p.duplicate_group && p.subfolder !== "_Trash") {
        const list = groupMembers.get(p.duplicate_group) || [];
        list.push(p);
        groupMembers.set(p.duplicate_group, list);
      }
    }

    const emittedGroups = new Set<number>();
    const finalDisplay: PhotoItem[] = [];

    for (const p of sorted) {
      const grp = p.duplicate_group;
      if (!grp || p.subfolder === "_Trash") {
        finalDisplay.push(p);
        continue;
      }
      if (emittedGroups.has(grp)) continue;
      emittedGroups.add(grp);

      const members = groupMembers.get(grp) || [p];
      const orderedMembers = [...members].sort((a, b) => b.sharpness - a.sharpness);

      if (showAllBurstVersions || expandedBurstGroups.has(grp)) {
        finalDisplay.push(...orderedMembers);
      } else {
        finalDisplay.push(orderedMembers[0]);
      }
    }

    return finalDisplay;
  }, [
    photos,
    smartFilter,
    orientationFilter,
    selectedPeriodRange,
    selectedPerson,
    activeSubfolder,
    activeEvent,
    activeTag,
    searchQuery,
    sortBy,
    showAllBurstVersions,
    expandedBurstGroups,
    viewMode,
  ]);

  const activePhoto = useMemo(
    () => photos.find((p) => p.hash === activeHash) || null,
    [photos, activeHash]
  );

  // Determine the 2..4 photos to show in Side-by-Side Synchronized Compare Mode
  const comparePhotos = useMemo(() => {
    if (selectedHashes.size >= 2) {
      return visiblePhotos.filter((p) => selectedHashes.has(p.hash)).slice(0, 4);
    }
    if (activePhoto?.duplicate_group) {
      return photos
        .filter((p) => p.duplicate_group === activePhoto.duplicate_group && p.subfolder !== "_Trash")
        .sort((a, b) => b.sharpness - a.sharpness)
        .slice(0, 4);
    }
    const idx = activeHash ? visiblePhotos.findIndex((p) => p.hash === activeHash) : 0;
    const start = Math.max(0, idx);
    return visiblePhotos.slice(start, start + 2);
  }, [selectedHashes, visiblePhotos, activePhoto, photos, activeHash]);

  useEffect(() => {
    setSelectedFaceId(null);
    setDrawnBox(null);
    setIsDrawingFace(false);
    setFaceNameInput("");
    setIsEditingInspectorLocation(false);
  }, [activeHash]);

  const rowCount = Math.ceil(visiblePhotos.length / gridColumns);

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
      if (visiblePhotos.length === 0) return;
      const curIdx = activeHash ? visiblePhotos.findIndex((p) => p.hash === activeHash) : -1;
      const nextIdx =
        curIdx === -1
          ? 0
          : Math.max(0, Math.min(visiblePhotos.length - 1, curIdx + offset));

      const targetPhoto = visiblePhotos[nextIdx];
      if (!targetPhoto) return;

      setActiveHash(targetPhoto.hash);
      if (extendSelection && lastSelectedIndexRef.current !== null) {
        const start = Math.min(lastSelectedIndexRef.current, nextIdx);
        const end = Math.max(lastSelectedIndexRef.current, nextIdx);
        const nextSet = new Set(selectedHashes);
        for (let i = start; i <= end; i++) nextSet.add(visiblePhotos[i].hash);
        setSelectedHashes(nextSet);
      } else {
        setSelectedHashes(new Set([targetPhoto.hash]));
        lastSelectedIndexRef.current = nextIdx;
      }

      const targetRow = Math.floor(nextIdx / gridColumns);
      rowVirtualizer.scrollToIndex(targetRow, { align: "auto" });
    },
    [visiblePhotos, activeHash, gridColumns, selectedHashes, rowVirtualizer]
  );

  // Pro Keyboard Shortcuts (Pick/Reject P/X/U, Colors 6-9, Rotation [ ], Rating 1-5, Loupe Space)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      const tag = document.activeElement?.tagName.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;

      if (e.key === "ArrowRight") {
        e.preventDefault();
        navigateByOffset(1, e.shiftKey);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigateByOffset(-1, e.shiftKey);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        navigateByOffset(isLoupeOpen ? 1 : gridColumns, e.shiftKey);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        navigateByOffset(isLoupeOpen ? -1 : -gridColumns, e.shiftKey);
      } else if (e.key === " ") {
        e.preventDefault();
        if (activeHash) setIsLoupeOpen((prev) => !prev);
      } else if (e.key === "Escape") {
        setIsLoupeOpen(false);
        setIsCommitModalOpen(false);
        setIsDrawingFace(false);
        setDrawnBox(null);
        setActiveBulkPopover(null);
      } else if (e.key.toLowerCase() === "p" && selectedHashes.size > 0) {
        e.preventDefault();
        handleSetFlag("pick");
        if (autoAdvance) navigateByOffset(1, false);
      } else if (e.key.toLowerCase() === "u" && selectedHashes.size > 0) {
        e.preventDefault();
        handleSetFlag(null);
      } else if (e.key.toLowerCase() === "x" && selectedHashes.size > 0) {
        e.preventDefault();
        handleSetFlag("reject");
        handleBatchStageMove("_Trash");
        if (autoAdvance) navigateByOffset(1, false);
      } else if (["1", "2", "3", "4", "5", "0"].includes(e.key) && selectedHashes.size > 0) {
        handleBatchRate(Number(e.key));
        if (autoAdvance && e.key !== "0") navigateByOffset(1, false);
      } else if (e.key === "6" && selectedHashes.size > 0) {
        handleSetColorLabel("red");
      } else if (e.key === "7" && selectedHashes.size > 0) {
        handleSetColorLabel("yellow");
      } else if (e.key === "8" && selectedHashes.size > 0) {
        handleSetColorLabel("green");
      } else if (e.key === "9" && selectedHashes.size > 0) {
        handleSetColorLabel("blue");
      } else if (e.key === "[" && selectedHashes.size > 0) {
        handleRotateSelection(-90);
      } else if (e.key === "]" && selectedHashes.size > 0) {
        handleRotateSelection(90);
      } else if (e.key.toLowerCase() === "a" && activePhoto) {
        handleAiAnalyzeSingle();
      } else if (e.key.toLowerCase() === "g" && !isLoupeOpen) {
        setViewMode("grid");
      } else if (e.key.toLowerCase() === "m" && !isLoupeOpen) {
        setViewMode("map");
      } else if (e.key.toLowerCase() === "c" && !isLoupeOpen) {
        setCompareZoom(1);
        setComparePan({ x: 0, y: 0 });
        setViewMode((prev) => (prev === "compare" ? "grid" : "compare"));
      } else if (e.key.toLowerCase() === "b" && selectedHashes.size > 0) {
        e.preventDefault();
        handleToggleBasketSelection();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeHash, activePhoto, selectedHashes, isLoupeOpen, gridColumns, navigateByOffset, autoAdvance]);

  function handlePhotoClick(index: number, hash: string, e: React.MouseEvent) {
    setActiveHash(hash);
    if (e.shiftKey && lastSelectedIndexRef.current !== null) {
      const start = Math.min(lastSelectedIndexRef.current, index);
      const end = Math.max(lastSelectedIndexRef.current, index);
      const next = new Set(selectedHashes);
      for (let i = start; i <= end; i++) next.add(visiblePhotos[i].hash);
      setSelectedHashes(next);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedHashes);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      setSelectedHashes(next);
      lastSelectedIndexRef.current = index;
    } else {
      setSelectedHashes(new Set([hash]));
      lastSelectedIndexRef.current = index;
    }
  }

  function toggleBurstGroupExpand(groupNum: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (showAllBurstVersions) {
      setShowAllBurstVersions(false);
      return;
    }
    setExpandedBurstGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupNum)) next.delete(groupNum);
      else next.add(groupNum);
      return next;
    });
  }

  async function handleOpenFolder() {
    try {
      setError("");
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        setFolder(selected);
        setSelectedHashes(new Set());
        setActiveHash(null);
        setExpandedFolders(new Set());
        setExpandedBurstGroups(new Set());
        setSelectedPeriodRange(null);
        setIsScanningFolder(true);
        const res = await invoke<PhotoItem[]>("scan_folder", {
          folderPath: selected,
          forceReprocess: false,
        });
        setPhotos(res);
        setIsScanningFolder(false);
        if (res.length > 0) {
          setActiveHash(res[0].hash);
          setSelectedHashes(new Set([res[0].hash]));
          lastSelectedIndexRef.current = 0;
        }
      }
    } catch (err) {
      setIsScanningFolder(false);
      setError(String(err));
    }
  }

  // Fast Rescan: Picks up new/deleted files & EXIF GPS
  async function handleRescanFolder() {
    if (!folder || isScanningFolder) return;
    try {
      setError("");
      setIsScanningFolder(true);
      const res = await invoke<PhotoItem[]>("scan_folder", {
        folderPath: folder,
        forceReprocess: false,
      });
      setPhotos(res);
      if (res.length > 0 && (!activeHash || !res.some((p) => p.hash === activeHash))) {
        setActiveHash(res[0].hash);
        setSelectedHashes(new Set([res[0].hash]));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setIsScanningFolder(false);
    }
  }

  // Local-Only Rescan & Process (Zero AI Calls!)
  async function handleRescanAndProcessFolder() {
    if (!folder || isScanningFolder) return;
    try {
      setError("");
      setIsScanningFolder(true);
      const res = await invoke<PhotoItem[]>("scan_folder", {
        folderPath: folder,
        forceReprocess: true,
      });
      setPhotos(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsScanningFolder(false);
    }
  }

  // Force EXIF Rescan for Active Photo or Multi-Selection
  async function handleForceRescanExifSelected() {
    const targets =
      selectedHashes.size > 0
        ? Array.from(selectedHashes)
        : activeHash
        ? [activeHash]
        : [];
    if (targets.length === 0) return;
    try {
      setError("");
      const results = await invoke<ExifRefreshResult[]>("rescan_exif_batch", { hashes: targets });
      const map = new Map(results.map((r) => [r.hash, r]));
      setPhotos((prev) =>
        prev.map((p) => {
          const hit = map.get(p.hash);
          if (!hit) return p;
          return {
            ...p,
            captured_at: hit.captured_at || p.captured_at,
            camera_model: hit.camera_model || p.camera_model,
            location: hit.location || p.location,
            latitude: hit.latitude ?? p.latitude,
            longitude: hit.longitude ?? p.longitude,
          };
        })
      );
      refreshTimeline();
      const first = results[0];
      if (first) {
        setAutoMatchNotice(
          `🔄 EXIF refreshed (${results.length} photo${results.length === 1 ? "" : "s"}): Date=${
            first.captured_at ? first.captured_at.split(" ")[0] : "None"
          } • Cam=${first.camera_model || "None"} • Loc=${first.location || "None"}`
        );
        setTimeout(() => setAutoMatchNotice(""), 4500);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  // Phase 3: Run ONNX Neural Face Detector on Current Photo
  async function handleDetectFacesSingleOnnx() {
    if (!activePhoto || isDetectingSingleFace) return;
    try {
      setError("");
      setIsDetectingSingleFace(true);
      const detected = await invoke<FaceInstance[]>("detect_faces_in_photo", {
        hash: activePhoto.hash,
        imagePath: activePhoto.path,
        forceOnnx: true,
      });
      setPhotos((prev) =>
        prev.map((p) => (p.hash === activePhoto.hash ? { ...p, faces: detected } : p))
      );
      setAutoMatchNotice(
        detected.length > 0
          ? `🧠 ONNX Neural Detector found ${detected.length} human face(s) in ${activePhoto.name}!`
          : `🧠 ONNX Neural Detector confirmed 0 human faces in ${activePhoto.name}.`
      );
      setTimeout(() => setAutoMatchNotice(""), 4000);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsDetectingSingleFace(false);
    }
  }

  // Phase 3: Run ONNX Neural Face Scanner on All Visible Photos in Background
  async function handleBatchScanFacesOnnx() {
    if (faceScanProgress || visiblePhotos.length === 0) return;
    try {
      setError("");
      const hashes = visiblePhotos.map((p) => p.hash);
      setFaceScanProgress({
        completed: 0,
        total: hashes.length,
        faces_found: 0,
        auto_matched: 0,
        done: false,
      });
      await invoke<number>("scan_library_faces_batch", { hashes });
    } catch (err) {
      setFaceScanProgress(null);
      setError(String(err));
    }
  }

  // Pick / Reject Flag Handler
  async function handleSetFlag(flag: "pick" | "reject" | null) {
    if (selectedHashes.size === 0) return;
    try {
      const hashes = Array.from(selectedHashes);
      await invoke("set_photo_flag", { hashes, flag });
      setPhotos((prev) =>
        prev.map((p) => (selectedHashes.has(p.hash) ? { ...p, flag } : p))
      );
    } catch (err) {
      setError(String(err));
    }
  }

  // Color Label Handler
  async function handleSetColorLabel(color: "red" | "yellow" | "green" | "blue" | null) {
    if (selectedHashes.size === 0) return;
    try {
      const hashes = Array.from(selectedHashes);
      await invoke("set_photo_color_label", { hashes, color });
      setPhotos((prev) =>
        prev.map((p) => (selectedHashes.has(p.hash) ? { ...p, color_label: color } : p))
      );
    } catch (err) {
      setError(String(err));
    }
  }

  // Non-Destructive Rotation Handler
  async function handleRotateSelection(deltaDegrees: number) {
    if (selectedHashes.size === 0) return;
    try {
      const hashes = Array.from(selectedHashes);
      const res = await invoke<Record<string, number>>("set_photo_rotation", {
        hashes,
        deltaDegrees,
      });
      setPhotos((prev) =>
        prev.map((p) => (res[p.hash] !== undefined ? { ...p, rotation: res[p.hash] } : p))
      );
    } catch (err) {
      setError(String(err));
    }
  }

  // Batch Rating Handler
  async function handleBatchRate(rating: number) {
    try {
      for (const h of selectedHashes) await invoke("set_rating", { hash: h, rating });
      setPhotos((prev) => prev.map((p) => (selectedHashes.has(p.hash) ? { ...p, rating } : p)));
    } catch (err) {
      setError(String(err));
    }
  }

  // Batch Add Tag
  async function handleBatchAddTag(tag: string) {
    if (!tag.trim() || selectedHashes.size === 0) return;
    try {
      const clean = tag.trim().toLowerCase();
      for (const h of selectedHashes) await invoke("add_tag", { hash: h, tag: clean });
      setPhotos((prev) =>
        prev.map((p) =>
          selectedHashes.has(p.hash) && !p.tags.includes(clean)
            ? { ...p, tags: [...p.tags, clean].sort() }
            : p
        )
      );
      setTagInput("");
      setBulkInput("");
      setActiveBulkPopover(null);
    } catch (err) {
      setError(String(err));
    }
  }

  // Batch Move Target
  async function handleBatchStageMove(targetSub: string | null) {
    try {
      for (const h of selectedHashes) {
        await invoke("stage_photo_move", { hash: h, targetSubfolder: targetSub });
      }
      setPhotos((prev) =>
        prev.map((p) => (selectedHashes.has(p.hash) ? { ...p, staged_target: targetSub } : p))
      );
      setBulkInput("");
      setActiveBulkPopover(null);
    } catch (err) {
      setError(String(err));
    }
  }

  // Manual City Search & GPS Assign
  async function handleSearchCities(q: string) {
    setBulkInput(q);
    if (q.trim().length >= 2) {
      try {
        const matches = await invoke<CitySearchResult[]>("search_cities_offline", { query: q });
        setCitySearchResults(matches);
      } catch {}
    } else {
      setCitySearchResults([]);
    }
  }

  async function handleAssignCity(c: CitySearchResult) {
    const targets =
      selectedHashes.size > 0
        ? Array.from(selectedHashes)
        : activeHash
        ? [activeHash]
        : [];
    if (targets.length === 0) return;
    try {
      const locStr = `${c.name}, ${c.country}`;
      await invoke("set_manual_location", {
        hashes: targets,
        location: locStr,
        latitude: c.latitude,
        longitude: c.longitude,
      });
      const targetSet = new Set(targets);
      setPhotos((prev) =>
        prev.map((p) =>
          targetSet.has(p.hash)
            ? { ...p, location: locStr, latitude: c.latitude, longitude: c.longitude }
            : p
        )
      );
      setActiveBulkPopover(null);
      setIsEditingInspectorLocation(false);
      setCitySearchResults([]);
      setBulkInput("");
      setInspectorLocationQuery("");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleAssignCustomLocationText(customLoc: string) {
    const clean = customLoc.trim();
    const targets =
      selectedHashes.size > 0
        ? Array.from(selectedHashes)
        : activeHash
        ? [activeHash]
        : [];
    if (targets.length === 0) return;
    try {
      await invoke("set_manual_location", {
        hashes: targets,
        location: clean,
        latitude: null,
        longitude: null,
      });
      const targetSet = new Set(targets);
      setPhotos((prev) =>
        prev.map((p) =>
          targetSet.has(p.hash)
            ? { ...p, location: clean, latitude: clean ? p.latitude : null, longitude: clean ? p.longitude : null }
            : p
        )
      );
      setIsEditingInspectorLocation(false);
      setActiveBulkPopover(null);
      setInspectorLocationQuery("");
      setBulkInput("");
    } catch (err) {
      setError(String(err));
    }
  }

  // Interactive Face Drawing on Aspect-Ratio Preserving Preview
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

  async function handleSaveFaceAndAutomatch(e: React.FormEvent) {
    e.preventDefault();
    if (!activePhoto || !faceNameInput.trim()) return;
    const cleanName = faceNameInput.trim();

    let targetBbox: { x: number; y: number; w: number; h: number } | null = null;
    if (drawnBox) {
      targetBbox = drawnBox;
    } else if (selectedFaceId) {
      const found = activePhoto.faces.find((f) => f.face_id === selectedFaceId);
      if (found) targetBbox = { x: found.bbox_x, y: found.bbox_y, w: found.bbox_w, h: found.bbox_h };
    }

    if (!targetBbox) {
      setError("Please click an AI face box or draw a box over the person's face first!");
      return;
    }

    try {
      setError("");
      setAutoMatchNotice(`🔍 Saving "${cleanName}" & matching against verified faces...`);
      const updatedFaces = await invoke<FaceInstance[]>("assign_face_region_and_automatch", {
        hash: activePhoto.hash,
        imagePath: activePhoto.path,
        bboxX: targetBbox.x,
        bboxY: targetBbox.y,
        bboxW: targetBbox.w,
        bboxH: targetBbox.h,
        personName: cleanName,
      });

      setPhotos((prev) =>
        prev.map((p) =>
          p.hash === activePhoto.hash
            ? {
                ...p,
                faces: updatedFaces,
                people: p.people.includes(cleanName) ? p.people : [...p.people, cleanName].sort(),
              }
            : p
        )
      );
      setFaceNameInput("");
      setDrawnBox(null);
      setSelectedFaceId(null);
      refreshPeople();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRemovePerson(name: string) {
    if (!activePhoto) return;
    try {
      const updated = await invoke<string[]>("remove_person_from_photo", {
        hash: activePhoto.hash,
        name,
      });
      setPhotos((prev) =>
        prev.map((p) =>
          p.hash === activePhoto.hash
            ? {
                ...p,
                people: updated,
                faces: p.faces.map((f) => (f.person_name === name ? { ...f, person_name: null } : f)),
              }
            : p
        )
      );
      refreshPeople();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDismissAllStaged() {
    try {
      await invoke<number>("clear_all_staged", { rootFolder: folder || null });
      setPhotos((prev) => prev.map((p) => (p.staged_target ? { ...p, staged_target: null } : p)));
      setIsCommitModalOpen(false);
      if (smartFilter === "STAGED") setSmartFilter("ALL");
    } catch (err) {
      setError(String(err));
    }
  }

  function computePresetTargetFolder(p: PhotoItem, preset: AutoStagePreset): string | null {
    const ym = p.captured_at && p.captured_at.length >= 7 ? p.captured_at.slice(0, 7).replace(/:/g, "-") : "Undated";
    const yr = ym !== "Undated" ? ym.slice(0, 4) : "Undated";
    const city = p.location ? p.location.split(",")[0].trim() : "";

    switch (preset) {
      case "YEAR_MONTH_CITY":
        if (ym === "Undated") return null;
        return `${yr}/${ym}${city ? `_${city}` : ""}`;
      case "YEAR_MONTH":
        if (ym === "Undated") return null;
        return `${yr}/${ym}`;
      case "PERSON_YEAR": {
        const person = p.people[0] || "Unassigned_People";
        return `People/${person}/${yr}`;
      }
      case "SCREENSHOTS_BY_MONTH":
        if (!p.tags.includes("screenshot")) return null;
        return `_Screenshots/${ym}`;
      case "FAVORITES_YEAR":
        if (p.rating < 4 && p.flag !== "pick") return null;
        return `Favorites/${yr}`;
      default:
        return null;
    }
  }

  async function handleAutoOrganizeByPreset() {
    try {
      const updates = new Map<string, string>();
      for (const p of visiblePhotos) {
        const target = computePresetTargetFolder(p, autoStagePreset);
        if (!target) continue;
        await invoke("stage_photo_move", { hash: p.hash, targetSubfolder: target });
        updates.set(p.hash, target);
      }
      if (updates.size > 0) {
        setPhotos((prev) =>
          prev.map((p) => (updates.has(p.hash) ? { ...p, staged_target: updates.get(p.hash)! } : p))
        );
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleCommitAllStaged() {
    if (!folder) return;
    try {
      await invoke<number>("commit_staged_operations", {
        rootFolder: folder,
        smartRename: smartRenameOnCommit,
      });
      const res = await invoke<PhotoItem[]>("scan_folder", {
        folderPath: folder,
        forceReprocess: false,
      });
      setPhotos(res);
      setIsCommitModalOpen(false);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleToggleBasketSelection() {
    if (selectedHashes.size === 0) return;
    try {
      const hashes = Array.from(selectedHashes);
      const anyNotInBasket = photos.some((p) => selectedHashes.has(p.hash) && !p.in_basket);
      await invoke("set_photo_basket", { hashes, inBasket: anyNotInBasket });
      setPhotos((prev) =>
        prev.map((p) => (selectedHashes.has(p.hash) ? { ...p, in_basket: anyNotInBasket } : p))
      );
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleMapPickCoordinates(lat: number, lon: number) {
    if (selectedHashes.size === 0) return;
    try {
      const hashes = Array.from(selectedHashes);
      await invoke("set_manual_location", {
        hashes,
        location: "",
        latitude: lat,
        longitude: lon,
      });
      const res = await invoke<PhotoItem[]>("scan_folder", {
        folderPath: folder,
        forceReprocess: false,
      });
      setPhotos(res);
      setIsPickingMapLocation(false);
      setAutoMatchNotice(`📍 Assigned GPS (${lat.toFixed(4)}, ${lon.toFixed(4)}) to ${hashes.length} photo(s)!`);
      setTimeout(() => setAutoMatchNotice(""), 4500);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleShiftTimestamps(e: React.FormEvent) {
    e.preventDefault();
    if (selectedHashes.size === 0) return;
    const totalMinutes = shiftHoursInput * 60 + shiftMinutesInput;
    if (totalMinutes === 0) return;
    try {
      const hashes = Array.from(selectedHashes);
      const shifted = await invoke<TimestampShiftResult[]>("shift_capture_timestamps", {
        hashes,
        offsetMinutes: totalMinutes,
      });
      const map = new Map(shifted.map((s) => [s.hash, s.captured_at]));
      setPhotos((prev) =>
        prev.map((p) => (map.has(p.hash) ? { ...p, captured_at: map.get(p.hash)! } : p))
      );
      refreshTimeline();
      setActiveBulkPopover(null);
      setAutoMatchNotice(`🕒 Shifted ${shifted.length} timestamp(s) by ${totalMinutes > 0 ? `+${totalMinutes}` : totalMinutes} min.`);
      setTimeout(() => setAutoMatchNotice(""), 4000);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleOpenHealthDashboard() {
    try {
      setIsHealthModalOpen(true);
      const stats = await invoke<LibraryHealthStats>("get_library_health_stats", { rootFolder: folder || null });
      setHealthStats(stats);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleExportXmp(onlySelected: boolean) {
    try {
      setIsExportingXmp(true);
      const hashes = onlySelected && selectedHashes.size > 0 ? Array.from(selectedHashes) : null;
      const count = await invoke<number>("export_xmp_sidecars", { hashes });
      setAutoMatchNotice(`📄 Exported ${count} Adobe/Lightroom .xmp sidecar file(s)!`);
      setTimeout(() => setAutoMatchNotice(""), 5000);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsExportingXmp(false);
    }
  }

  async function handlePruneCache() {
    try {
      const removed = await invoke<number>("prune_orphaned_cache");
      const stats = await invoke<LibraryHealthStats>("get_library_health_stats", { rootFolder: folder || null });
      setHealthStats(stats);
      setAutoMatchNotice(`🧹 Pruned ${removed} orphaned cache file(s)!`);
      setTimeout(() => setAutoMatchNotice(""), 4000);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleKeepSharpestInAllGroups() {
    try {
      const toTrash = photos.filter(
        (p) =>
          p.duplicate_group &&
          p.subfolder !== "_Trash" &&
          sharpestInGroup.get(p.duplicate_group)?.hash !== p.hash
      );
      for (const p of toTrash) {
        await invoke("stage_photo_move", { hash: p.hash, targetSubfolder: "_Trash" });
      }
      setPhotos((prev) =>
        prev.map((p) =>
          p.duplicate_group &&
          p.subfolder !== "_Trash" &&
          sharpestInGroup.get(p.duplicate_group)?.hash !== p.hash
            ? { ...p, staged_target: "_Trash" }
            : p
        )
      );
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleAiAnalyzeSingle() {
    if (!activePhoto || analyzingHashes.has(activePhoto.hash)) return;
    const targetHash = activePhoto.hash;
    try {
      setError("");
      setAnalyzingHashes((prev) => new Set(prev).add(targetHash));
      const res = await invoke<AiAnalysisResult>("ai_analyze_photo", {
        hash: targetHash,
        imagePathForAi: activePhoto.path,
        modelName: aiModel,
        existingTags: allLibraryTags,
      });
      setPhotos((prev) =>
        prev.map((p) =>
          p.hash === targetHash
            ? {
                ...p,
                tags: res.tags,
                people: res.people,
                faces: res.faces,
                ai_caption: res.caption,
                ocr_text: res.ocr_text,
              }
            : p
        )
      );
      refreshPeople();
    } catch (err) {
      setError(`AI Error on ${activePhoto.name}: ${String(err)}`);
    } finally {
      setAnalyzingHashes((prev) => {
        const next = new Set(prev);
        next.delete(targetHash);
        return next;
      });
    }
  }

  async function runBatchAiOnList(targets: PhotoItem[]) {
    if (aiBatchProgress || targets.length === 0) return;

    cancelBatchRef.current = false;
    setError("");
    setAiBatchProgress({ current: 0, total: targets.length, succeeded: 0, failed: 0 });

    let completedCount = 0;
    let succeededCount = 0;
    let failedCount = 0;
    let firstErrorMsg = "";
    const CONCURRENCY = 2;

    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      if (cancelBatchRef.current) break;
      const chunk = targets.slice(i, i + CONCURRENCY);

      setAnalyzingHashes((prev) => {
        const next = new Set(prev);
        chunk.forEach((c) => next.add(c.hash));
        return next;
      });

      await Promise.all(
        chunk.map(async (photo) => {
          if (cancelBatchRef.current) return;
          try {
            const res = await invoke<AiAnalysisResult>("ai_analyze_photo", {
              hash: photo.hash,
              imagePathForAi: photo.path,
              modelName: aiModel,
              existingTags: allLibraryTags,
            });
            succeededCount++;
            setPhotos((prev) =>
              prev.map((p) =>
                p.hash === photo.hash
                  ? {
                      ...p,
                      tags: res.tags,
                      people: res.people,
                      faces: res.faces,
                      ai_caption: res.caption,
                      ocr_text: res.ocr_text,
                    }
                  : p
              )
            );
          } catch (err) {
            failedCount++;
            if (!firstErrorMsg) firstErrorMsg = String(err);
            console.error(`Batch AI error on ${photo.name}:`, err);
          } finally {
            completedCount++;
            setAnalyzingHashes((prev) => {
              const next = new Set(prev);
              next.delete(photo.hash);
              return next;
            });
            setAiBatchProgress({
              current: completedCount,
              total: targets.length,
              succeeded: succeededCount,
              failed: failedCount,
            });
          }
        })
      );

      if (succeededCount > 0 && completedCount % 6 === 0) {
        refreshPeople();
      }
    }

    if (failedCount > 0 && succeededCount === 0) {
      setError(`AI Tagging failed (${failedCount} errors). First error: ${firstErrorMsg}`);
    }

    setAnalyzingHashes(new Set());
    setAiBatchProgress(null);
    refreshPeople();
  }

  function toggleFolderExpand(fullPath: string, e: React.MouseEvent) {
    e.stopPropagation();
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  }

  function renderFolderTreeNodes(nodes: FolderTreeNode[], depth = 0) {
    return nodes.map((node) => {
      const hasChildren = node.children.length > 0;
      const isExpanded = expandedFolders.has(node.fullPath);
      const isSelected = activeSubfolder === node.fullPath;

      return (
        <div key={node.fullPath} className="flex flex-col">
          <div
            onClick={() => {
              setActiveSubfolder(isSelected ? "ALL" : node.fullPath);
              if (hasChildren && !isExpanded) setExpandedFolders((prev) => new Set(prev).add(node.fullPath));
            }}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            className={`group flex items-center justify-between pr-2.5 py-1.5 rounded-md text-xs cursor-pointer transition ${
              isSelected
                ? "bg-indigo-500/20 text-indigo-300 font-medium border border-indigo-500/30"
                : "text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200"
            }`}
          >
            <div className="flex items-center gap-1.5 truncate">
              {hasChildren ? (
                <button
                  onClick={(e) => toggleFolderExpand(node.fullPath, e)}
                  className="p-0.5 hover:bg-zinc-700/60 rounded text-zinc-400 hover:text-white"
                >
                  {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
              ) : (
                <span className="w-4" />
              )}
              <Folder className={`w-3.5 h-3.5 shrink-0 ${isSelected ? "text-indigo-400" : "text-amber-500/80"}`} />
              <span className="truncate">{node.name}</span>
            </div>
            <span className="text-[10px] text-zinc-500 font-mono ml-1.5 shrink-0">{node.totalCount}</span>
          </div>

          {hasChildren && isExpanded && (
            <div className="flex flex-col border-l border-zinc-800/60 ml-3">
              {renderFolderTreeNodes(node.children, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <div className="flex flex-col h-screen bg-[#090a0f] text-zinc-100 select-none">
      {/* Top Header */}
      <header className="flex items-center justify-between px-4 py-2.5 bg-[#10121a]/80 backdrop-blur-md border-b border-zinc-800/60 z-20 gap-3">
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setIsLeftCollapsed((p) => !p)}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition"
            title={isLeftCollapsed ? "Expand Left Sidebar" : "Collapse Left Sidebar"}
          >
            {isLeftCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>

          <div className="flex items-center gap-2 mr-1">
            <img src={luminaMark} alt="Lumina" className="w-6 h-6 object-contain" />
            <span className="text-zinc-100 font-bold tracking-tight text-sm">Lumina</span>
            <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.2 rounded font-mono">
              v3.1
            </span>
          </div>

          <button
            onClick={handleOpenFolder}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800/80 hover:bg-zinc-700/80 text-zinc-200 border border-zinc-700/50 rounded-lg text-xs font-medium transition"
          >
            <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
            <span>Open Library</span>
          </button>

          {folder && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleRescanFolder}
                disabled={isScanningFolder}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 rounded-lg text-xs font-medium transition"
                title="Quickly scan folder for added/removed files & missing EXIF"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-zinc-400 ${isScanningFolder ? "animate-spin" : ""}`} />
                <span>Rescan</span>
              </button>

              <button
                onClick={handleRescanAndProcessFolder}
                disabled={isScanningFolder}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-emerald-300 border border-emerald-500/30 rounded-lg text-xs font-medium transition"
                title="Force-regenerate local thumbnails, focus scores & burst groups (No AI)"
              >
                <Zap className="w-3.5 h-3.5 text-emerald-400" />
                <span>Rescan & Process</span>
              </button>
            </div>
          )}

          <div className="flex bg-zinc-900/90 p-0.5 rounded-lg border border-zinc-800">
            <button
              onClick={() => setViewMode("grid")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition ${
                viewMode === "grid" ? "bg-zinc-800 text-zinc-100 shadow" : "text-zinc-400 hover:text-zinc-200"
              }`}
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
                viewMode === "compare" ? "bg-indigo-600 text-white shadow" : "text-zinc-400 hover:text-zinc-200"
              }`}
              title="Synchronized Side-by-Side Compare Mode (C)"
            >
              <Columns className="w-3.5 h-3.5" />
              <span>Compare</span>
            </button>
            <button
              onClick={() => setViewMode("map")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition ${
                viewMode === "map" ? "bg-zinc-800 text-zinc-100 shadow" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <MapPin className="w-3.5 h-3.5" />
              <span>Map ({gpsPhotosCount})</span>
            </button>
          </div>

          {photos.length > 0 && (
            <button
              onClick={handleOpenHealthDashboard}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 rounded-lg text-xs font-medium transition"
              title="Library Storage Health & XMP Sidecar Export"
            >
              <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden xl:inline">Health & XMP</span>
            </button>
          )}
        </div>

        {/* Center Search Pill */}
        {photos.length > 0 && (
          <div className="relative w-64 lg:w-80">
            <Search className="w-3.5 h-3.5 absolute left-3.5 top-2.5 text-zinc-500" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search objects, OCR, people... (Ctrl+K)"
              className="w-full bg-zinc-900/90 border border-zinc-800 hover:border-zinc-700 focus:border-emerald-500/80 rounded-full pl-9 pr-8 py-1.5 text-xs text-zinc-200 focus:outline-none transition placeholder-zinc-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-2.5 text-zinc-500 hover:text-zinc-300"
              >
                ✕
              </button>
            )}
          </div>
        )}

        {/* Right Hardware, Commit & Dismiss Dock */}
        <div className="flex items-center gap-2">
          {progress && (
            <span className="text-[11px] text-emerald-400 font-mono bg-emerald-950/50 border border-emerald-500/30 px-2 py-1 rounded-md">
              ⚡ Thumbs: {progress.completed}/{progress.total}
            </span>
          )}

          {stagedPhotos.length > 0 && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setIsCommitModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 rounded-lg text-xs font-semibold shadow-sm transition"
              >
                <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                <span>Commit ({stagedPhotos.length})</span>
              </button>
              <button
                onClick={handleDismissAllStaged}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-900 hover:bg-red-950/60 text-zinc-400 hover:text-red-300 border border-zinc-800 hover:border-red-800/50 rounded-lg text-xs font-medium transition"
                title="Dismiss and clear all staged moves"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Dismiss</span>
              </button>
            </div>
          )}

          {ollamaStatus?.running ? (
            <div className="flex items-center gap-2 px-2.5 py-1 bg-zinc-900/90 border border-zinc-800 rounded-lg text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
              <select
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                className="bg-transparent text-zinc-200 font-mono text-[11px] focus:outline-none"
              >
                {ollamaStatus.installed_models.map((m) => (
                  <option key={m.name} value={m.name} className="bg-zinc-900 text-zinc-200">
                    {m.name} ({m.size_gb}GB)
                  </option>
                ))}
              </select>

              {ollamaStatus.active_vram_model ? (
                <button
                  onClick={async () => {
                    if (ollamaStatus.active_vram_model) {
                      await invoke("unload_ollama_vram", { modelName: ollamaStatus.active_vram_model });
                      const s = await invoke<OllamaStatus>("check_ollama_status");
                      setOllamaStatus(s);
                    }
                  }}
                  className="flex items-center gap-1 text-[10px] bg-red-950/60 border border-red-800/50 text-red-300 hover:bg-red-900/60 px-2 py-0.5 rounded transition"
                  title="Eject model from VRAM"
                >
                  <Power className="w-3 h-3" />
                  <span>Eject</span>
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
                  className="flex items-center gap-1 text-[10px] bg-emerald-950/60 border border-emerald-800/50 text-emerald-300 hover:bg-emerald-900/60 px-2 py-0.5 rounded transition"
                  title="Warm up model in GPU VRAM"
                >
                  <Cpu className="w-3 h-3" />
                  <span>{isLoadingVram ? "..." : "Load VRAM"}</span>
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={() => invoke("start_ollama_service")}
              className="text-xs bg-red-950/40 border border-red-800/60 text-red-300 px-2.5 py-1 rounded-lg hover:bg-red-900/60 transition"
            >
              Start Ollama
            </button>
          )}

          {photos.length > 0 && (
            <>
              {!faceScanProgress ? (
                <button
                  onClick={handleBatchScanFacesOnnx}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-950/70 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-500/40 rounded-lg text-xs font-medium transition shadow-sm"
                  title="Run local ONNX Neural Face Detector across visible photos & auto-match known people"
                >
                  <ScanFace className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Scan Faces</span>
                </button>
              ) : (
                <span className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-950/90 border border-emerald-500/50 text-emerald-300 rounded-lg text-xs font-mono">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>
                    Faces: {faceScanProgress.completed}/{faceScanProgress.total} (👤{faceScanProgress.faces_found})
                  </span>
                </span>
              )}

              {!aiBatchProgress ? (
                <button
                  onClick={() => {
                    const targets = visiblePhotos.filter((p) => p.tags.length === 0 && !p.ai_caption);
                    runBatchAiOnList(targets.length > 0 ? targets : visiblePhotos);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition shadow-sm"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Batch AI</span>
                </button>
              ) : (
                <button
                  onClick={() => {
                    cancelBatchRef.current = true;
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-semibold transition"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>
                    Stop ({aiBatchProgress.current}/{aiBatchProgress.total} • ✓{aiBatchProgress.succeeded}
                    {aiBatchProgress.failed > 0 ? ` ⚠${aiBatchProgress.failed}` : ""})
                  </span>
                </button>
              )}
            </>
          )}

          <button
            onClick={() => setIsRightCollapsed((p) => !p)}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition"
            title={isRightCollapsed ? "Expand Right Inspector" : "Collapse Right Inspector"}
          >
            {isRightCollapsed ? <PanelRightOpen className="w-4 h-4" /> : <PanelRightClose className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {error && (
        <div className="px-5 py-2 bg-red-950/90 border-b border-red-800 text-red-200 text-xs flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError("")} className="hover:text-white">✕</button>
        </div>
      )}

      {autoMatchNotice && (
        <div className="px-5 py-2 bg-indigo-950/90 border-b border-indigo-500/40 text-indigo-200 text-xs flex justify-between items-center">
          <span>{autoMatchNotice}</span>
          <button onClick={() => setAutoMatchNotice("")} className="hover:text-white">✕</button>
        </div>
      )}

      {/* Top People Carousel */}
      {people.length > 0 && (
        <div className="px-5 py-2 bg-[#0c0d14] border-b border-zinc-800/40 flex items-center gap-2 overflow-x-auto">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mr-2 shrink-0">
            People
          </span>

          {people.map((p) => {
            const isSelected = selectedPerson === p.name;
            return (
              <button
                key={p.name}
                onClick={() => setSelectedPerson(isSelected ? null : p.name)}
                className={`flex items-center gap-2 px-2.5 py-1 rounded-full text-xs transition shrink-0 ${
                  isSelected
                    ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/50 shadow-sm"
                    : "bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 border border-zinc-800/80"
                }`}
              >
                {p.cover_thumb ? (
                  <img src={convertFileSrc(p.cover_thumb)} alt={p.name} className="w-5 h-5 rounded-full object-cover border border-zinc-700" />
                ) : (
                  <div className="w-5 h-5 rounded-full bg-zinc-800 flex items-center justify-center text-[10px]">👤</div>
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
        {/* LEFT PANE */}
        {!isLeftCollapsed && (
          <>
            <aside style={{ width: `${leftWidth}px` }} className="bg-[#0c0d14] flex flex-col p-3 gap-5 overflow-y-auto shrink-0">
              <div>
                <span className="text-[10px] font-bold text-zinc-500 tracking-wider uppercase">Culling & Triage</span>
                <div className="mt-2 flex flex-col gap-0.5 text-xs">
                  {[
                    { id: "ALL", label: "All Photos", count: photos.length, icon: "📷" },
                    { id: "PICKS", label: "Picks (P)", count: picksCount, icon: "🚩" },
                    { id: "BASKET", label: "Pinboard Basket (B)", count: basketCount, icon: "📌" },
                    { id: "REJECTS", label: "Rejects (X)", count: rejectsCount, icon: "❌" },
                    { id: "FAVORITES", label: "Favorites (4★+)", count: photos.filter((p) => p.rating >= 4).length, icon: "★" },
                    { id: "AI_TAGGED", label: "AI Tagged", count: photos.filter((p) => p.tags.length > 0 || p.ai_caption.length > 0).length, icon: "🟣" },
                    { id: "UNTAGGED", label: "Untagged", count: photos.filter((p) => p.tags.length === 0 && !p.ai_caption).length, icon: "✨" },
                    { id: "SCREENSHOTS", label: "Screenshots", count: screenshotPhotosCount, icon: "📱" },
                    { id: "DUPLICATES", label: `Burst Groups (${totalBurstGroups})`, count: duplicatePhotosCount, icon: "⧉" },
                    { id: "HAS_OCR", label: "Has Text (OCR)", count: photos.filter((p) => p.ocr_text).length, icon: "📄" },
                    { id: "HAS_GPS", label: "Has GPS Location", count: gpsPhotosCount, icon: "📍" },
                    ...(stagedPhotos.length > 0 ? [{ id: "STAGED", label: "Staged Moves", count: stagedPhotos.length, icon: "📦" }] : []),
                  ].map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        setSmartFilter(item.id as SmartFilter);
                        setSelectedPerson(null);
                        setActiveSubfolder("ALL");
                        setActiveEvent("ALL");
                        setActiveTag("ALL");
                      }}
                      className={`flex justify-between items-center px-2.5 py-1.5 rounded-md transition ${
                        smartFilter === item.id && !selectedPerson && activeSubfolder === "ALL" && activeEvent === "ALL"
                          ? "bg-zinc-800/80 text-zinc-100 font-medium"
                          : "text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-zinc-400">{item.icon}</span>
                        <span>{item.label}</span>
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">{item.count}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Hierarchical Folder Tree */}
              {photos.length > 0 && (
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-zinc-500 tracking-wider uppercase">Folders</span>
                    {activeSubfolder !== "ALL" && (
                      <button onClick={() => setActiveSubfolder("ALL")} className="text-[10px] text-indigo-400 hover:underline">
                        Reset
                      </button>
                    )}
                  </div>

                  <div className="mt-2 flex flex-col gap-0.5 max-h-56 overflow-y-auto pr-1">
                    {folderTree.rootCount > 0 && (
                      <div
                        onClick={() => setActiveSubfolder(activeSubfolder === "Root" ? "ALL" : "Root")}
                        className={`flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs cursor-pointer transition ${
                          activeSubfolder === "Root"
                            ? "bg-indigo-500/20 text-indigo-300 font-medium border border-indigo-500/30"
                            : "text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200"
                        }`}
                      >
                        <div className="flex items-center gap-1.5 truncate">
                          <span className="w-4" />
                          <Folder className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                          <span>Root (Top Level)</span>
                        </div>
                        <span className="text-[10px] text-zinc-500 font-mono">{folderTree.rootCount}</span>
                      </div>
                    )}
                    {renderFolderTreeNodes(folderTree.nodes, 0)}
                  </div>
                </div>
              )}

              {/* Auto-Events & Trips */}
              {autoEvents.length > 0 && (
                <div>
                  <span className="text-[10px] font-bold text-zinc-500 tracking-wider uppercase">Events & Trips</span>
                  <div className="mt-2 flex flex-col gap-0.5 text-xs max-h-36 overflow-y-auto">
                    {autoEvents.map(([ev, count]) => (
                      <button
                        key={ev}
                        onClick={() => setActiveEvent(ev === activeEvent ? "ALL" : ev)}
                        className={`flex justify-between items-center px-2.5 py-1.5 rounded-md text-left truncate transition ${
                          activeEvent === ev ? "bg-zinc-800 text-zinc-100 font-medium" : "text-zinc-400 hover:bg-zinc-900/60"
                        }`}
                      >
                        <span className="truncate flex items-center gap-1.5">
                          <Calendar className="w-3 h-3 shrink-0 text-emerald-400" /> {ev}
                        </span>
                        <span className="text-[10px] text-zinc-500 font-mono ml-1">{count}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Object Tags */}
              {allLibraryTags.length > 0 && (
                <div>
                  <span className="text-[10px] font-bold text-zinc-500 tracking-wider uppercase">Tags ({allLibraryTags.length})</span>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {allLibraryTags.map((tag) => (
                      <button
                        key={tag}
                        onClick={() => setActiveTag(tag === activeTag ? "ALL" : tag)}
                        className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition ${
                          activeTag === tag
                            ? "bg-indigo-600 text-white border border-indigo-500"
                            : "bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 border border-zinc-800/80"
                        }`}
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </aside>

            {/* Left Resizer Handle */}
            <div
              onMouseDown={() => {
                draggingPaneRef.current = "left";
                document.body.style.cursor = "col-resize";
              }}
              className="w-1.5 bg-zinc-800/50 hover:bg-indigo-500 active:bg-indigo-400 cursor-col-resize transition-colors shrink-0 z-10"
              title="Drag to resize left pane"
            />
          </>
        )}

        {/* CENTER VIRTUALIZED CANVAS */}
        <main className="flex-1 bg-[#090a0f] flex flex-col overflow-hidden relative min-w-[260px]">
          {/* Slide-Out Day-Accurate Click-and-Drag Timeline Drawer */}
          {isTimelineOpen && (
            <div
              onMouseUp={() => setDragAnchorDay(null)}
              onMouseLeave={() => setDragAnchorDay(null)}
              className="bg-[#0b0d14] border-b border-zinc-800/80 px-4 py-3 flex flex-col gap-2.5 shrink-0 z-10 animate-in slide-in-from-top-2 duration-150"
            >
              <div className="flex items-center justify-between text-xs flex-wrap gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="font-semibold text-zinc-200 flex items-center gap-1.5 text-[11px]">
                    <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-400" />
                    Date Range Slicer (Click & Drag across days)
                  </span>

                  {/* Exact Day Inputs (Accurate to the Day!) */}
                  <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-0.5 text-[11px]">
                    <span className="text-zinc-500">From:</span>
                    <input
                      type="date"
                      value={selectedPeriodRange ? selectedPeriodRange[0] : timelineBuckets[0]?.period || ""}
                      onChange={(e) => {
                        const start = e.target.value;
                        if (!start) return;
                        const end = selectedPeriodRange ? selectedPeriodRange[1] : timelineBuckets[timelineBuckets.length - 1]?.period || start;
                        setSelectedPeriodRange([start <= end ? start : end, start <= end ? end : start]);
                      }}
                      className="bg-transparent text-zinc-200 font-mono text-[11px] focus:outline-none"
                    />
                    <span className="text-zinc-600">➔</span>
                    <span className="text-zinc-500">To:</span>
                    <input
                      type="date"
                      value={selectedPeriodRange ? selectedPeriodRange[1] : timelineBuckets[timelineBuckets.length - 1]?.period || ""}
                      onChange={(e) => {
                        const end = e.target.value;
                        if (!end) return;
                        const start = selectedPeriodRange ? selectedPeriodRange[0] : timelineBuckets[0]?.period || end;
                        setSelectedPeriodRange([start <= end ? start : end, start <= end ? end : start]);
                      }}
                      className="bg-transparent text-zinc-200 font-mono text-[11px] focus:outline-none"
                    />
                    {selectedPeriodRange && (
                      <button
                        onClick={() => setSelectedPeriodRange(null)}
                        className="ml-1 text-red-400 hover:text-red-300 font-bold"
                        title="Clear date filter"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                {/* Quick Year & Range Presets */}
                <div className="flex items-center gap-1 text-[10px]">
                  <button
                    onClick={() => setSelectedPeriodRange(null)}
                    className={`px-2 py-0.5 rounded ${
                      !selectedPeriodRange ? "bg-zinc-800 text-zinc-200 font-medium" : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    All Dates
                  </button>
                  {Array.from(new Set(timelineBuckets.map((b) => b.period.slice(0, 4))))
                    .slice(-5)
                    .map((yr) => (
                      <button
                        key={yr}
                        onClick={() => setSelectedPeriodRange([`${yr}-01-01`, `${yr}-12-31`])}
                        className={`px-2 py-0.5 rounded ${
                          selectedPeriodRange &&
                          selectedPeriodRange[0] === `${yr}-01-01` &&
                          selectedPeriodRange[1] === `${yr}-12-31`
                            ? "bg-indigo-600 text-white font-medium"
                            : "text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        {yr}
                      </button>
                    ))}
                  <button
                    onClick={() => setIsTimelineOpen(false)}
                    className="ml-2 px-1.5 py-0.5 text-zinc-500 hover:text-zinc-300"
                    title="Hide Timeline Drawer"
                  >
                    ▲ Hide
                  </button>
                </div>
              </div>

              {/* Interactive Click-and-Drag Daily Histogram + Dual Scrub Handles */}
              {timelineBuckets.length > 0 ? (
                <div className="flex flex-col gap-1.5 select-none">
                  <div className="h-12 w-full flex items-end gap-[2px] bg-zinc-950/90 px-2 pt-2 pb-1 rounded-lg border border-zinc-800/70 overflow-x-auto">
                    {(() => {
                      const maxCount = Math.max(...timelineBuckets.map((b) => b.count), 1);
                      return timelineBuckets.map((b) => {
                        const isSelected =
                          !selectedPeriodRange ||
                          (b.period >= selectedPeriodRange[0] && b.period <= selectedPeriodRange[1]);
                        const heightPercent = Math.max(14, Math.round((b.count / maxCount) * 100));

                        return (
                          <div
                            key={b.period}
                            onMouseDown={() => {
                              setDragAnchorDay(b.period);
                              setSelectedPeriodRange([b.period, b.period]);
                            }}
                            onMouseEnter={() => {
                              if (dragAnchorDay) {
                                const d1 = dragAnchorDay <= b.period ? dragAnchorDay : b.period;
                                const d2 = dragAnchorDay <= b.period ? b.period : dragAnchorDay;
                                setSelectedPeriodRange([d1, d2]);
                              }
                            }}
                            style={{ height: `${heightPercent}%` }}
                            className={`flex-1 min-w-[6px] rounded-t cursor-ew-resize transition-colors ${
                              selectedPeriodRange && isSelected
                                ? "bg-indigo-500 shadow-[0_0_6px_rgba(99,102,241,0.5)]"
                                : isSelected
                                ? "bg-emerald-500/60 hover:bg-indigo-400"
                                : "bg-zinc-800/60 hover:bg-zinc-700"
                            }`}
                            title={`${b.period}: ${b.count} photo${b.count === 1 ? "" : "s"} (Click & drag to select range)`}
                          />
                        );
                      });
                    })()}
                  </div>

                  {/* Dual Index Scrub Sliders for fast coarse-to-fine day scrubbing */}
                  <div className="flex items-center gap-3 px-1 text-[10px] text-zinc-400 font-mono">
                    <span>{timelineBuckets[0]?.period}</span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, timelineBuckets.length - 1)}
                      value={
                        selectedPeriodRange
                          ? Math.max(
                              0,
                              timelineBuckets.findIndex((b) => b.period >= selectedPeriodRange[0])
                            )
                          : 0
                      }
                      onChange={(e) => {
                        const idx = Number(e.target.value);
                        const day = timelineBuckets[idx]?.period;
                        if (!day) return;
                        const curEnd = selectedPeriodRange
                          ? selectedPeriodRange[1]
                          : timelineBuckets[timelineBuckets.length - 1]?.period || day;
                        setSelectedPeriodRange([day <= curEnd ? day : curEnd, day <= curEnd ? curEnd : day]);
                      }}
                      className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                      title="Drag Start Day"
                    />
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, timelineBuckets.length - 1)}
                      value={
                        selectedPeriodRange
                          ? (() => {
                              let lastIdx = timelineBuckets.length - 1;
                              for (let i = timelineBuckets.length - 1; i >= 0; i--) {
                                if (timelineBuckets[i].period <= selectedPeriodRange[1]) {
                                  lastIdx = i;
                                  break;
                                }
                              }
                              return lastIdx;
                            })()
                          : Math.max(0, timelineBuckets.length - 1)
                      }
                      onChange={(e) => {
                        const idx = Number(e.target.value);
                        const day = timelineBuckets[idx]?.period;
                        if (!day) return;
                        const curStart = selectedPeriodRange
                          ? selectedPeriodRange[0]
                          : timelineBuckets[0]?.period || day;
                        setSelectedPeriodRange([curStart <= day ? curStart : day, curStart <= day ? day : curStart]);
                      }}
                      className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                      title="Drag End Day"
                    />
                    <span>{timelineBuckets[timelineBuckets.length - 1]?.period}</span>
                  </div>
                </div>
              ) : (
                <div className="text-[11px] text-zinc-500 py-1">
                  No dates indexed yet — click <strong>Rescan</strong> in the top bar to extract dates from your files.
                </div>
              )}
            </div>
          )}

          {/* Middle Toolbar */}
          <div className="bg-[#0c0d14] border-b border-zinc-800/60 px-4 py-2 flex items-center justify-between text-xs gap-3 flex-wrap">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-zinc-400">
                Showing <strong className="text-zinc-200">{visiblePhotos.length}</strong> items
              </span>

              {/* Slide-Out Timeline Drawer Toggle Button */}
              <button
                onClick={() => setIsTimelineOpen((p) => !p)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                  isTimelineOpen || selectedPeriodRange
                    ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40 shadow-sm"
                    : "bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-800"
                }`}
                title="Slide out interactive day-by-day Date Timeline Slicer"
              >
                <Calendar className="w-3.5 h-3.5 text-indigo-400" />
                <span>
                  {selectedPeriodRange
                    ? `${selectedPeriodRange[0]} ➔ ${selectedPeriodRange[1]}`
                    : "Timeline"}
                </span>
                <ChevronDown className={`w-3 h-3 transition-transform ${isTimelineOpen ? "rotate-180" : ""}`} />
              </button>

              {/* Auto-Advance Toggle Pill */}
              <label className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={(e) => setAutoAdvance(e.target.checked)}
                  className="rounded bg-zinc-800 border-zinc-700 text-indigo-500 focus:ring-0 cursor-pointer"
                />
                <span>Auto-Advance</span>
              </label>

              {totalBurstGroups > 0 && (
                <button
                  onClick={() => setShowAllBurstVersions((prev) => !prev)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                    showAllBurstVersions
                      ? "bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm"
                      : "bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border-zinc-800"
                  }`}
                  title="Expand or collapse all burst / duplicate stacks"
                >
                  <Layers className="w-3.5 h-3.5 text-amber-400" />
                  <span>{showAllBurstVersions ? "Collapse Bursts" : "Show All Bursts"}</span>
                </button>
              )}

              {activeSubfolder !== "ALL" && (
                <span className="bg-zinc-800 border border-zinc-700 text-zinc-200 px-2.5 py-0.5 rounded-full flex items-center gap-1 text-[11px]">
                  📂 {activeSubfolder}
                  <button onClick={() => setActiveSubfolder("ALL")} className="hover:text-white ml-1">✕</button>
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              {/* Orientation Filter */}
              <div className="flex bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 text-[11px]">
                {(["ALL", "LANDSCAPE", "PORTRAIT", "SQUARE"] as OrientationFilter[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setOrientationFilter(mode)}
                    className={`px-2 py-0.5 rounded ${orientationFilter === mode ? "bg-zinc-800 text-zinc-100 font-medium" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    {mode === "ALL" ? "All" : mode === "LANDSCAPE" ? "Wide" : mode === "PORTRAIT" ? "Tall" : "Square"}
                  </button>
                ))}
              </div>

              {/* Abstract Thumbnail Zoom Slider */}
              {viewMode === "grid" && (
                <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1">
                  <button onClick={() => setZoomLevel((z) => Math.max(0, z - 0.15))} className="text-zinc-500 hover:text-zinc-300">
                    <Grid className="w-3.5 h-3.5" />
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.02}
                    value={zoomLevel}
                    onChange={(e) => setZoomLevel(parseFloat(e.target.value))}
                    className="w-20 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  />
                  <button onClick={() => setZoomLevel((z) => Math.min(1, z + 0.15))} className="text-zinc-500 hover:text-zinc-300">
                    <Square className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Sort Selector */}
              <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1">
                <ArrowUpDown className="w-3.5 h-3.5 text-zinc-400" />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  className="bg-transparent text-zinc-200 font-medium text-xs focus:outline-none cursor-pointer"
                >
                  <option value="NAME_ASC" className="bg-zinc-900">Alphabetical (A → Z)</option>
                  <option value="NAME_DESC" className="bg-zinc-900">Alphabetical (Z → A)</option>
                  <option value="DATE_DESC" className="bg-zinc-900">Date Captured (Newest)</option>
                  <option value="DATE_ASC" className="bg-zinc-900">Date Captured (Oldest)</option>
                  <option value="SCORE_DESC" className="bg-zinc-900">Focus Score (Sharpest)</option>
                  <option value="SCORE_ASC" className="bg-zinc-900">Focus Score (Blurriest)</option>
                  <option value="RATING_DESC" className="bg-zinc-900">Star Rating (High → Low)</option>
                  <option value="TAG_NAME" className="bg-zinc-900">Primary Tag Name (A → Z)</option>
                  <option value="SIZE_DESC" className="bg-zinc-900">File Size (Largest)</option>
                </select>
              </div>

              <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                <select
                  value={autoStagePreset}
                  onChange={(e) => setAutoStagePreset(e.target.value as AutoStagePreset)}
                  className="bg-transparent text-zinc-300 text-[11px] px-2 py-1 focus:outline-none cursor-pointer border-r border-zinc-800"
                  title="Choose folder structure rule preset"
                >
                  <option value="YEAR_MONTH_CITY" className="bg-zinc-900">Rule: &#123;Year&#125;/&#123;YYYY-MM&#125;_&#123;City&#125;</option>
                  <option value="YEAR_MONTH" className="bg-zinc-900">Rule: &#123;Year&#125;/&#123;YYYY-MM&#125;</option>
                  <option value="PERSON_YEAR" className="bg-zinc-900">Rule: People/&#123;Person&#125;/&#123;Year&#125;</option>
                  <option value="SCREENSHOTS_BY_MONTH" className="bg-zinc-900">Rule: _Screenshots/&#123;YYYY-MM&#125;</option>
                  <option value="FAVORITES_YEAR" className="bg-zinc-900">Rule: Favorites/&#123;Year&#125;</option>
                </select>
                <button
                  onClick={handleAutoOrganizeByPreset}
                  className="flex items-center gap-1.5 text-zinc-200 hover:text-white bg-zinc-800/80 hover:bg-indigo-600 px-2.5 py-1 transition font-medium text-xs"
                  title="Stage visible photos using selected folder rule"
                >
                  <FolderSync className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Auto-Stage</span>
                </button>
              </div>
            </div>
          </div>

          {(smartFilter === "DUPLICATES" || showAllBurstVersions) && duplicatePhotosCount > 0 && (
            <div className="bg-amber-950/30 border-b border-amber-500/30 px-5 py-2 flex items-center justify-between">
              <span className="text-xs text-amber-200">
                Comparing <strong>{totalBurstGroups}</strong> Burst Groups ({duplicatePhotosCount} items):
              </span>
              <button
                onClick={handleKeepSharpestInAllGroups}
                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow transition"
              >
                Keep Sharpest & Stage Rest for _Trash
              </button>
            </div>
          )}

          {viewMode === "map" ? (
            <div className="flex-1 flex flex-col overflow-hidden relative">
              <div className="bg-zinc-900/95 border-b border-zinc-800 px-4 py-2 flex items-center justify-between text-xs z-10">
                <div className="flex items-center gap-2">
                  <Compass className="w-4 h-4 text-emerald-400" />
                  <span className="text-zinc-300">
                    {isPickingMapLocation
                      ? `🎯 Click anywhere on the map to assign GPS coordinates to ${selectedHashes.size} selected photo(s)...`
                      : `Showing ${gpsPhotosCount} geotagged photos on map.`}
                  </span>
                </div>
                <button
                  onClick={() => setIsPickingMapLocation((p) => !p)}
                  disabled={selectedHashes.size === 0}
                  className={`px-3 py-1 rounded-lg font-semibold transition flex items-center gap-1.5 ${
                    isPickingMapLocation
                      ? "bg-emerald-600 text-white shadow"
                      : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
                  }`}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>{isPickingMapLocation ? "Cancel Map Pick" : `Click Map to Set GPS (${selectedHashes.size})`}</span>
                </button>
              </div>
              <PhotoMap
                photos={visiblePhotos}
                onSelectPhoto={(h) => setActiveHash(h)}
                isPickingLocation={isPickingMapLocation}
                onMapPickCoordinates={handleMapPickCoordinates}
              />
            </div>
          ) : viewMode === "compare" ? (
            <div className="flex-1 flex flex-col overflow-hidden bg-[#07080c]">
              {/* Synchronized Compare Toolbar */}
              <div className="bg-[#0c0d14] border-b border-zinc-800 px-4 py-2 flex items-center justify-between text-xs">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-indigo-300 flex items-center gap-1.5">
                    <Columns className="w-4 h-4" />
                    Synchronized Compare ({comparePhotos.length} photos)
                  </span>
                  <span className="text-zinc-500">
                    Scroll wheel or click +/- to zoom all • Drag any image to pan all simultaneously
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCompareZoom((z) => Math.max(1, +(z - 0.5).toFixed(1)))}
                    className="p-1.5 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 text-zinc-300"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <span className="font-mono text-zinc-300 w-12 text-center">{Math.round(compareZoom * 100)}%</span>
                  <button
                    onClick={() => setCompareZoom((z) => Math.min(6, +(z + 0.5).toFixed(1)))}
                    className="p-1.5 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 text-zinc-300"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      setCompareZoom(1);
                      setComparePan({ x: 0, y: 0 });
                    }}
                    className="px-2.5 py-1 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 text-zinc-400 hover:text-white"
                  >
                    Reset 100%
                  </button>
                  <button
                    onClick={() => setViewMode("grid")}
                    className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded font-medium ml-2"
                  >
                    Exit Compare (C)
                  </button>
                </div>
              </div>

              {/* Multi-Pane Synchronized Canvas */}
              <div
                onWheel={(e) => {
                  e.preventDefault();
                  const delta = e.deltaY < 0 ? 0.35 : -0.35;
                  setCompareZoom((z) => {
                    const next = Math.max(1, Math.min(6, +(z + delta).toFixed(2)));
                    if (next === 1) setComparePan({ x: 0, y: 0 });
                    return next;
                  });
                }}
                onMouseDown={(e) => {
                  if (compareZoom <= 1) return;
                  isPanningCompareRef.current = true;
                  panStartRef.current = { x: e.clientX - comparePan.x, y: e.clientY - comparePan.y };
                }}
                onMouseMove={(e) => {
                  if (!isPanningCompareRef.current) return;
                  setComparePan({
                    x: e.clientX - panStartRef.current.x,
                    y: e.clientY - panStartRef.current.y,
                  });
                }}
                onMouseUp={() => {
                  isPanningCompareRef.current = false;
                }}
                onMouseLeave={() => {
                  isPanningCompareRef.current = false;
                }}
                style={{
                  gridTemplateColumns: `repeat(${Math.max(1, comparePhotos.length)}, minmax(0, 1fr))`,
                }}
                className="flex-1 grid gap-2 p-3 overflow-hidden select-none cursor-grab active:cursor-grabbing"
              >
                {comparePhotos.map((cp) => {
                  const isActive = cp.hash === activeHash;
                  return (
                    <div
                      key={cp.hash}
                      onClick={() => setActiveHash(cp.hash)}
                      className={`relative flex flex-col rounded-xl overflow-hidden bg-zinc-950 border transition ${
                        isActive ? "border-indigo-500 ring-1 ring-indigo-500" : "border-zinc-800"
                      }`}
                    >
                      <div className="flex-1 relative overflow-hidden flex items-center justify-center">
                        <img
                          src={convertFileSrc(cp.path)}
                          alt={cp.name}
                          draggable={false}
                          style={{
                            transform: `translate(${comparePan.x}px, ${comparePan.y}px) scale(${compareZoom}) rotate(${cp.rotation}deg)`,
                            transformOrigin: "center center",
                          }}
                          className="max-w-full max-h-full object-contain pointer-events-none transition-transform duration-75"
                        />
                      </div>

                      {/* Compare Card Bottom Bar */}
                      <div className="p-2.5 bg-[#10121a] border-t border-zinc-800 flex items-center justify-between text-xs z-10">
                        <div className="truncate">
                          <div className="font-semibold text-zinc-200 truncate">{cp.name}</div>
                          <div className="text-[11px] font-mono text-emerald-400">
                            Focus Score: {cp.sharpness} {cp.rating > 0 ? `• ${"★".repeat(cp.rating)}` : ""}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              await invoke("set_photo_flag", { hashes: [cp.hash], flag: "pick" });
                              const others = comparePhotos.filter((o) => o.hash !== cp.hash);
                              for (const o of others) {
                                await invoke("stage_photo_move", { hash: o.hash, targetSubfolder: "_Trash" });
                                await invoke("set_photo_flag", { hashes: [o.hash], flag: "reject" });
                              }
                              const otherSet = new Set(others.map((o) => o.hash));
                              setPhotos((prev) =>
                                prev.map((p) => {
                                  if (p.hash === cp.hash) return { ...p, flag: "pick" };
                                  if (otherSet.has(p.hash)) return { ...p, flag: "reject", staged_target: "_Trash" };
                                  return p;
                                })
                              );
                              setViewMode("grid");
                            }}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-semibold shadow transition"
                            title="Keep this photo as Pick and stage the other compared photos for _Trash"
                          >
                            🏆 Keep This & Trash Rest
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div ref={gridContainerRef} className="flex-1 overflow-y-auto p-4">
              <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const startIndex = virtualRow.index * gridColumns;
                  const rowPhotos = visiblePhotos.slice(startIndex, startIndex + gridColumns);

                  return (
                    <div
                      key={virtualRow.index}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                        gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
                      }}
                      className="grid gap-3.5 pb-3.5"
                    >
                      {rowPhotos.map((photo, colIndex) => {
                        const globalIndex = startIndex + colIndex;
                        const isSelected = selectedHashes.has(photo.hash);
                        const isActive = photo.hash === activeHash;
                        const isAnalyzingThis = analyzingHashes.has(photo.hash);
                        const hasAiData = photo.tags.length > 0 || Boolean(photo.ai_caption);

                        const grp = photo.duplicate_group;
                        const burstCount = grp ? burstGroupCounts.get(grp) || 1 : 1;
                        const isBurstExpanded = grp ? showAllBurstVersions || expandedBurstGroups.has(grp) : false;
                        const isSharpestPick = grp && sharpestInGroup.get(grp)?.hash === photo.hash;

                        return (
                          <div
                            key={photo.hash}
                            onClick={(e) => handlePhotoClick(globalIndex, photo.hash, e)}
                            onDoubleClick={() => {
                              setActiveHash(photo.hash);
                              setIsLoupeOpen(true);
                            }}
                            className={`group relative flex flex-col rounded-xl overflow-hidden bg-[#10121a] border transition duration-150 cursor-pointer ${
                              isAnalyzingThis
                                ? "border-purple-500 ring-2 ring-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.35)]"
                                : isActive
                                ? "border-indigo-500 shadow-[0_0_12px_rgba(99,102,241,0.25)] ring-1 ring-indigo-500"
                                : isSelected
                                ? "border-zinc-400 bg-zinc-800/30"
                                : isBurstExpanded && grp
                                ? "border-amber-500/60 bg-amber-950/10"
                                : "border-zinc-800/80 hover:border-zinc-600"
                            }`}
                          >
                            {grp && !isBurstExpanded && burstCount > 1 && (
                              <div className="absolute inset-x-2 -top-1 h-2 bg-amber-500/20 border-t border-amber-400/40 rounded-t-xl pointer-events-none z-20" />
                            )}

                            {/* Color Label Corner Ribbon */}
                            {photo.color_label && (
                              <div
                                className={`absolute top-0 right-0 w-3.5 h-3.5 z-20 ${
                                  photo.color_label === "red"
                                    ? "bg-red-500"
                                    : photo.color_label === "yellow"
                                    ? "bg-yellow-400"
                                    : photo.color_label === "green"
                                    ? "bg-emerald-500"
                                    : "bg-blue-500"
                                } [clip-path:polygon(100%_0,0_0,100%_100%)]`}
                              />
                            )}

                            <div style={{ height: `${cardThumbHeight}px` }} className="relative w-full bg-zinc-950 flex items-center justify-center overflow-hidden">
                              {photo.thumb_ready ? (
                                <img
                                  src={convertFileSrc(photo.thumb_path)}
                                  alt={photo.name}
                                  loading="lazy"
                                  style={{ transform: `rotate(${photo.rotation}deg)` }}
                                  className="w-full h-full object-cover group-hover:scale-[1.02] transition duration-200"
                                />
                              ) : (
                                <span className="text-xs text-zinc-600 animate-pulse">Loading...</span>
                              )}

                              {isAnalyzingThis && (
                                <div className="absolute inset-0 bg-purple-950/60 backdrop-blur-[2px] flex flex-col items-center justify-center gap-1.5 z-10">
                                  <Loader2 className="w-6 h-6 text-purple-300 animate-spin" />
                                  <span className="text-[10px] font-bold text-purple-200 tracking-wide uppercase">AI Tagging...</span>
                                </div>
                              )}

                              {/* Top-Left Badges: Pick/Reject Flag, Staged or Burst */}
                              <div className="absolute top-2 left-2 flex items-center gap-1 z-20">
                                {photo.in_basket && (
                                  <span className="p-1 rounded bg-indigo-950/90 border border-indigo-400/60 text-indigo-300 text-[10px] backdrop-blur shadow" title="Pinned to Basket (B)">
                                    📌
                                  </span>
                                )}
                                {photo.flag === "pick" && (
                                  <span className="p-1 rounded bg-emerald-950/90 border border-emerald-400/60 text-emerald-400 text-[10px] backdrop-blur shadow">
                                    🚩
                                  </span>
                                )}
                                {photo.flag === "reject" && (
                                  <span className="p-1 rounded bg-red-950/90 border border-red-500/60 text-red-400 text-[10px] backdrop-blur shadow">
                                    ❌
                                  </span>
                                )}

                                {photo.staged_target && (
                                  <div className="px-1.5 py-0.5 rounded bg-emerald-950/90 border border-emerald-500/40 text-emerald-300 text-[9px] font-mono flex items-center gap-1 backdrop-blur-md">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                    <span>Staged</span>
                                  </div>
                                )}

                                {grp && burstCount > 1 && (
                                  <button
                                    onClick={(e) => toggleBurstGroupExpand(grp, e)}
                                    className={`px-2 py-0.5 rounded-md backdrop-blur-md text-[10px] font-semibold border flex items-center gap-1 transition shadow ${
                                      isBurstExpanded
                                        ? isSharpestPick
                                          ? "bg-emerald-950/90 text-emerald-300 border-emerald-400/50 hover:bg-emerald-900"
                                          : "bg-amber-950/90 text-amber-300 border-amber-500/50 hover:bg-amber-900"
                                        : "bg-amber-500/90 text-zinc-950 border-amber-300 hover:bg-amber-400"
                                    }`}
                                  >
                                    <Layers className="w-3 h-3" />
                                    {isBurstExpanded ? (
                                      <span>{isSharpestPick ? `🏆 Best (#${grp}) ▾` : `Burst #${grp} ▾`}</span>
                                    ) : (
                                      <span>{burstCount} Burst ▸</span>
                                    )}
                                  </button>
                                )}
                              </div>

                              {/* Star Badge */}
                              {photo.rating > 0 && (
                                <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/70 backdrop-blur-md text-amber-400 text-[10px] font-bold">
                                  {"★".repeat(photo.rating)}
                                </div>
                              )}

                              {/* Persistent AI & Tag Pills */}
                              {hasAiData && !isAnalyzingThis && (
                                <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-1 pointer-events-none">
                                  <div className="flex items-center gap-1 overflow-hidden">
                                    <span className="px-1.5 py-0.5 rounded bg-purple-950/90 border border-purple-500/40 text-purple-200 text-[9px] font-semibold flex items-center gap-1 shrink-0 backdrop-blur-md">
                                      ✨ {photo.tags.length}
                                    </span>
                                    {photo.tags.slice(0, 2).map((t) => (
                                      <span key={t} className="px-1.5 py-0.5 rounded bg-black/75 text-zinc-200 text-[9px] truncate backdrop-blur-md">
                                        #{t}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>

                            <div className="px-2.5 py-1.5 bg-[#10121a] flex items-center justify-between text-[10px] border-t border-zinc-800/50">
                              <span className="truncate font-medium text-zinc-300" title={photo.name}>{photo.name}</span>
                              <span className="font-mono text-zinc-500 shrink-0 ml-1">
                                {photo.location ? `📍 ${photo.location.split(",")[0]}` : photo.sharpness > 0 ? `${photo.sharpness} 🎯` : ""}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Expanded Multi-Action Floating Bulk Dock */}
          {selectedHashes.size > 1 && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-50 animate-in fade-in slide-in-from-bottom-2">
              {/* Dynamic Inline Bulk Popover */}
              {activeBulkPopover && (
                <div className="bg-[#10121a] border border-zinc-700 p-3 rounded-xl shadow-2xl flex flex-col gap-2 w-80 text-xs">
                  <div className="flex justify-between items-center text-zinc-300 font-semibold">
                    <span>
                      {activeBulkPopover === "tag" && "Add Tag to Selection"}
                      {activeBulkPopover === "move" && "Stage Move Selection"}
                      {activeBulkPopover === "location" && "Set Manual Location (City/GPS)"}
                      {activeBulkPopover === "time" && "Shift Capture Timestamps (± Hours / Min)"}
                    </span>
                    <button onClick={() => setActiveBulkPopover(null)} className="text-zinc-500 hover:text-white">✕</button>
                  </div>

                  {activeBulkPopover === "tag" && (
                    <form onSubmit={(e) => { e.preventDefault(); handleBatchAddTag(bulkInput); }} className="flex gap-1.5">
                      <input
                        type="text"
                        value={bulkInput}
                        onChange={(e) => setBulkInput(e.target.value)}
                        placeholder="e.g. vacation, portrait..."
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                        autoFocus
                      />
                      <button type="submit" className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-medium">Add</button>
                    </form>
                  )}

                  {activeBulkPopover === "move" && (
                    <form onSubmit={(e) => { e.preventDefault(); handleBatchStageMove(bulkInput); }} className="flex gap-1.5">
                      <input
                        type="text"
                        value={bulkInput}
                        onChange={(e) => setBulkInput(e.target.value)}
                        placeholder="e.g. 2026/Holiday"
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                        autoFocus
                      />
                      <button type="submit" className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium">Stage</button>
                    </form>
                  )}

                  {activeBulkPopover === "location" && (
                    <div className="flex flex-col gap-1.5">
                      <input
                        type="text"
                        value={bulkInput}
                        onChange={(e) => handleSearchCities(e.target.value)}
                        placeholder="Search city (e.g. Meise, Paris, Brussels)..."
                        className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                        autoFocus
                      />
                      {citySearchResults.length > 0 && (
                        <div className="max-h-36 overflow-y-auto flex flex-col gap-1 mt-1">
                          {citySearchResults.map((c) => (
                            <button
                              key={`${c.name}_${c.country}`}
                              onClick={() => handleAssignCity(c)}
                              className="text-left px-2 py-1 bg-zinc-900 hover:bg-zinc-800 rounded flex justify-between text-zinc-300"
                            >
                              <span>{c.name}, {c.country}</span>
                              <span className="text-[10px] text-zinc-500 font-mono">{c.latitude.toFixed(2)}, {c.longitude.toFixed(2)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        onClick={() => {
                          setActiveBulkPopover(null);
                          setIsPickingMapLocation(true);
                          setViewMode("map");
                        }}
                        className="mt-1 px-2.5 py-1.5 bg-emerald-950/60 hover:bg-emerald-900/70 border border-emerald-500/40 text-emerald-300 rounded-lg text-center font-medium transition"
                      >
                        🎯 Or Click Directly on Map to Set GPS
                      </button>
                    </div>
                  )}

                  {activeBulkPopover === "time" && (
                    <form onSubmit={handleShiftTimestamps} className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 flex flex-col gap-0.5">
                          <span className="text-[10px] text-zinc-500">Hours (±)</span>
                          <input
                            type="number"
                            value={shiftHoursInput}
                            onChange={(e) => setShiftHoursInput(parseInt(e.target.value || "0", 10))}
                            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200"
                          />
                        </div>
                        <div className="flex-1 flex flex-col gap-0.5">
                          <span className="text-[10px] text-zinc-500">Minutes (±)</span>
                          <input
                            type="number"
                            value={shiftMinutesInput}
                            onChange={(e) => setShiftMinutesInput(parseInt(e.target.value || "0", 10))}
                            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200"
                          />
                        </div>
                      </div>
                      <button type="submit" className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-semibold">
                        Apply Time Shift
                      </button>
                    </form>
                  )}
                </div>
              )}

              {/* Main Dock */}
              <div className="bg-[#12141c]/95 border border-zinc-700/60 shadow-2xl backdrop-blur-xl px-5 py-2 rounded-2xl flex items-center gap-3 text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-zinc-200 border-r border-zinc-700 pr-3">
                  <CheckSquare className="w-4 h-4 text-emerald-400" />
                  <span>{selectedHashes.size} Selected</span>
                </div>

                {/* Pick / Reject / Unflag */}
                <div className="flex items-center gap-1 border-r border-zinc-700 pr-2.5">
                  <button onClick={() => handleSetFlag("pick")} className="px-1.5 py-1 hover:bg-emerald-950/60 text-emerald-400 rounded" title="Pick (P)">
                    🚩 Pick
                  </button>
                  <button onClick={() => handleSetFlag("reject")} className="px-1.5 py-1 hover:bg-red-950/60 text-red-400 rounded" title="Reject (X)">
                    ❌ Reject
                  </button>
                  <button onClick={() => handleSetFlag(null)} className="px-1.5 py-1 text-zinc-500 hover:text-zinc-300" title="Unflag (U)">
                    Unflag
                  </button>
                </div>

                {/* Color Labels */}
                <div className="flex items-center gap-1 border-r border-zinc-700 pr-2.5">
                  <button onClick={() => handleSetColorLabel("red")} className="w-3.5 h-3.5 rounded-full bg-red-500 hover:scale-110 transition" title="Red (6)" />
                  <button onClick={() => handleSetColorLabel("yellow")} className="w-3.5 h-3.5 rounded-full bg-yellow-400 hover:scale-110 transition" title="Yellow (7)" />
                  <button onClick={() => handleSetColorLabel("green")} className="w-3.5 h-3.5 rounded-full bg-emerald-500 hover:scale-110 transition" title="Green (8)" />
                  <button onClick={() => handleSetColorLabel("blue")} className="w-3.5 h-3.5 rounded-full bg-blue-500 hover:scale-110 transition" title="Blue (9)" />
                  <button onClick={() => handleSetColorLabel(null)} className="text-[10px] text-zinc-500 hover:text-zinc-300 ml-1">Clear</button>
                </div>

                {/* Non-Destructive Rotation */}
                <div className="flex items-center gap-1 border-r border-zinc-700 pr-2.5">
                  <button onClick={() => handleRotateSelection(-90)} className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white" title="Rotate Left ([)">
                    <RotateLeft className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleRotateSelection(90)} className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white" title="Rotate Right (])">
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Popover Action Buttons */}
                <button
                  onClick={() => { setActiveBulkPopover(activeBulkPopover === "tag" ? null : "tag"); setBulkInput(""); }}
                  className="flex items-center gap-1 text-zinc-300 hover:text-white"
                >
                  <TagIcon className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Tag</span>
                </button>

                <button
                  onClick={() => { setActiveBulkPopover(activeBulkPopover === "move" ? null : "move"); setBulkInput(""); }}
                  className="flex items-center gap-1 text-zinc-300 hover:text-white"
                >
                  <Folder className="w-3.5 h-3.5 text-amber-400" />
                  <span>Move</span>
                </button>

                <button
                  onClick={() => { setActiveBulkPopover(activeBulkPopover === "location" ? null : "location"); setBulkInput(""); }}
                  className="flex items-center gap-1 text-zinc-300 hover:text-white"
                >
                  <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Location</span>
                </button>

                <button
                  onClick={() => { setActiveBulkPopover(activeBulkPopover === "time" ? null : "time"); }}
                  className="flex items-center gap-1 text-zinc-300 hover:text-white"
                  title="Shift capture timestamps (± Hours/Min)"
                >
                  <Clock className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Time</span>
                </button>

                <button
                  onClick={handleToggleBasketSelection}
                  className="flex items-center gap-1 text-zinc-300 hover:text-white"
                  title="Toggle Pinboard Basket (B)"
                >
                  <Pin className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Pin</span>
                </button>

                <button
                  onClick={() => {
                    setCompareZoom(1);
                    setComparePan({ x: 0, y: 0 });
                    setViewMode("compare");
                  }}
                  className="flex items-center gap-1 text-zinc-300 hover:text-white"
                  title="Compare selected photos side-by-side (C)"
                >
                  <Columns className="w-3.5 h-3.5 text-amber-400" />
                  <span>Compare</span>
                </button>

                <button onClick={handleForceRescanExifSelected} className="flex items-center gap-1 text-zinc-300 hover:text-white" title="Force refresh EXIF headers on selected photos">
                  <RefreshCw className="w-3.5 h-3.5 text-zinc-400" />
                  <span>EXIF</span>
                </button>

                <button
                  onClick={() => {
                    const targets = visiblePhotos.filter((p) => selectedHashes.has(p.hash));
                    runBatchAiOnList(targets);
                  }}
                  className="flex items-center gap-1 text-purple-400 hover:text-purple-300 font-medium"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>AI</span>
                </button>

                <button onClick={() => handleBatchStageMove("_Trash")} className="flex items-center gap-1 text-red-400 hover:text-red-300 font-medium border-l border-zinc-700 pl-3">
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Trash</span>
                </button>

                <button onClick={() => setSelectedHashes(new Set())} className="text-zinc-500 hover:text-zinc-300 ml-1">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </main>

        {/* RIGHT INSPECTOR PANE */}
        {!isRightCollapsed && activePhoto && (
          <>
            <div
              onMouseDown={() => {
                draggingPaneRef.current = "right";
                document.body.style.cursor = "col-resize";
              }}
              className="w-1.5 bg-zinc-800/50 hover:bg-indigo-500 active:bg-indigo-400 cursor-col-resize transition-colors shrink-0 z-10"
              title="Drag to resize right inspector freely"
            />

            <aside style={{ width: `${rightWidth}px` }} className="bg-[#0c0d14] flex flex-col p-4 gap-4 overflow-y-auto shrink-0">
              {/* Proportional Preview with Aspect-Ratio Lock & Face Canvas */}
              <div className="flex flex-col gap-2 shrink-0">
                <div className="relative w-full bg-zinc-950 rounded-xl overflow-hidden border border-zinc-800 flex items-center justify-center p-1">
                  <div
                    ref={previewImgWrapRef}
                    onMouseDown={handlePreviewMouseDown}
                    onMouseMove={handlePreviewMouseMove}
                    onMouseUp={handlePreviewMouseUp}
                    className={`relative inline-block max-w-full ${isDrawingFace ? "cursor-crosshair ring-2 ring-indigo-500 rounded" : ""}`}
                  >
                    <img
                      src={convertFileSrc(activePhoto.path)}
                      alt={activePhoto.name}
                      draggable={false}
                      style={{ transform: `rotate(${activePhoto.rotation}deg)` }}
                      className="block max-w-full w-auto h-auto max-h-[52vh] object-contain rounded select-none pointer-events-none transition-transform duration-150"
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
                              face.person_name ? "bg-emerald-600 text-white" : "bg-amber-500 text-zinc-950"
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
                      isDrawingFace ? "bg-indigo-600 text-white" : "bg-black/70 hover:bg-zinc-800 text-zinc-200 border border-white/10"
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
                      className="px-2 py-0.5 rounded bg-emerald-950/70 hover:bg-emerald-900 text-emerald-300 border border-emerald-500/40 text-[10px] font-semibold transition flex items-center gap-1"
                      title="Run Pure-Rust ONNX Neural Face Detector on this photo"
                    >
                      {isDetectingSingleFace ? <Loader2 className="w-3 h-3 animate-spin" /> : <ScanFace className="w-3 h-3" />}
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
                            <img src={convertFileSrc(f.face_thumb)} alt="face" className="w-6 h-6 rounded-full object-cover" />
                            <span className="text-[11px] font-medium">{f.person_name || `Face #${idx + 1}`}</span>
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                const rem = await invoke<FaceInstance[]>("remove_face_box", {
                                  faceId: f.face_id,
                                  hash: activePhoto.hash,
                                });
                                setPhotos((prev) =>
                                  prev.map((p) => (p.hash === activePhoto.hash ? { ...p, faces: rem } : p))
                                );
                              }}
                              className="text-zinc-500 hover:text-red-400 ml-0.5 text-xs"
                            >
                              ×
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
                      placeholder={selectedFaceId || drawnBox ? "Enter name to auto-match..." : "Click face or 'Draw Face Box'..."}
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                    />
                    <button type="submit" className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shrink-0">
                      Save & Match
                    </button>
                  </form>
                </div>
              </div>

              {/* Triage Action Bar inside Inspector */}
              <div className="flex items-center justify-between p-2.5 bg-zinc-900/90 rounded-xl border border-zinc-800">
                {/* Pick / Reject */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleSetFlag(activePhoto.flag === "pick" ? null : "pick")}
                    className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 transition ${
                      activePhoto.flag === "pick" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-emerald-300"
                    }`}
                  >
                    🚩 Pick
                  </button>
                  <button
                    onClick={() => handleSetFlag(activePhoto.flag === "reject" ? null : "reject")}
                    className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 transition ${
                      activePhoto.flag === "reject" ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-red-300"
                    }`}
                  >
                    ❌ Reject
                  </button>
                </div>

                {/* Rotate Buttons */}
                <div className="flex items-center gap-1">
                  <button onClick={() => handleRotateSelection(-90)} className="p-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white" title="Rotate Left ([)">
                    <RotateLeft className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleRotateSelection(90)} className="p-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white" title="Rotate Right (])">
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Color Labels */}
                <div className="flex items-center gap-1.5">
                  {(["red", "yellow", "green", "blue"] as const).map((color) => (
                    <button
                      key={color}
                      onClick={() => handleSetColorLabel(activePhoto.color_label === color ? null : color)}
                      className={`w-3.5 h-3.5 rounded-full transition ${
                        color === "red"
                          ? "bg-red-500"
                          : color === "yellow"
                          ? "bg-yellow-400"
                          : color === "green"
                          ? "bg-emerald-500"
                          : "bg-blue-500"
                      } ${activePhoto.color_label === color ? "ring-2 ring-white scale-110" : "opacity-60 hover:opacity-100"}`}
                    />
                  ))}
                </div>
              </div>

              {/* Details & AI Tab */}
              <div className="flex flex-col gap-3.5">
                <div className="flex justify-between items-start gap-2">
                  <div className="truncate">
                    <h3 className="text-sm font-semibold text-zinc-200 truncate" title={activePhoto.name}>
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
                      <span className="font-mono text-emerald-400">Score: {activePhoto.sharpness}</span>
                    </div>
                  </div>
                  <button
                    onClick={handleAiAnalyzeSingle}
                    disabled={analyzingHashes.has(activePhoto.hash)}
                    className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 text-white rounded-lg text-xs font-medium shrink-0"
                  >
                    {analyzingHashes.has(activePhoto.hash) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    <span>{analyzingHashes.has(activePhoto.hash) ? "Tagging..." : "AI (A)"}</span>
                  </button>
                </div>

                {/* Metadata & Interactive GPS / City Search */}
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  <span className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-400">
                    📂 {activePhoto.subfolder}
                  </span>
                  {activePhoto.location ? (
                    <div className="inline-flex items-center rounded-md bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 overflow-hidden">
                      <button
                        onClick={() => setViewMode("map")}
                        className="px-2 py-0.5 hover:bg-emerald-900/60 transition"
                        title="View on Map"
                      >
                        📍 {activePhoto.location}
                      </button>
                      <button
                        onClick={() => {
                          setIsEditingInspectorLocation((p) => !p);
                          setInspectorLocationQuery(activePhoto.location);
                        }}
                        className="px-1.5 py-0.5 border-l border-emerald-500/30 hover:bg-emerald-800/60 text-[10px]"
                        title="Change or edit location"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => handleAssignCustomLocationText("")}
                        className="px-1.5 py-0.5 border-l border-emerald-500/30 hover:bg-red-900/60 hover:text-red-200 text-[10px]"
                        title="Clear location"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setIsEditingInspectorLocation((p) => !p);
                        setInspectorLocationQuery("");
                        setCitySearchResults([]);
                      }}
                      className="px-2 py-0.5 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-dashed border-zinc-700 text-zinc-300 hover:text-white transition"
                    >
                      📍 + Add Location
                    </button>
                  )}
                  {activePhoto.captured_at && (
                    <span className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300">
                      📅 {activePhoto.captured_at.split(" ")[0].replace(/:/g, "-")}
                    </span>
                  )}
                  {activePhoto.camera_model && (
                    <span className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300">
                      📷 {activePhoto.camera_model}
                    </span>
                  )}
                  <button
                    onClick={handleForceRescanExifSelected}
                    className="px-2 py-0.5 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white transition"
                    title="Force refresh EXIF & OS file dates"
                  >
                    <RefreshCw className="w-3 h-3 inline mr-1" /> EXIF
                  </button>
                </div>

                {isEditingInspectorLocation && (
                  <div className="p-2.5 bg-zinc-900/95 border border-indigo-500/40 rounded-xl flex flex-col gap-2 text-xs">
                    <div className="flex justify-between items-center text-[11px] font-semibold text-zinc-300">
                      <span>📍 Set Photo Location</span>
                      <button onClick={() => setIsEditingInspectorLocation(false)} className="text-zinc-500 hover:text-white">✕</button>
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
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                        autoFocus
                      />
                      <button
                        type="submit"
                        className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium shrink-0"
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
                            <span>📍 {c.name}, {c.country}</span>
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
                      className="px-2.5 py-1 bg-emerald-950/60 hover:bg-emerald-900/70 border border-emerald-500/40 text-emerald-300 rounded-lg text-center font-medium transition text-[11px]"
                    >
                      🎯 Or Click Directly on Map to Pin GPS
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
                    {activePhoto.tags.length === 0 && <span className="text-xs text-zinc-500 italic">No tags yet — press A to run AI</span>}
                    {activePhoto.tags.map((t) => (
                      <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 bg-zinc-800 text-zinc-200 rounded-md text-[11px]">
                        #{t}
                        <button
                          onClick={async () => {
                            await invoke("remove_tag", { hash: activePhoto.hash, tag: t });
                            setPhotos((prev) => prev.map((p) => (p.hash === activePhoto.hash ? { ...p, tags: p.tags.filter((x) => x !== t) } : p)));
                          }}
                          className="hover:text-red-400 text-zinc-500 ml-0.5"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <form onSubmit={(e) => { e.preventDefault(); handleBatchAddTag(tagInput); }} className="flex gap-1.5 mt-1">
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder="Add tag..."
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                    />
                    <button type="submit" className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-xs rounded-lg font-medium">Add</button>
                  </form>
                </div>

                {activePhoto.ocr_text && (
                  <div className="p-3 bg-zinc-900/90 border border-zinc-800 rounded-xl flex flex-col gap-1 text-xs">
                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">📄 Detected Text (OCR)</span>
                    <p className="font-mono text-zinc-200 text-[11px] select-text whitespace-pre-wrap">{activePhoto.ocr_text}</p>
                  </div>
                )}
              </div>
            </aside>
          </>
        )}
      </div>

      {/* Review, Commit & Dismiss Modal */}
      {isCommitModalOpen && (
        <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="bg-[#12141c] border border-zinc-800 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="p-5 border-b border-zinc-800 flex justify-between items-center">
              <div>
                <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-emerald-400" />
                  Review Staged Disk Moves
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">The following physical files will be moved on your drive.</p>
              </div>
              <button onClick={() => setIsCommitModalOpen(false)} className="text-zinc-500 hover:text-zinc-300">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-2">
              {stagedPhotos.map((p) => (
                <div key={p.hash} className="flex items-center justify-between p-3 bg-zinc-900/60 rounded-xl text-xs border border-zinc-800/60">
                  <div className="flex items-center gap-3 truncate">
                    <img src={convertFileSrc(p.thumb_path)} alt={p.name} className="w-9 h-9 object-cover rounded-lg shrink-0" />
                    <div className="truncate">
                      <div className="font-medium text-zinc-200 truncate">{p.name}</div>
                      <div className="text-[11px] text-zinc-500">From: 📂 {p.subfolder}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-emerald-400 font-mono font-medium">➔ {p.staged_target}</span>
                    <button
                      onClick={async () => {
                        await invoke("stage_photo_move", { hash: p.hash, targetSubfolder: null });
                        setPhotos((prev) => prev.map((x) => (x.hash === p.hash ? { ...x, staged_target: null } : x)));
                      }}
                      className="text-zinc-500 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="px-5 py-2.5 bg-zinc-900/90 border-t border-zinc-800 flex items-center justify-between text-xs">
              <label className="flex items-center gap-2 text-zinc-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={smartRenameOnCommit}
                  onChange={(e) => setSmartRenameOnCommit(e.target.checked)}
                  className="rounded bg-zinc-800 border-zinc-700 text-emerald-500 focus:ring-0"
                />
                <span>
                  ✨ <strong>Smart Chronological Rename</strong> on Commit (<code className="text-emerald-400">YYYY-MM-DD_HHMMSS_City_001.jpg</code>)
                </span>
              </label>
            </div>
            <div className="p-4 border-t border-zinc-800 flex justify-between items-center bg-zinc-950">
              <span className="text-xs text-zinc-400">Total: <strong>{stagedPhotos.length}</strong> changes</span>
              <div className="flex gap-2.5">
                <button onClick={handleDismissAllStaged} className="px-3.5 py-1.5 bg-red-950/60 hover:bg-red-900/70 text-red-300 border border-red-800/50 rounded-lg text-xs font-medium">
                  Dismiss All
                </button>
                <button onClick={() => setIsCommitModalOpen(false)} className="px-3.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs">
                  Close
                </button>
                <button onClick={handleCommitAllStaged} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow">
                  Commit to Disk
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Storage & Library Health Dashboard + XMP Export Modal */}
      {isHealthModalOpen && (
        <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="bg-[#12141c] border border-zinc-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col">
            <div className="p-5 border-b border-zinc-800 flex justify-between items-center">
              <div>
                <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                  <HardDrive className="w-5 h-5 text-emerald-400" />
                  Library Health, Storage & XMP Portability
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Inspect disk usage, camera distribution, orphaned cache, and Adobe/Lightroom XMP sidecars.
                </p>
              </div>
              <button onClick={() => setIsHealthModalOpen(false)} className="text-zinc-500 hover:text-zinc-300">✕</button>
            </div>

            {healthStats ? (
              <div className="p-5 flex flex-col gap-4 text-xs">
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 bg-zinc-900/80 border border-zinc-800 rounded-xl">
                    <div className="text-zinc-500 text-[10px] uppercase font-bold">Total Library</div>
                    <div className="text-lg font-bold text-zinc-100 mt-0.5">{healthStats.total_photos} photos</div>
                    <div className="text-emerald-400 font-mono text-[11px]">{healthStats.total_library_size_mb} MB</div>
                  </div>
                  <div className="p-3 bg-zinc-900/80 border border-zinc-800 rounded-xl">
                    <div className="text-zinc-500 text-[10px] uppercase font-bold">Burst Duplicates</div>
                    <div className="text-lg font-bold text-amber-300 mt-0.5">{healthStats.duplicate_extras_count} extras</div>
                    <div className="text-amber-400/80 font-mono text-[11px]">~{healthStats.duplicate_recoverable_mb} MB</div>
                  </div>
                  <div className="p-3 bg-zinc-900/80 border border-zinc-800 rounded-xl">
                    <div className="text-zinc-500 text-[10px] uppercase font-bold">Thumb & Face Cache</div>
                    <div className="text-lg font-bold text-zinc-100 mt-0.5">{healthStats.cache_files_count} files</div>
                    <div className="text-zinc-400 font-mono text-[11px]">
                      {healthStats.cache_size_mb} MB ({healthStats.orphaned_cache_count} orphaned)
                    </div>
                  </div>
                </div>

                {/* Camera Model Breakdown */}
                <div className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-xl flex flex-col gap-2">
                  <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Top Cameras / Devices</span>
                  <div className="flex flex-col gap-1.5">
                    {healthStats.camera_breakdown.map(([cam, cnt]) => (
                      <div key={cam} className="flex justify-between items-center text-zinc-300">
                        <span>📷 {cam}</span>
                        <span className="font-mono text-zinc-400">{cnt} photos</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Portability & Cache Maintenance Actions */}
                <div className="flex items-center justify-between gap-3 pt-2">
                  <button
                    onClick={handlePruneCache}
                    className="flex-1 py-2 px-3 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 rounded-xl text-zinc-200 font-medium transition flex items-center justify-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-amber-400" />
                    <span>Prune Orphaned Cache ({healthStats.orphaned_cache_count})</span>
                  </button>

                  <button
                    onClick={() => handleExportXmp(false)}
                    disabled={isExportingXmp}
                    className="flex-1 py-2 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold shadow transition flex items-center justify-center gap-1.5"
                  >
                    <FileCode className="w-3.5 h-3.5" />
                    <span>{isExportingXmp ? "Exporting XMP..." : "Export All XMP Sidecars"}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-zinc-500">Calculating library metrics...</div>
            )}
          </div>
        </div>
      )}

      {/* Interactive Fullscreen Loupe Modal with Complete Triage Action HUD */}
      {isLoupeOpen && activePhoto && (
        <div onClick={() => setIsLoupeOpen(false)} className="fixed inset-0 z-[9999] bg-black/95 backdrop-blur-md flex items-center justify-center p-8 select-none">
          <button
            onClick={(e) => { e.stopPropagation(); navigateByOffset(-1, false); }}
            className="absolute left-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/60 transition shadow-xl"
            title="Previous (Left Arrow)"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>

          <img
            onClick={(e) => e.stopPropagation()}
            src={convertFileSrc(activePhoto.path)}
            alt={activePhoto.name}
            style={{ transform: `rotate(${activePhoto.rotation}deg)` }}
            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl transition-transform duration-150"
          />

          <button
            onClick={(e) => { e.stopPropagation(); navigateByOffset(1, false); }}
            className="absolute right-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/60 transition shadow-xl"
            title="Next (Right Arrow)"
          >
            <ChevronRight className="w-6 h-6" />
          </button>

          <button onClick={() => setIsLoupeOpen(false)} className="absolute top-6 right-6 p-2 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 border border-zinc-700/60">
            <X className="w-5 h-5" />
          </button>

          {/* Interactive Fullscreen Triage Action HUD */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-[#10121a]/95 border border-zinc-700/70 backdrop-blur-xl px-5 py-2.5 rounded-2xl flex items-center gap-4 text-xs text-zinc-200 shadow-2xl z-50"
          >
            <div className="flex flex-col">
              <span className="font-semibold text-zinc-100">{activePhoto.name}</span>
              <span className="text-[10px] text-zinc-500 font-mono">
                {activePhoto.captured_at || "No date"} {activePhoto.location ? `• ${activePhoto.location}` : ""}
              </span>
            </div>

            {/* Pick/Reject in Loupe */}
            <div className="flex items-center gap-1 border-l border-zinc-700 pl-3">
              <button
                onClick={() => { handleSetFlag(activePhoto.flag === "pick" ? null : "pick"); if (autoAdvance) navigateByOffset(1, false); }}
                className={`px-2 py-1 rounded font-medium flex items-center gap-1 ${activePhoto.flag === "pick" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400"}`}
              >
                🚩 Pick (P)
              </button>
              <button
                onClick={() => { handleSetFlag("reject"); handleBatchStageMove("_Trash"); if (autoAdvance) navigateByOffset(1, false); }}
                className="px-2 py-1 bg-zinc-800 hover:bg-red-950/60 text-red-400 rounded font-medium flex items-center gap-1"
              >
                ❌ Reject (X)
              </button>
            </div>

            {/* Stars */}
            <div className="flex items-center gap-1 border-l border-zinc-700 pl-3">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => { handleBatchRate(star); if (autoAdvance) navigateByOffset(1, false); }}
                  className={`hover:text-amber-400 font-bold px-0.5 ${star <= activePhoto.rating ? "text-amber-400" : "text-zinc-600"}`}
                >
                  ★
                </button>
              ))}
            </div>

            {/* Rotation in Loupe */}
            <div className="flex items-center gap-1 border-l border-zinc-700 pl-3">
              <button onClick={() => handleRotateSelection(-90)} className="p-1 hover:bg-zinc-800 rounded text-zinc-400" title="Rotate Left ([)">
                <RotateLeft className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => handleRotateSelection(90)} className="p-1 hover:bg-zinc-800 rounded text-zinc-400" title="Rotate Right (])">
                <RotateCw className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* AI Analyze in Loupe */}
            <button onClick={handleAiAnalyzeSingle} className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 rounded text-white border-l border-zinc-700 ml-1">
              <Sparkles className="w-3.5 h-3.5" />
              <span>AI (A)</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
