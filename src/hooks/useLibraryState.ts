import { useState, useEffect, useMemo, useRef, useCallback, useDeferredValue } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, ask } from "@tauri-apps/plugin-dialog";
import {
  PhotoItem,
  PersonItem,
  SmartFilter,
  OrientationFilter,
  SortOption,
  TimelineBucket,
  FaceScanProgress,
  FaceMatchEvent,
  ThumbBatchProgress,
  ThumbBatchItem,
  AutoStagePreset,
  LibraryHealthStats,
  OllamaStatus,
  CitySearchResult,
  ExifRefreshResult,
  FaceInstance,
  TimestampShiftResult,
  AiAnalysisResult,
  AiPerf,
  PerfLogEvent,
  FaceModelDownloadProgress,
  XmpExportResult,
  CommitResult,
  TrashResult,
  OllamaPullProgress,
  ScanProgressEvent,
  AiFailureItem,
  AiBatchReport,
  SessionLogEntry,
  SemanticStatus,
  SemanticProgress,
  SemanticHit,
  Album,
  SavedSearch,
  BulkPopover,
  ExportProgress,
  ExportResult,
  PhotoActionSnapshot,
  UndoHistoryEntry,
  ViewMode,
} from "../types/lumina";
import {
  buildFolderTree,
  computePresetTargetFolder,
} from "../utils/photoHelpers";
import { expandWithRawPairs, diskPathOf, RAW_OR_HEIC_NAME } from "../utils/rawPairs";
import type { GridStyle, CardDetails } from "../components/views/VirtualPhotoGrid";
import { parseSearchQuery, matchesTerms, MatchContext } from "../utils/searchQuery";
import { computeTrips, tripLabel } from "../utils/trips";
import type { ExportSettings } from "../components/modals/ExportModal";

const MAX_UNDO_STEPS = 20;
const MAX_TOASTS = 4;

export interface Toast {
  id: number;
  kind: "info" | "error";
  message: string;
}

// One collator for all sorting: String.localeCompare(..., options) builds a new collator on every call,
// which dominated sort time on large libraries
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true });
const TEXT_COLLATOR = new Intl.Collator();
// Dates are "YYYY-MM-DD HH:MM:SS": plain code-unit order is the correct (and fastest) order
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Lower-cased searchable text per photo object. Photos are replaced (not mutated) on every change,
// so the WeakMap entry refreshes automatically and stale entries are garbage-collected.
const searchTextCache = new WeakMap<PhotoItem, string>();
function searchTextOf(p: PhotoItem): string {
  let text = searchTextCache.get(p);
  if (text === undefined) {
    text = [p.name, p.ai_caption, p.ocr_text, p.location, ...p.tags, ...p.people]
      .join("\n")
      .toLowerCase();
    searchTextCache.set(p, text);
  }
  return text;
}

// Error text of an AI request aborted by the Stop button (matches ai::AI_CANCELLED in Rust)
const AI_CANCELLED = "AI analysis cancelled";
// Matching scan::SCAN_CANCELLED and ai::PULL_CANCELLED
const SCAN_CANCELLED = "Folder scan cancelled";
const PULL_CANCELLED = "Model download cancelled";
// Matching clip::SEMANTIC_CANCELLED
const SEMANTIC_CANCELLED = "Smart search indexing cancelled";

// The library's most used tags, offered to the model so the same subject gets the same tag everywhere
function topLibraryTags(list: PhotoItem[], max = 40): string[] {
  const counts = new Map<string, number>();
  for (const p of list) {
    for (const t of p.tags) {
      if (t !== "screenshot") counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}

// Windows paths: compare case-insensitively and ignore a trailing separator
type LocationValue = { location: string; latitude: number | null; longitude: number | null };

// localStorage can throw (private mode, blocked storage): settings then just aren't remembered
function readSetting<T extends string>(key: string, fallback: T, allowed: T[]): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function isSameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

// Averages per-photo AI timings into one Session Log line (tokens/s use summed tokens over summed durations)
function summarizeAiPerf(perfs: AiPerf[]): string {
  if (perfs.length === 0) return "";
  const sum = (key: keyof AiPerf) => perfs.reduce((acc, p) => acc + p[key], 0);
  const avg = (key: keyof AiPerf) => Math.round(sum(key) / perfs.length);
  const rate = (tokens: number, ms: number) => (ms > 0 ? ((tokens * 1000) / ms).toFixed(1) : "?");
  return [
    `avg ${(avg("total_ms") / 1000).toFixed(1)} s/photo`,
    `encode ${avg("encode_ms")} ms (${avg("image_kb")} KB image)`,
    `ollama ${avg("request_ms")} ms (model load ${avg("ollama_load_ms")} ms)`,
    `prompt ${avg("prompt_tokens")} tok @ ${rate(sum("prompt_tokens"), sum("prompt_eval_ms"))} tok/s`,
    `output ${avg("output_tokens")} tok @ ${rate(sum("output_tokens"), sum("output_eval_ms"))} tok/s`,
    `db + faces ${avg("post_ms")} ms`,
  ].join(" · ");
}

export function captureSnapshots(
  photos: PhotoItem[],
  targetHashes: Set<string> | string[]
): PhotoActionSnapshot[] {
  const set = targetHashes instanceof Set ? targetHashes : new Set(targetHashes);
  const out: PhotoActionSnapshot[] = [];
  for (const p of photos) {
    if (set.has(p.hash)) {
      out.push({
        hash: p.hash,
        flag: p.flag,
        rating: p.rating,
        color_label: p.color_label,
        staged_target: p.staged_target ?? null,
        in_basket: p.in_basket,
        rotation: p.rotation,
      });
    }
  }
  return out;
}

type SnapshotField = Exclude<keyof PhotoActionSnapshot, "hash">;
const SNAPSHOT_FIELDS: SnapshotField[] = [
  "flag",
  "rating",
  "color_label",
  "staged_target",
  "in_basket",
  "rotation",
];

// Fields an undo entry actually changed; undo/redo re-applies only these. Re-sending untouched fields
// would e.g. re-stage photos whose staged move was committed (physically moved) after the action.
export function changedSnapshotFields(entry: UndoHistoryEntry): Set<SnapshotField> {
  const afterByHash = new Map(entry.after.map((s) => [s.hash, s]));
  const changed = new Set<SnapshotField>();
  for (const b of entry.before) {
    const a = afterByHash.get(b.hash);
    if (!a) continue;
    for (const f of SNAPSHOT_FIELDS) {
      if (a[f] !== b[f]) changed.add(f);
    }
  }
  return changed;
}

async function applySnapshotsToBackend(
  snapshots: PhotoActionSnapshot[],
  fields: Set<SnapshotField>,
  setPhotos: React.Dispatch<React.SetStateAction<PhotoItem[]>>
) {
  if (snapshots.length === 0 || fields.size === 0) return;

  const byFlag = new Map<"pick" | "reject" | null, string[]>();
  const byRating = new Map<number, string[]>();
  const byColor = new Map<"red" | "yellow" | "green" | "blue" | null, string[]>();
  const byBasket = new Map<boolean, string[]>();
  const stageOps: { hash: string; target_subfolder: string | null }[] = [];

  for (const s of snapshots) {
    const fList = byFlag.get(s.flag) || [];
    fList.push(s.hash);
    byFlag.set(s.flag, fList);

    const rList = byRating.get(s.rating) || [];
    rList.push(s.hash);
    byRating.set(s.rating, rList);

    const cList = byColor.get(s.color_label) || [];
    cList.push(s.hash);
    byColor.set(s.color_label, cList);

    const bList = byBasket.get(s.in_basket) || [];
    bList.push(s.hash);
    byBasket.set(s.in_basket, bList);

    stageOps.push({ hash: s.hash, target_subfolder: s.staged_target });
  }

  if (fields.has("flag")) {
    for (const [flag, hashes] of byFlag.entries()) {
      await invoke("set_photo_flag", { hashes, flag });
    }
  }
  if (fields.has("rating")) {
    for (const [rating, hashes] of byRating.entries()) {
      await invoke("set_photos_rating", { hashes, rating });
    }
  }
  if (fields.has("color_label")) {
    for (const [color, hashes] of byColor.entries()) {
      await invoke("set_photo_color_label", { hashes, color });
    }
  }
  if (fields.has("in_basket")) {
    for (const [inBasket, hashes] of byBasket.entries()) {
      await invoke("set_photo_basket", { hashes, inBasket });
    }
  }
  if (fields.has("staged_target") && stageOps.length > 0) {
    await invoke("stage_photos_move", { ops: stageOps });
  }
  if (fields.has("rotation")) {
    const rotOps = snapshots.map((s) => ({ hash: s.hash, rotation: s.rotation }));
    await invoke("set_photos_rotation_exact", { ops: rotOps });
  }

  const snapMap = new Map(snapshots.map((s: PhotoActionSnapshot) => [s.hash, s]));
  setPhotos((prev) =>
    prev.map((p) => {
      const hit = snapMap.get(p.hash);
      if (!hit) return p;
      const next = { ...p };
      for (const f of fields) {
        (next as Record<SnapshotField, unknown>)[f] = hit[f];
      }
      return next;
    })
  );
}

export function useUndoStack(
  setPhotos: React.Dispatch<React.SetStateAction<PhotoItem[]>>,
  setActiveHash: React.Dispatch<React.SetStateAction<string | null>>,
  setSelectedHashes: React.Dispatch<React.SetStateAction<Set<string>>>,
  setAutoMatchNotice: (message: string) => void
) {
  // Stacks live in refs so rapid Ctrl+Z presses each see the stack as left by the previous one;
  // `version` only exists to re-render buttons (canUndo/canRedo).
  const undoRef = useRef<UndoHistoryEntry[]>([]);
  const redoRef = useRef<UndoHistoryEntry[]>([]);
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  // Undo/redo run strictly one after another, in the order they were pressed
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const pushUndoEntry = useCallback(
    (entry: UndoHistoryEntry) => {
      undoRef.current = [...undoRef.current.slice(-(MAX_UNDO_STEPS - 1)), entry];
      redoRef.current = [];
      bump();
    },
    [bump]
  );

  const clearHistory = useCallback(() => {
    undoRef.current = [];
    redoRef.current = [];
    bump();
  }, [bump]);

  const enqueue = useCallback((step: () => Promise<void>) => {
    queueRef.current = queueRef.current.then(step, step);
    return queueRef.current;
  }, []);

  const handleUndo = useCallback(
    () =>
      enqueue(async () => {
        const last = undoRef.current[undoRef.current.length - 1];
        if (!last) return;
        try {
          if (last.undoAction) await last.undoAction();
          else await applySnapshotsToBackend(last.before, changedSnapshotFields(last), setPhotos);
        } catch (err) {
          setAutoMatchNotice(`Undo failed (${last.description}): ${String(err)}`);
          return;
        }
        // Only move the entry once the backend accepted it, so a failed undo can be retried
        undoRef.current = undoRef.current.slice(0, -1);
        redoRef.current = [...redoRef.current, last];
        bump();
        if (last.previousActiveHash) {
          setActiveHash(last.previousActiveHash);
        }
        if (last.previousSelectedHashes.length > 0) {
          setSelectedHashes(new Set(last.previousSelectedHashes));
        }
        setAutoMatchNotice(`Undid: ${last.description}`);
      }),
    [enqueue, bump, setPhotos, setActiveHash, setSelectedHashes, setAutoMatchNotice]
  );

  const handleRedo = useCallback(
    () =>
      enqueue(async () => {
        const next = redoRef.current[redoRef.current.length - 1];
        if (!next) return;
        try {
          if (next.redoAction) await next.redoAction();
          else await applySnapshotsToBackend(next.after, changedSnapshotFields(next), setPhotos);
        } catch (err) {
          setAutoMatchNotice(`Redo failed (${next.description}): ${String(err)}`);
          return;
        }
        redoRef.current = redoRef.current.slice(0, -1);
        undoRef.current = [...undoRef.current, next];
        bump();
        setAutoMatchNotice(`Redid: ${next.description}`);
      }),
    [enqueue, bump, setPhotos, setAutoMatchNotice]
  );

  return {
    undoStack: undoRef.current,
    redoStack: redoRef.current,
    canUndo: undoRef.current.length > 0,
    canRedo: redoRef.current.length > 0,
    pushUndoEntry,
    clearHistory,
    handleUndo,
    handleRedo,
  };
}


export function useLibraryState() {
  const [isAppReady, setIsAppReady] = useState<boolean>(false);
  const splashClosedRef = useRef<boolean>(false);
  const [folder, setFolder] = useState<string>(() => {
    try {
      return localStorage.getItem("lumina_active_folder") || "";
    } catch {
      return "";
    }
  });
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [recentFolders, setRecentFolders] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("lumina_recent_folders");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [simpleMode, setSimpleMode] = useState<boolean>(() => {
    return localStorage.getItem("lumina_simple_mode") === "true";
  });
  // Grid appearance (Tools menu), remembered between sessions
  const [gridStyle, setGridStyleState] = useState<GridStyle>(() =>
    readSetting("lumina_grid_style", "justified", ["justified", "square"])
  );
  const [cardDetails, setCardDetailsState] = useState<CardDetails>(() =>
    readSetting("lumina_card_details", "hover", ["hover", "always"])
  );
  const setGridStyle = (value: GridStyle) => {
    setGridStyleState(value);
    writeSetting("lumina_grid_style", value);
  };
  const setCardDetails = (value: CardDetails) => {
    setCardDetailsState(value);
    writeSetting("lumina_card_details", value);
  };
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState<boolean>(false);
  const [ollamaPullProgress, setOllamaPullProgress] = useState<OllamaPullProgress | null>(null);
  const [people, setPeople] = useState<PersonItem[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [pendingFaceCounts, setPendingFaceCounts] = useState<Record<string, number>>({});
  // The person the People tab should show first (asking for one also switches to that tab)
  const [faceReviewPerson, setFaceReviewPersonState] = useState<string | null>(null);

  const [smartFilter, setSmartFilter] = useState<SmartFilter>("ALL");
  const [orientationFilter, setOrientationFilter] = useState<OrientationFilter>("ALL");
  const [activeSubfolder, setActiveSubfolder] = useState<string>("ALL");
  const [activeEvent, setActiveEvent] = useState<string>("ALL");
  const [activeTag, setActiveTag] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  // Smart search: the search box describes the photo ("dog on the beach") and CLIP ranks the library.
  // `semanticHits` holds the ranked matches with what they were for (a text query or "similar to" a photo).
  const [smartSearch, setSmartSearch] = useState<boolean>(false);
  const [semanticResult, setSemanticResult] = useState<{
    source: { kind: "text"; query: string } | { kind: "similar"; hash: string; name: string };
    scores: Map<string, number>;
  } | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<SemanticStatus | null>(null);
  const [semanticProgress, setSemanticProgress] = useState<SemanticProgress | null>(null);
  // Albums and smart albums (saved searches); `activeAlbumId` filters the grid to one album
  const [albums, setAlbums] = useState<Album[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [activeAlbumId, setActiveAlbumId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>("NAME_ASC");

  // Slide-Out Timeline Slicer State
  const [isTimelineOpen, setIsTimelineOpen] = useState<boolean>(false);
  const [timelineBuckets, setTimelineBuckets] = useState<TimelineBucket[]>([]);
  const [selectedPeriodRange, setSelectedPeriodRange] = useState<[string, string] | null>(null);
  const [dragAnchorDay, setDragAnchorDay] = useState<string | null>(null);

  // Inspector Single-Photo Location Editor State
  const [isEditingInspectorLocation, setIsEditingInspectorLocation] = useState<boolean>(false);
  const [inspectorLocationQuery, setInspectorLocationQuery] = useState<string>("");

  // Neural ONNX Face Scanner & Folder Scan Progress State
  const [faceScanProgress, setFaceScanProgress] = useState<FaceScanProgress | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgressEvent | null>(null);
  const [isDetectingSingleFace, setIsDetectingSingleFace] = useState<boolean>(false);

  // Auto-Advance Mode Toggle
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true);

  // Burst Stacking State
  const [showAllBurstVersions, setShowAllBurstVersions] = useState<boolean>(false);
  const [expandedBurstGroups, setExpandedBurstGroups] = useState<Set<number>>(new Set());

  // Zoom & View State
  const [zoomLevel, setZoomLevel] = useState<number>(0.45);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const setFaceReviewPerson = useCallback((person: string | null) => {
    setFaceReviewPersonState(person);
    if (person) setViewMode("people");
  }, []);
  const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set());
  const [activeHash, setActiveHash] = useState<string | null>(null);
  // Shift-click / Shift+arrow range anchor (a photo hash, resolved to an index at use time)
  const selectionAnchorHashRef = useRef<string | null>(null);

  const [isLoupeOpen, setIsLoupeOpen] = useState<boolean>(false);
  const [isCommitModalOpen, setIsCommitModalOpen] = useState<boolean>(false);
  const [smartRenameOnCommit, setSmartRenameOnCommit] = useState<boolean>(false);
  const [autoStagePreset, setAutoStagePreset] = useState<AutoStagePreset>("YEAR_MONTH_CITY");

  // Synchronized Compare Mode State
  const [compareZoom, setCompareZoom] = useState<number>(1);
  const [comparePan, setComparePan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Click-on-Map GPS Picker Mode
  const [isPickingMapLocation, setIsPickingMapLocation] = useState<boolean>(false);

  // Camera Clock Shift State
  const [shiftHoursInput, setShiftHoursInput] = useState<number>(0);
  const [shiftMinutesInput, setShiftMinutesInput] = useState<number>(0);

  // Library Health & XMP Modal State
  const [isHealthModalOpen, setIsHealthModalOpen] = useState<boolean>(false);
  const [healthStats, setHealthStats] = useState<LibraryHealthStats | null>(null);
  const [isExportingXmp, setIsExportingXmp] = useState<boolean>(false);

  // Session Activity Log State
  const [sessionLogs, setSessionLogs] = useState<SessionLogEntry[]>([]);
  const [isSessionLogModalOpen, setIsSessionLogModalOpen] = useState<boolean>(false);

  // Batch AI Report Modal State
  const [aiBatchReport, setAiBatchReport] = useState<AiBatchReport | null>(null);

  // Bulk Dock Popover States
  const [activeBulkPopover, setActiveBulkPopover] = useState<
    BulkPopover | null
  >(null);
  const [bulkInput, setBulkInput] = useState<string>("");
  // City search has its own text, so typing a city never overwrites the tag/person/move input
  const [cityQuery, setCityQuery] = useState<string>("");
  const [citySearchResults, setCitySearchResults] = useState<CitySearchResult[]>([]);

  // Interactive Face Box State
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(null);
  const [isDrawingFace, setIsDrawingFace] = useState<boolean>(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawnBox, setDrawnBox] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null
  );
  const [faceNameInput, setFaceNameInput] = useState<string>("");
  const [isScanningFolder, setIsScanningFolder] = useState<boolean>(false);

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
    currentFile?: string;
    startedAt: number;
    stopping?: boolean;
  } | null>(null);
  const cancelBatchRef = useRef<boolean>(false);

  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [tagInput, setTagInput] = useState<string>("");

  const lastLogRef = useRef<{ key: string; time: number }>({ key: "", time: 0 });
  const addLog = useCallback(
    (category: SessionLogEntry["category"], message: string, details?: string) => {
      const now = Date.now();
      const dedupKey = `${category}:${message}:${details || ""}`;
      if (lastLogRef.current.key === dedupKey && now - lastLogRef.current.time < 400) {
        return;
      }
      lastLogRef.current = { key: dedupKey, time: now };
      const entry: SessionLogEntry = {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date().toLocaleTimeString(),
        category,
        message,
        details,
      };
      setSessionLogs((prev) => [entry, ...prev.slice(0, 499)]);
    },
    []
  );

  const clearSessionLogs = useCallback(() => setSessionLogs([]), []);

  // Notifications: a small queue where every toast has its own timer, so a new message is never wiped by
  // an older message's timeout. Errors stay longer and are also written to the Session Log.
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeqRef = useRef(0);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const notify = useCallback(
    (message: string, kind: Toast["kind"] = "info") => {
      if (!message) return;
      const id = ++toastSeqRef.current;
      // The same message again (e.g. a repeated failure) replaces the old toast instead of stacking
      setToasts((prev) => [...prev.filter((t) => t.message !== message), { id, kind, message }].slice(-MAX_TOASTS));
      const ttl = kind === "error" ? 12000 : Math.min(9000, 3500 + message.length * 25);
      window.setTimeout(() => dismissToast(id), ttl);
    },
    [dismissToast]
  );
  const setError = useCallback(
    (message: string) => {
      if (!message) return;
      notify(message, "error");
      addLog("ERROR", message);
    },
    [notify, addLog]
  );
  const setAutoMatchNotice = useCallback((message: string) => notify(message, "info"), [notify]);

  const undo = useUndoStack(
    setPhotos,
    setActiveHash,
    setSelectedHashes,
    setAutoMatchNotice
  );

  function toggleSimpleMode() {
    const next = !simpleMode;
    setSimpleMode(next);
    try {
      localStorage.setItem("lumina_simple_mode", String(next));
    } catch {}
    addLog("LIBRARY", `Switched UI to ${next ? "Simple Mode" : "Pro Studio Mode"}`);
  }

  function saveRecentFolder(path: string) {
    try {
      localStorage.setItem("lumina_active_folder", path);
    } catch {}
    setRecentFolders((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 6);
      try {
        localStorage.setItem("lumina_recent_folders", JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  // Listen for Folder Scan Progress Events
  useEffect(() => {
    const unlisten = listen<ScanProgressEvent>("scan-progress", (event) => {
      const prog = event.payload;
      if (prog.done) {
        setScanProgress(null);
      } else {
        setScanProgress(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // One-time face model download progress (shown in the header while a face scan waits for it)
  const [faceModelDownload, setFaceModelDownload] = useState<FaceModelDownloadProgress | null>(null);
  useEffect(() => {
    const unlisten = listen<FaceModelDownloadProgress>("face-model-download", (event) => {
      const prog = event.payload;
      if (prog.done) {
        setFaceModelDownload(null);
        addLog("FACE", prog.stage);
      } else {
        setFaceModelDownload(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog]);

  // Listen for backend performance timings (scan, thumbnails, face scan, previews)
  useEffect(() => {
    const unlisten = listen<PerfLogEvent>("perf-log", (event) => {
      const { label, millis, count, details } = event.payload;
      const items = count === 1 ? "" : ` for ${count} items`;
      addLog("PERF", `${label}: ${(millis / 1000).toFixed(2)} s${items}`, details);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog]);

  // Listen for Ollama Pull Progress Events
  useEffect(() => {
    const unlisten = listen<OllamaPullProgress>("ollama-pull-progress", (event) => {
      const prog = event.payload;
      if (prog.done) {
        setOllamaPullProgress(null);
        setAutoMatchNotice(`Smart Photo Assistant (${prog.model}) installed and ready!`);
        addLog("AI", `Downloaded & installed Ollama model: ${prog.model}`);
      } else {
        setOllamaPullProgress(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog]);

  // Dismiss Splashscreen IMMEDIATELY on mount so startup never waits on Ollama TCP timeouts
  useEffect(() => {
    if (!splashClosedRef.current) {
      splashClosedRef.current = true;
      setIsAppReady(true);
      invoke("close_splashscreen").catch(() => {});
    }
  }, []);

  // Auto-restore active folder on mount (or if WebView2 ever reloads) so it never drops back to the welcome screen
  const initialRestoreDoneRef = useRef<boolean>(false);
  useEffect(() => {
    if (!initialRestoreDoneRef.current) {
      initialRestoreDoneRef.current = true;
      try {
        const savedActive = localStorage.getItem("lumina_active_folder");
        if (savedActive && photos.length === 0) {
          handleLoadFolderPath(savedActive);
        }
      } catch {}
    }
  }, []);

  // Poll Ollama status every 10s & only trigger React state update if status actually changed!
  useEffect(() => {
    let mounted = true;
    async function checkStatus() {
      try {
        const s = await invoke<OllamaStatus>("check_ollama_status");
        if (!mounted) return;
        setOllamaStatus((prev) => {
          if (
            prev &&
            prev.running === s.running &&
            prev.active_vram_model === s.active_vram_model &&
            prev.installed_models.length === s.installed_models.length
          ) {
            return prev;
          }
          return s;
        });
        if (
          s.installed_models.length > 0 &&
          !s.installed_models.some((m) => m.name === aiModel)
        ) {
          setAiModel(s.installed_models[0].name);
        }
      } catch {
        if (!mounted) return;
        setOllamaStatus((prev) =>
          prev && !prev.running
            ? prev
            : { running: false, active_vram_model: null, installed_models: [] }
        );
      }
    }
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [aiModel]);

  async function refreshPeople(currentFolder = folder, skipPendingScan = false) {
    try {
      // 1. Immediately load & render the Top People Carousel (<2ms) without waiting on biometric matching!
      const res = await invoke<PersonItem[]>("get_people", {
        rootFolder: currentFolder || null,
      });
      setPeople(res);

      // 2. Asynchronously compute & cache pending face match counts in the background
      if (!skipPendingScan) {
        invoke<Record<string, number>>("get_pending_face_match_counts", {
          rootFolder: currentFolder || null,
        })
          .then((pending) => {
            setPendingFaceCounts(pending || {});
          })
          .catch(() => {});
      }
    } catch {}
  }

  async function refreshTimeline(currentFolder = folder) {
    try {
      const b = await invoke<TimelineBucket[]>("get_timeline_distribution", {
        rootFolder: currentFolder || null,
      });
      setTimelineBuckets(b);
    } catch {}
  }

  // Debounced: opening a folder changes `folder` and then `photos.length`, which used to run the
  // (expensive) face-match count twice back to back
  useEffect(() => {
    const timer = setTimeout(() => {
      refreshPeople(folder);
      refreshTimeline(folder);
    }, 400);
    return () => clearTimeout(timer);
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
          `Auto-matched "${person_name}" across ${total_matched} other verified face${
            total_matched === 1 ? "" : "s"
          }!`
        );
        addLog("FACE", `Auto-matched "${person_name}" across ${total_matched} photo(s)`);
      } else {
        setAutoMatchNotice(`Saved "${person_name}"!`);
      }
      refreshPeople();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog]);

  useEffect(() => {
    const unlisten = listen<FaceScanProgress>("face-scan-progress", (event) => {
      const prog = event.payload;

      if (prog.batch_faces && Object.keys(prog.batch_faces).length > 0) {
        const facesMap = prog.batch_faces;
        const peopleMap = prog.batch_people || {};
        setPhotos((prev) =>
          prev.map((p) => {
            if (!(p.hash in facesMap)) return p;
            const updatedFaces = facesMap[p.hash] || [];
            const extraPeople = peopleMap[p.hash] || [];
            const confirmedNames = new Set(
              updatedFaces
                .map((f) => f.person_name?.trim())
                .filter((n): n is string => Boolean(n))
            );
            const mergedPeople = Array.from(
              new Set([...confirmedNames, ...extraPeople])
            ).sort();
            return {
              ...p,
              faces: updatedFaces,
              people: mergedPeople,
            };
          })
        );
      }

      if (prog.done) {
        setFaceScanProgress(null);
        if (prog.cancelled) {
          addLog(
            "FACE",
            `Cancelled ONNX Face Scan after ${prog.completed} of ${prog.total} photos`,
            `${prog.faces_found} faces found; photos not reached keep their previous faces`
          );
        } else {
          addLog(
            "FACE",
            `Completed ONNX Face Scan on ${prog.total} photos`,
            `${prog.faces_found} faces found — analyzing potential matches in background...`
          );
        }
        refreshPeople(folder, false).then(() => {
          setAutoMatchNotice(
            `Face Scan complete: detected ${prog.faces_found} face(s) & updated potential match badges!`
          );
        });
      } else {
        setFaceScanProgress(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [folder, addLog]);

  // Current folder for event listeners registered once (avoids stale-closure comparisons)
  const folderRef = useRef(folder);
  useEffect(() => {
    folderRef.current = folder;
    setProgress(null);
    // Undo entries reference photos of the previous folder; replaying them here would be wrong
    undo.clearHistory();
  }, [folder]);

  useEffect(() => {
    const unlisten = listen<ThumbBatchProgress>("thumb-batch-ready", (event) => {
      const { items, duplicate_groups, completed, total, folder: batchFolder } = event.payload;
      // A batch from a folder we've since left would overwrite this folder's duplicate groups
      if (!isSameFolder(batchFolder, folderRef.current)) return;
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

          const isRawOrHeic = RAW_OR_HEIC_NAME.test(p.name);
          const displayPath =
            isRawOrHeic && !p.path.endsWith("_preview.jpg") ? hit.thumb_path : p.path;

          return {
            ...p,
            path: displayPath,
            thumb_path: hit.thumb_path,
            // The file was rewritten (e.g. upgraded to 480 px): a new revision makes the grid reload it
            thumb_rev: p.thumb_ready && hit.thumb_edge > 0 ? (p.thumb_rev || 0) + 1 : p.thumb_rev,
            dhash: hit.dhash,
            sharpness: hit.sharpness,
            width: hit.width || p.width,
            height: hit.height || p.height,
            tags: mergedTags,
            thumb_ready: hit.thumb_ok,
            damaged: hit.damaged,
            duplicate_group: nextDup,
          };
        })
      );
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const folderTree = useMemo(() => buildFolderTree(photos), [photos]);
  // Typing stays responsive: the (expensive) grid filter catches up with the search box when idle
  const deferredSearchQuery = useDeferredValue(searchQuery);

  useEffect(() => {
    if (folderTree.nodes.length > 0 && expandedFolders.size === 0) {
      setExpandedFolders(new Set(folderTree.nodes.map((n) => n.fullPath)));
    }
  }, [folderTree.nodes]);

  // Events & trips found from capture time and GPS (newest first); `activeEvent` holds a trip id
  const [tripNames, setTripNames] = useState<Record<string, string>>({});
  useEffect(() => {
    invoke<Record<string, string>>("get_trip_names").then(setTripNames).catch(() => {});
  }, []);
  const trips = useMemo(() => computeTrips(photos), [photos]);
  const tripOfHash = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of trips) for (const h of t.hashes) m.set(h, t.id);
    return m;
  }, [trips]);
  const autoEvents = useMemo(
    () =>
      trips
        .map((t) => ({ id: t.id, label: tripLabel(t, tripNames[t.id]), count: t.hashes.length, kind: t.kind }))
        .reverse(),
    [trips, tripNames]
  );

  async function handleRenameTrip(id: string, name: string) {
    try {
      await invoke("set_trip_name", { tripId: id, name });
      setTripNames((prev) => {
        const next = { ...prev };
        if (name.trim()) next[id] = name.trim();
        else delete next[id];
        return next;
      });
    } catch (err) {
      setError(String(err));
    }
  }

  const allLibraryTags = useMemo(() => {
    const s = new Set<string>();
    photos.forEach((p) => p.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [photos]);

  const {
    stagedPhotos,
    gpsPhotosCount,
    screenshotPhotosCount,
    picksCount,
    rejectsCount,
    basketCount,
    sharpestInGroup,
    burstGroupCounts,
    totalBurstGroups,
    duplicatePhotosCount,
  } = useMemo(() => {
    const staged: PhotoItem[] = [];
    let gps = 0;
    let screenshots = 0;
    let picks = 0;
    let rejects = 0;
    let basket = 0;
    let dupCount = 0;
    const best = new Map<number, { hash: string; sharpness: number }>();
    const counts = new Map<number, number>();

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (p.staged_target) staged.push(p);
      if (p.latitude != null && p.longitude != null) gps++;
      if (p.tags.includes("screenshot")) screenshots++;
      if (p.flag === "pick") picks++;
      else if (p.flag === "reject") rejects++;
      if (p.in_basket) basket++;

      if (p.duplicate_group && p.subfolder !== "_Trash") {
        dupCount++;
        counts.set(p.duplicate_group, (counts.get(p.duplicate_group) || 0) + 1);
        const cur = best.get(p.duplicate_group);
        if (!cur || p.sharpness > cur.sharpness) {
          best.set(p.duplicate_group, { hash: p.hash, sharpness: p.sharpness });
        }
      }
    }

    return {
      stagedPhotos: staged,
      gpsPhotosCount: gps,
      screenshotPhotosCount: screenshots,
      picksCount: picks,
      rejectsCount: rejects,
      basketCount: basket,
      sharpestInGroup: best,
      burstGroupCounts: counts,
      totalBurstGroups: counts.size,
      duplicatePhotosCount: dupCount,
    };
  }, [photos]);

  // Smart results apply to the current query (or a "similar to" request); while a new query is being
  // embedded, the previous matches stay visible instead of flickering back to the full grid
  // The search box: `key:value` terms (rating:>=4 person:anna ...) plus free text for plain or smart search
  const parsedSearch = useMemo(() => parseSearchQuery(deferredSearchQuery), [deferredSearchQuery]);
  const albumSets = useMemo(() => new Map(albums.map((a) => [a.id, new Set(a.hashes)])), [albums]);
  const albumContext = useMemo<MatchContext>(() => {
    const byName = new Map(albums.map((a) => [a.name.toLowerCase(), albumSets.get(a.id)!]));
    return { albumHashes: (name: string) => byName.get(name.toLowerCase()) };
  }, [albums, albumSets]);

  const semanticScores =
    semanticResult &&
    (semanticResult.source.kind === "similar" || (smartSearch && parsedSearch.text !== ""))
      ? semanticResult.scores
      : null;

  const visiblePhotos = useMemo(() => {
    const q = semanticScores ? "" : parsedSearch.text.toLowerCase();
    const terms = parsedSearch.terms;
    const albumFilter = activeAlbumId !== null ? albumSets.get(activeAlbumId) ?? new Set<string>() : null;
    const filtered = photos.filter((p) => {
      if (smartFilter === "PICKS" && p.flag !== "pick") return false;
      if (smartFilter === "REJECTS" && p.flag !== "reject") return false;
      if (smartFilter === "BASKET" && !p.in_basket) return false;
      if (smartFilter === "FAVORITES" && p.rating < 4) return false;
      if (smartFilter === "UNTAGGED" && (p.tags.length > 0 || p.ai_caption.length > 0)) return false;
      if (smartFilter === "AI_TAGGED" && p.tags.length === 0 && !p.ai_caption) return false;
      if (smartFilter === "SCREENSHOTS" && !p.tags.includes("screenshot")) return false;
      if (smartFilter === "DUPLICATES" && (!p.duplicate_group || p.subfolder === "_Trash"))
        return false;
      if (smartFilter === "HAS_OCR" && !p.ocr_text) return false;
      if (smartFilter === "HAS_GPS" && (p.latitude == null || p.longitude == null)) return false;
      if (smartFilter === "STAGED" && !p.staged_target) return false;

      if (selectedPeriodRange) {
        const [startDay, endDay] = selectedPeriodRange;
        const pDay = p.captured_at ? p.captured_at.slice(0, 10).replace(/:/g, "-") : "";
        if (!pDay || pDay < startDay || pDay > endDay) return false;
      }

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
          if (
            p.subfolder !== activeSubfolder &&
            !p.subfolder.startsWith(activeSubfolder + " / ")
          ) {
            return false;
          }
        }
      }
      if (activeEvent !== "ALL" && tripOfHash.get(p.hash) !== activeEvent) return false;
      if (activeTag !== "ALL" && !p.tags.includes(activeTag)) return false;

      if (q && !searchTextOf(p).includes(q)) return false;
      if (terms.length > 0 && !matchesTerms(p, terms, albumContext)) return false;
      if (albumFilter && !albumFilter.has(p.hash)) return false;
      if (semanticScores && !semanticScores.has(p.hash)) return false;
      return true;
    });

    // Smart search: best match first, every photo shown (no burst stacking)
    if (semanticScores) {
      return filtered.sort((a, b) => (semanticScores.get(b.hash) ?? 0) - (semanticScores.get(a.hash) ?? 0));
    }

    // `filtered` is already a fresh array: sort it in place
    const sorted = filtered.sort((a, b) => {
      if (smartFilter === "DUPLICATES") {
        return (a.duplicate_group || 0) - (b.duplicate_group || 0) || b.sharpness - a.sharpness;
      }
      switch (sortBy) {
        case "NAME_ASC":
          return NAME_COLLATOR.compare(a.name, b.name);
        case "NAME_DESC":
          return NAME_COLLATOR.compare(b.name, a.name);
        case "DATE_DESC":
          return (
            compareStrings(b.captured_at || "", a.captured_at || "") ||
            TEXT_COLLATOR.compare(a.name, b.name)
          );
        case "DATE_ASC":
          return (
            compareStrings(a.captured_at || "9999", b.captured_at || "9999") ||
            TEXT_COLLATOR.compare(a.name, b.name)
          );
        case "SCORE_DESC":
          return b.sharpness - a.sharpness;
        case "SCORE_ASC":
          return a.sharpness - b.sharpness;
        case "RATING_DESC":
          return b.rating - a.rating || b.sharpness - a.sharpness;
        case "TAG_NAME": {
          const tA = a.tags[0] || "zzzz";
          const tB = b.tags[0] || "zzzz";
          return TEXT_COLLATOR.compare(tA, tB) || TEXT_COLLATOR.compare(a.name, b.name);
        }
        case "TAG_COUNT":
          return b.tags.length - a.tags.length || TEXT_COLLATOR.compare(a.name, b.name);
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
    tripOfHash,
    activeTag,
    parsedSearch,
    albumContext,
    albumSets,
    activeAlbumId,
    sortBy,
    showAllBurstVersions,
    expandedBurstGroups,
    viewMode,
    semanticScores,
  ]);

  const photoByHash = useMemo(() => {
    const m = new Map<string, PhotoItem>();
    for (let i = 0; i < photos.length; i++) {
      m.set(photos[i].hash, photos[i]);
    }
    return m;
  }, [photos]);

  const activePhoto = useMemo(
    () => (activeHash ? photoByHash.get(activeHash) || null : null),
    [photoByHash, activeHash]
  );

  // Photos that qualify for Compare before the 4-photo cap (Compare shows "+N more")
  const compareCandidateCount = useMemo(() => {
    if (selectedHashes.size >= 2) return visiblePhotos.filter((p) => selectedHashes.has(p.hash)).length;
    if (activePhoto?.duplicate_group) {
      return photos.filter(
        (p) => p.duplicate_group === activePhoto.duplicate_group && p.subfolder !== "_Trash"
      ).length;
    }
    return 0;
  }, [selectedHashes, visiblePhotos, activePhoto, photos]);

  const comparePhotos = useMemo(() => {
    if (selectedHashes.size >= 2) {
      return visiblePhotos.filter((p) => selectedHashes.has(p.hash)).slice(0, 4);
    }
    if (activePhoto?.duplicate_group) {
      return photos
        .filter(
          (p) => p.duplicate_group === activePhoto.duplicate_group && p.subfolder !== "_Trash"
        )
        .sort((a, b) => b.sharpness - a.sharpness)
        .slice(0, 4);
    }
    const idx = activeHash ? visiblePhotos.findIndex((p) => p.hash === activeHash) : 0;
    const start = Math.max(0, idx);
    return visiblePhotos.slice(start, start + 2);
  }, [selectedHashes, visiblePhotos, activePhoto, photos, activeHash]);

  useEffect(() => {
    const firstFace = activePhoto?.faces?.[0];
    setSelectedFaceId(firstFace ? firstFace.face_id : null);
    setDrawnBox(null);
    setIsDrawingFace(false);
    setFaceNameInput(firstFace?.person_name || "");
    setIsEditingInspectorLocation(false);
  }, [activeHash]);

  // On-Demand 1920px High-Res Preview Generation for RAW & HEIC when viewing in Loupe or Compare
  useEffect(() => {
    if (!isLoupeOpen && viewMode !== "compare") return;
    const candidates = viewMode === "compare" ? comparePhotos : activePhoto ? [activePhoto] : [];
    for (const item of candidates) {
      const isRawOrHeic = RAW_OR_HEIC_NAME.test(item.name);
      if (!isRawOrHeic || item.path.endsWith("_preview.jpg")) continue;
      const rawDiskPath = diskPathOf(item);
      const targetHash = item.hash;
      invoke<string>("ensure_high_res_preview", {
        hash: targetHash,
        sourcePath: rawDiskPath,
      })
        .then((previewPath) => {
          if (previewPath) {
            setPhotos((prev) =>
              prev.map((p) => (p.hash === targetHash ? { ...p, path: previewPath } : p))
            );
          }
        })
        .catch(() => {});
    }
  }, [activePhoto?.hash, activePhoto?.path, comparePhotos, isLoupeOpen, viewMode]);

  function handlePhotoClick(index: number, hash: string, e: React.MouseEvent) {
    setActiveHash(hash);
    // The anchor is a photo, not an index: after filtering/sorting the old index would point elsewhere
    const anchorIdx = selectionAnchorHashRef.current
      ? visiblePhotos.findIndex((p) => p.hash === selectionAnchorHashRef.current)
      : -1;
    if (e.shiftKey && anchorIdx !== -1) {
      const start = Math.min(anchorIdx, index);
      const end = Math.max(anchorIdx, index);
      const next = new Set(selectedHashes);
      for (let i = start; i <= end; i++) next.add(visiblePhotos[i].hash);
      setSelectedHashes(next);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedHashes);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      setSelectedHashes(next);
      selectionAnchorHashRef.current = hash;
    } else {
      setSelectedHashes(new Set([hash]));
      selectionAnchorHashRef.current = hash;
    }
  }

  // Empty-grid "Clear all filters": back to the whole library
  function clearAllFilters() {
    setSmartFilter("ALL");
    setOrientationFilter("ALL");
    setActiveSubfolder("ALL");
    setActiveEvent("ALL");
    setActiveTag("ALL");
    setSearchQuery("");
    setSelectedPerson(null);
    setSelectedPeriodRange(null);
    setSemanticResult(null);
    setActiveAlbumId(null);
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

  // Only the most recent folder load may apply its result (a slower earlier scan must not win)
  const folderLoadRequestRef = useRef(0);

  async function handleLoadFolderPath(targetPath: string) {
    if (!targetPath) return;
    const requestId = ++folderLoadRequestRef.current;
    const isSuperseded = () => requestId !== folderLoadRequestRef.current;
    const previousFolder = folder;
    try {
      setFolder(targetPath);
      setSelectedHashes(new Set());
      setActiveHash(null);
      setExpandedFolders(new Set());
      setExpandedBurstGroups(new Set());
      setSelectedPeriodRange(null);
      setIsScanningFolder(true);
      setScanProgress({
        stage: "Scanning directory & EXIF headers...",
        current_file: targetPath,
        completed: 0,
        total: 0,
        percent: 0,
        done: false,
      });
      const res = await invoke<PhotoItem[]>("scan_folder", {
        folderPath: targetPath,
        forceReprocess: false,
      });
      if (isSuperseded()) return;
      // Remember the folder only once it actually opened, so a bad path is never restored on next launch
      saveRecentFolder(targetPath);
      setPhotos(res);
      setIsScanningFolder(false);
      setScanProgress(null);
      addLog("LIBRARY", `Opened library folder (${res.length} items)`, targetPath);
      if (res.length > 0) {
        setActiveHash(res[0].hash);
        setSelectedHashes(new Set([res[0].hash]));
        selectionAnchorHashRef.current = res[0].hash;
      }
    } catch (err) {
      if (isSuperseded()) return;
      // Keep showing the previous folder's photos under the previous folder's name
      setFolder(previousFolder);
      setIsScanningFolder(false);
      setScanProgress(null);
      if (String(err).includes(SCAN_CANCELLED)) setAutoMatchNotice("Opening the folder was cancelled.");
      else setError(String(err));
    }
  }

  async function handleOpenFolder() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        await handleLoadFolderPath(selected);
      }
    } catch (err) {
      setIsScanningFolder(false);
      setScanProgress(null);
      setError(String(err));
    }
  }

  async function handlePullDefaultAiModel(modelToPull = "qwen3-vl:8b") {
    if (ollamaPullProgress) return;
    try {
      addLog("AI", `Started downloading Ollama model: ${modelToPull}`);
      await invoke<string>("pull_ollama_model", { modelName: modelToPull });
      const s = await invoke<OllamaStatus>("check_ollama_status");
      setOllamaStatus(s);
      setAiModel(modelToPull);
    } catch (err) {
      setOllamaPullProgress(null);
      if (String(err).includes(PULL_CANCELLED)) {
        setAutoMatchNotice("Model download cancelled. Starting it again resumes where it stopped.");
        addLog("AI", `Cancelled downloading Ollama model: ${modelToPull}`);
      } else {
        setError(String(err));
      }
    }
  }

  async function handleEmptyTrashToRecycleBin() {
    if (!folder) return;
    const inTrash = photos.filter((p) => p.subfolder === "_Trash" || p.subfolder.startsWith("_Trash / ")).length;
    if (inTrash === 0) {
      setAutoMatchNotice("_Trash is empty: commit staged rejects first to move them there.");
      return;
    }
    const ok = await confirmAction(
      `Move the ${inTrash} photo(s) in _Trash to the Windows Recycle Bin?\n\nYou can still restore them from the Recycle Bin, but not from Lumina.`,
      "Move to Recycle Bin"
    );
    if (!ok) return;
    try {
      const result = await invoke<TrashResult>("empty_library_trash_to_os", {
        rootFolder: folder,
      });
      const count = result.recycled;
      for (const f of result.failures) {
        addLog("DISK", `Could not recycle ${f.file}`, f.error);
      }
      if (result.failures.length > 0) {
        setError(
          `${result.failures.length} file(s) could not be moved to the Recycle Bin and were left in place. See the Session Log.`
        );
      }
      if (count > 0) {
        const res = await invoke<PhotoItem[]>("scan_folder", {
          folderPath: folder,
          forceReprocess: false,
        });
        setPhotos(res);
        setAutoMatchNotice(`Moved ${count} rejected photo(s) to your OS Recycle Bin.`);
        addLog("DISK", `Moved ${count} _Trash photo(s) to OS Recycle Bin`);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRescanFolder() {
    if (!folder || isScanningFolder) return;
    try {
      setIsScanningFolder(true);
      setScanProgress({
        stage: "Quick Rescanning folder...",
        current_file: folder,
        completed: 0,
        total: 0,
        percent: 0,
        done: false,
      });
      const res = await invoke<PhotoItem[]>("scan_folder", {
        folderPath: folder,
        forceReprocess: false,
      });
      setPhotos(res);
      addLog("LIBRARY", `Quick rescanned folder (${res.length} items)`, folder);
      if (res.length > 0 && (!activeHash || !res.some((p) => p.hash === activeHash))) {
        setActiveHash(res[0].hash);
        setSelectedHashes(new Set([res[0].hash]));
      }
    } catch (err) {
      if (String(err).includes(SCAN_CANCELLED)) setAutoMatchNotice("Rescan cancelled.");
      else setError(String(err));
    } finally {
      setIsScanningFolder(false);
      setScanProgress(null);
    }
  }

  async function handleRescanAndProcessFolder() {
    if (!folder || isScanningFolder) return;
    const ok = await confirmAction(
      `Rebuild thumbnails, duplicate detection and focus scores for all ${photos.length} photo(s)?\n\nThis reads every file again and can take several minutes on a large library. Ratings, tags, faces and AI results are kept.`,
      "Reprocess"
    );
    if (!ok) return;
    try {
      setIsScanningFolder(true);
      setScanProgress({
        stage: "Deep Reprocessing thumbnails, dHash & focus scores...",
        current_file: folder,
        completed: 0,
        total: 0,
        percent: 0,
        done: false,
      });
      const res = await invoke<PhotoItem[]>("scan_folder", {
        folderPath: folder,
        forceReprocess: true,
      });
      setPhotos(res);
      addLog("LIBRARY", `Deep reprocessed library (${res.length} items)`, folder);
    } catch (err) {
      if (String(err).includes(SCAN_CANCELLED)) setAutoMatchNotice("Rescan cancelled.");
      else setError(String(err));
    } finally {
      setIsScanningFolder(false);
      setScanProgress(null);
    }
  }

  async function handleForceRescanExifSelected() {
    const targets =
      selectedHashes.size > 0
        ? Array.from(selectedHashes)
        : activeHash
        ? [activeHash]
        : [];
    if (targets.length === 0) return;
    try {
      const results = await invoke<ExifRefreshResult[]>("rescan_exif_batch", {
        hashes: targets,
      });
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
            focal_length: hit.focal_length ?? p.focal_length,
            aperture: hit.aperture ?? p.aperture,
            shutter_speed: hit.shutter_speed ?? p.shutter_speed,
            iso: hit.iso ?? p.iso,
            lens_model: hit.lens_model ?? p.lens_model,
          };
        })
      );
      refreshTimeline();
      addLog("LIBRARY", `Refreshed EXIF headers on ${results.length} photo(s)`);
      const first = results[0];
      if (first) {
        setAutoMatchNotice(
          `EXIF refreshed (${results.length} photo${results.length === 1 ? "" : "s"}): Date=${
            first.captured_at ? first.captured_at.split(" ")[0] : "None"
          } • Cam=${first.camera_model || "None"} • Loc=${first.location || "None"}`
        );
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDetectFacesSingleOnnx() {
    if (!activePhoto || isDetectingSingleFace) return;
    try {
      setIsDetectingSingleFace(true);
      const detected = await invoke<FaceInstance[]>("detect_faces_in_photo", {
        hash: activePhoto.hash,
        imagePath: diskPathOf(activePhoto),
        forceOnnx: true,
      });
      setPhotos((prev) =>
        prev.map((p) => (p.hash === activePhoto.hash ? { ...p, faces: detected } : p))
      );
      if (detected.length > 0) {
        setSelectedFaceId(detected[0].face_id);
        setFaceNameInput(detected[0].person_name || "");
      }
      addLog("FACE", `Detected ${detected.length} face(s) in ${activePhoto.name}`);
      setAutoMatchNotice(
        detected.length > 0
          ? `ONNX Neural Detector found ${detected.length} human face(s) in ${activePhoto.name}!`
          : `ONNX Neural Detector confirmed 0 human faces in ${activePhoto.name}.`
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setIsDetectingSingleFace(false);
    }
  }

  // Starts a background face scan (detect, align, embed) for these photos. Unconfirmed faces are replaced
  // photo by photo as results arrive (face-scan-progress), so a cancelled scan leaves unreached photos untouched.
  async function startFaceScan(hashes: string[], logMessage: string) {
    if (faceScanProgressRef.current || hashes.length === 0) return;
    try {
      setPendingFaceCounts({});
      setFaceScanProgress({
        completed: 0,
        total: hashes.length,
        faces_found: 0,
        auto_matched: 0,
        done: false,
        cancelled: false,
      });
      addLog("FACE", logMessage);
      // The first call downloads (288 MB, once) and loads the face models before the scan starts
      await invoke<number>("scan_library_faces_batch", { hashes });
    } catch (err) {
      setFaceScanProgress(null);
      setFaceModelDownload(null);
      setError(String(err));
    }
  }

  async function handleBatchScanFacesOnnx() {
    if (photos.length === 0) return;
    await startFaceScan(
      photos.map((p) => p.hash),
      `Started face scan on ${photos.length} photos`
    );
  }

  // Face engine upgrade: photos whose faces came from the previous engine are re-scanned automatically once
  // per opened folder (confirmed names and rejections carry over; the old embeddings can't be matched)
  const faceScanProgressRef = useRef(faceScanProgress);
  faceScanProgressRef.current = faceScanProgress;
  const faceUpgradeCheckedRef = useRef<Set<string>>(new Set());
  const hasPhotos = photos.length > 0;
  useEffect(() => {
    if (!folder || !hasPhotos || faceUpgradeCheckedRef.current.has(folder)) return;
    const timer = setTimeout(async () => {
      if (faceScanProgressRef.current) return;
      faceUpgradeCheckedRef.current.add(folder);
      try {
        const outdated = await invoke<string[]>("get_outdated_face_photos", { rootFolder: folder });
        if (outdated.length > 0) {
          await startFaceScan(
            outdated,
            `Upgrading faces in ${outdated.length} photo(s) to the new face engine (names and rejections are kept)`
          );
        }
      } catch {}
    }, 1500);
    return () => clearTimeout(timer);
  }, [folder, hasPhotos]);

  // Jobs panel: stop making thumbnails (the rest is picked up the next time the folder is opened)
  async function handleCancelThumbnails() {
    try {
      await invoke("cancel_thumbnail_pass");
      setProgress(null);
      addLog("LIBRARY", "Stopped making thumbnails; the rest follows the next time this folder is opened");
    } catch (err) {
      setError(String(err));
    }
  }

  // Cancel button of the progress dialog: stops a model download or the folder scan, whichever is running
  async function handleCancelOperation() {
    try {
      await invoke(ollamaPullProgress ? "cancel_ollama_pull" : "cancel_folder_scan");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleCancelFaceScan() {
    try {
      await invoke("cancel_face_scan");
      addLog("FACE", "Stopping face scan after the current batch...");
    } catch (err) {
      setError(String(err));
    }
  }

  // Triage handlers act on `targetHashes` when given (e.g. the right-clicked photo), otherwise on the
  // current selection. Undo entries are recorded only after the backend accepted the change.
  function resolveTargets(targetHashes?: string[]): string[] {
    const base = targetHashes ?? Array.from(selectedHashes);
    return base.length === 0 ? [] : expandWithRawPairs(base, photos);
  }

  // Undo step for changes the photo snapshots can't express: the caller supplies undo and redo
  function pushCustomUndo(
    description: string,
    hashes: string[],
    undoAction: () => Promise<void>,
    redoAction: () => Promise<void>
  ) {
    undo.pushUndoEntry({
      description,
      previousActiveHash: activeHash,
      previousSelectedHashes: hashes,
      before: [],
      after: [],
      undoAction,
      redoAction,
    });
  }

  // Undo step for a staging/basket change on many photos (snapshot based)
  function pushSnapshotUndo(description: string, before: PhotoActionSnapshot[], after: PhotoActionSnapshot[]) {
    if (before.length === 0) return;
    undo.pushUndoEntry({
      description,
      previousActiveHash: activeHash,
      previousSelectedHashes: [],
      before,
      after,
    });
  }

  // Native confirmation for bulk, destructive or slow actions
  function confirmAction(message: string, okLabel: string) {
    return ask(message, { title: "Lumina", kind: "warning", okLabel, cancelLabel: "Cancel" });
  }

  // Undo step for a location change: undo restores every photo's previous place (one backend call per
  // distinct previous value), redo applies the new value again
  function pushLocationUndo(
    description: string,
    hashes: string[],
    next: (previous: LocationValue) => LocationValue,
    redoArgs: { location: string; latitude: number | null; longitude: number | null }
  ) {
    const before = new Map<string, LocationValue>();
    for (const h of hashes) {
      const p = photoByHash.get(h);
      if (p) before.set(h, { location: p.location, latitude: p.latitude ?? null, longitude: p.longitude ?? null });
    }
    if (before.size === 0) return;
    const applyLocal = (values: Map<string, LocationValue>) =>
      setPhotos((prev) =>
        prev.map((p) => {
          const v = values.get(p.hash);
          return v ? { ...p, ...v } : p;
        })
      );
    const targets = Array.from(before.keys());
    pushCustomUndo(
      description,
      targets,
      async () => {
        const groups = new Map<string, { value: LocationValue; hashes: string[] }>();
        for (const [h, v] of before) {
          const key = `${v.location}|${v.latitude}|${v.longitude}`;
          const g = groups.get(key) || { value: v, hashes: [] };
          g.hashes.push(h);
          groups.set(key, g);
        }
        for (const g of groups.values()) {
          await invoke("set_manual_location", { hashes: g.hashes, ...g.value });
        }
        applyLocal(before);
      },
      async () => {
        await invoke("set_manual_location", { hashes: targets, ...redoArgs });
        applyLocal(new Map(targets.map((h) => [h, next(before.get(h)!)])));
      }
    );
  }

  async function handleSetFlag(flag: "pick" | "reject" | null, targetHashes?: string[]) {
    const hashes = resolveTargets(targetHashes);
    if (hashes.length === 0) return;
    try {
      const hashSet = new Set(hashes);
      const before = captureSnapshots(photos, hashSet);
      const after = before.map((s: PhotoActionSnapshot) => ({ ...s, flag }));
      await invoke("set_photo_flag", { hashes, flag });
      undo.pushUndoEntry({
        description: `Flag (${flag || "unflag"}) on ${hashes.length} photo(s)`,
        previousActiveHash: activeHash,
        previousSelectedHashes: hashes,
        before,
        after,
      });
      setPhotos((prev) => prev.map((p) => (hashSet.has(p.hash) ? { ...p, flag } : p)));
      addLog("TRIAGE", `Set flag "${flag || "unflagged"}" on ${hashes.length} photo(s)`);
    } catch (err) {
      setError(String(err));
    }
  }

  // X key / "Reject & Trash": one action, one undo step (flag reject + stage to _Trash)
  async function handleRejectToTrash(targetHashes?: string[]) {
    const hashes = resolveTargets(targetHashes);
    if (hashes.length === 0) return;
    try {
      const hashSet = new Set(hashes);
      const before = captureSnapshots(photos, hashSet);
      const after = before.map((s: PhotoActionSnapshot) => ({
        ...s,
        flag: "reject" as const,
        staged_target: "_Trash",
      }));
      await invoke("set_photo_flag", { hashes, flag: "reject" });
      await invoke("stage_photos_move", {
        ops: hashes.map((hash) => ({ hash, target_subfolder: "_Trash" })),
      });
      undo.pushUndoEntry({
        description: `Reject & stage to _Trash on ${hashes.length} photo(s)`,
        previousActiveHash: activeHash,
        previousSelectedHashes: hashes,
        before,
        after,
      });
      setPhotos((prev) =>
        prev.map((p) =>
          hashSet.has(p.hash) ? { ...p, flag: "reject", staged_target: "_Trash" } : p
        )
      );
      addLog("TRIAGE", `Rejected & staged ${hashes.length} photo(s) to _Trash`);
    } catch (err) {
      setError(String(err));
    }
  }

  // Compare view "Keep This & Trash Rest": pick one, reject + stage the others, as ONE undo step
  async function handleKeepAndTrashRest(keepHash: string, otherHashes: string[]) {
    const keep = expandWithRawPairs([keepHash], photos);
    const keepSet = new Set(keep);
    const rest = expandWithRawPairs(otherHashes, photos).filter((h) => !keepSet.has(h));
    const restSet = new Set(rest);
    try {
      const before = captureSnapshots(photos, [...keep, ...rest]);
      const after = before.map((s: PhotoActionSnapshot) =>
        keepSet.has(s.hash)
          ? { ...s, flag: "pick" as const }
          : { ...s, flag: "reject" as const, staged_target: "_Trash" }
      );
      await invoke("set_photo_flag", { hashes: keep, flag: "pick" });
      if (rest.length > 0) {
        await invoke("set_photo_flag", { hashes: rest, flag: "reject" });
        await invoke("stage_photos_move", {
          ops: rest.map((hash) => ({ hash, target_subfolder: "_Trash" })),
        });
      }
      undo.pushUndoEntry({
        description: `Keep 1 & trash ${rest.length} photo(s) (Compare)`,
        previousActiveHash: activeHash,
        previousSelectedHashes: keep,
        before,
        after,
      });
      setPhotos((prev) =>
        prev.map((p) => {
          if (keepSet.has(p.hash)) return { ...p, flag: "pick" };
          if (restSet.has(p.hash)) return { ...p, flag: "reject", staged_target: "_Trash" };
          return p;
        })
      );
      addLog("TRIAGE", `Compare: kept 1 photo, staged ${rest.length} for _Trash`);
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }

  async function handleSetColorLabel(
    color: "red" | "yellow" | "green" | "blue" | null,
    targetHashes?: string[]
  ) {
    const hashes = resolveTargets(targetHashes);
    if (hashes.length === 0) return;
    try {
      const hashSet = new Set(hashes);
      const before = captureSnapshots(photos, hashSet);
      const after = before.map((s: PhotoActionSnapshot) => ({ ...s, color_label: color }));
      await invoke("set_photo_color_label", { hashes, color });
      undo.pushUndoEntry({
        description: `Color label (${color || "clear"}) on ${hashes.length} photo(s)`,
        previousActiveHash: activeHash,
        previousSelectedHashes: hashes,
        before,
        after,
      });
      setPhotos((prev) =>
        prev.map((p) => (hashSet.has(p.hash) ? { ...p, color_label: color } : p))
      );
      addLog("TRIAGE", `Set color label "${color || "none"}" on ${hashes.length} photo(s)`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRotateSelection(deltaDegrees: number, targetHashes?: string[]) {
    const hashes = resolveTargets(targetHashes);
    if (hashes.length === 0) return;
    try {
      const hashSet = new Set(hashes);
      const before = captureSnapshots(photos, hashSet);
      const res = await invoke<Record<string, number>>("set_photo_rotation", {
        hashes,
        deltaDegrees,
      });
      const after = before.map((s: PhotoActionSnapshot) => ({
        ...s,
        rotation: res[s.hash] !== undefined ? res[s.hash] : (s.rotation + deltaDegrees + 360) % 360,
      }));
      undo.pushUndoEntry({
        description: `Rotate (${deltaDegrees > 0 ? "+" : ""}${deltaDegrees}°) on ${hashes.length} photo(s)`,
        previousActiveHash: activeHash,
        previousSelectedHashes: hashes,
        before,
        after,
      });
      setPhotos((prev) =>
        prev.map((p) => (res[p.hash] !== undefined ? { ...p, rotation: res[p.hash] } : p))
      );
      addLog("TRIAGE", `Rotated ${hashes.length} photo(s) by ${deltaDegrees}°`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleBatchRate(rating: number, targetHashes?: string[]) {
    const hashes = resolveTargets(targetHashes);
    if (hashes.length === 0) return;
    try {
      const hashSet = new Set(hashes);
      const before = captureSnapshots(photos, hashSet);
      const after = before.map((s: PhotoActionSnapshot) => ({ ...s, rating }));
      await invoke("set_photos_rating", { hashes, rating });
      undo.pushUndoEntry({
        description: `Rating (${rating}★) on ${hashes.length} photo(s)`,
        previousActiveHash: activeHash,
        previousSelectedHashes: hashes,
        before,
        after,
      });
      setPhotos((prev) => prev.map((p) => (hashSet.has(p.hash) ? { ...p, rating } : p)));
      addLog("TRIAGE", `Rated ${hashes.length} photo(s) ${rating}★`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleBatchAddTag(tag: string) {
    if (!tag.trim() || selectedHashes.size === 0) return;
    try {
      const hashes = expandWithRawPairs(Array.from(selectedHashes), photos);
      const clean = await invoke<string>("add_tag_batch", { hashes, tag });
      // Undo removes the tag only from photos that didn't have it before
      const added = hashes.filter((h) => !photoByHash.get(h)?.tags.includes(clean));
      const addedSet = new Set(added);
      const applyTag = (on: boolean) =>
        setPhotos((prev) =>
          prev.map((p) => {
            if (!addedSet.has(p.hash)) return p;
            if (!on) return { ...p, tags: p.tags.filter((t) => t !== clean) };
            return p.tags.includes(clean) ? p : { ...p, tags: [...p.tags, clean].sort() };
          })
        );
      applyTag(true);
      if (added.length > 0) {
        pushCustomUndo(
          `Tag #${clean} on ${added.length} photo(s)`,
          hashes,
          async () => {
            await invoke("remove_tag_batch", { hashes: added, tag: clean });
            applyTag(false);
          },
          async () => {
            await invoke("add_tag_batch", { hashes: added, tag: clean });
            applyTag(true);
          }
        );
      }
      addLog("TRIAGE", `Added tag "#${clean}" to ${hashes.length} photo(s)`);
      setTagInput("");
      setBulkInput("");
      setActiveBulkPopover(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleBatchStageMove(targetSub: string | null, targetHashes?: string[]) {
    const hashes = resolveTargets(targetHashes);
    if (hashes.length === 0) return;
    try {
      const hashSet = new Set(hashes);
      const before = captureSnapshots(photos, hashSet);
      const after = before.map((s: PhotoActionSnapshot) => ({ ...s, staged_target: targetSub }));
      const ops = hashes.map((hash) => ({
        hash,
        target_subfolder: targetSub,
      }));
      await invoke("stage_photos_move", { ops });
      undo.pushUndoEntry({
        description: `Stage move (${targetSub || "clear"}) on ${hashes.length} photo(s)`,
        previousActiveHash: activeHash,
        previousSelectedHashes: hashes,
        before,
        after,
      });
      setPhotos((prev) =>
        prev.map((p) => (hashSet.has(p.hash) ? { ...p, staged_target: targetSub } : p))
      );
      addLog("DISK", `Staged ${hashes.length} photo(s) for move`, targetSub || "Cleared");
      setBulkInput("");
      setActiveBulkPopover(null);
    } catch (err) {
      setError(String(err));
    }
  }

  // Typing a city searches after a short pause; only the newest search may update the results
  const citySearchSeqRef = useRef(0);
  const citySearchTimerRef = useRef<number | undefined>(undefined);
  async function handleSearchCities(q: string) {
    setCityQuery(q);
    window.clearTimeout(citySearchTimerRef.current);
    const seq = ++citySearchSeqRef.current;
    if (q.trim().length < 2) {
      setCitySearchResults([]);
      return;
    }
    citySearchTimerRef.current = window.setTimeout(async () => {
      try {
        const matches = await invoke<CitySearchResult[]>("search_cities_offline", { query: q });
        if (seq === citySearchSeqRef.current) setCitySearchResults(matches);
      } catch {}
    }, 150);
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
      const value: LocationValue = {
        location: `${c.name}, ${c.country}`,
        latitude: c.latitude,
        longitude: c.longitude,
      };
      await invoke("set_manual_location", { hashes: targets, ...value });
      pushLocationUndo(`Location "${value.location}" on ${targets.length} photo(s)`, targets, () => value, value);
      const targetSet = new Set(targets);
      setPhotos((prev) => prev.map((p) => (targetSet.has(p.hash) ? { ...p, ...value } : p)));
      addLog("TRIAGE", `Assigned location "${value.location}" to ${targets.length} photo(s)`);
      setActiveBulkPopover(null);
      setIsEditingInspectorLocation(false);
      setCitySearchResults([]);
      setCityQuery("");
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
    // A typed place name keeps the photos' GPS coordinates; clearing the name clears them too
    const nextValue = (prev: LocationValue): LocationValue => ({
      location: clean,
      latitude: clean ? prev.latitude : null,
      longitude: clean ? prev.longitude : null,
    });
    try {
      const redoArgs = { location: clean, latitude: null, longitude: null };
      await invoke("set_manual_location", { hashes: targets, ...redoArgs });
      pushLocationUndo(
        clean ? `Location "${clean}" on ${targets.length} photo(s)` : `Clear location on ${targets.length} photo(s)`,
        targets,
        nextValue,
        redoArgs
      );
      const targetSet = new Set(targets);
      setPhotos((prev) =>
        prev.map((p) =>
          targetSet.has(p.hash)
            ? { ...p, ...nextValue({ location: p.location, latitude: p.latitude ?? null, longitude: p.longitude ?? null }) }
            : p
        )
      );
      addLog("TRIAGE", `Set custom location "${clean || "cleared"}" on ${targets.length} photo(s)`);
      setIsEditingInspectorLocation(false);
      setActiveBulkPopover(null);
      setInspectorLocationQuery("");
      setCityQuery("");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaveFaceAndAutomatch(e: React.FormEvent) {
    e.preventDefault();
    if (!activePhoto || !faceNameInput.trim()) return;
    const cleanName = faceNameInput.trim();

    let targetBbox: { x: number; y: number; w: number; h: number } | null = null;
    let previousFacePerson: string | null = null;

    if (drawnBox) {
      targetBbox = drawnBox;
    } else if (selectedFaceId) {
      const found = activePhoto.faces.find((f) => f.face_id === selectedFaceId);
      if (found) {
        previousFacePerson = found.person_name || null;
        targetBbox = {
          x: found.bbox_x,
          y: found.bbox_y,
          w: found.bbox_w,
          h: found.bbox_h,
        };
      }
    } else if (activePhoto.faces.length === 1) {
      // Exactly one face on the photo: unambiguous
      const found = activePhoto.faces[0];
      previousFacePerson = found.person_name || null;
      targetBbox = {
        x: found.bbox_x,
        y: found.bbox_y,
        w: found.bbox_w,
        h: found.bbox_h,
      };
    }

    if (!targetBbox) {
      // Never invent a face region: a made-up box would be saved as a reference face and skew matching
      setError(
        activePhoto.faces.length > 1
          ? `This photo has ${activePhoto.faces.length} faces: click the face that is "${cleanName}" first.`
          : `No face selected: draw a box around ${cleanName}'s face first (or tag the photo via the bulk "Person" action).`
      );
      return;
    }

    try {
      setAutoMatchNotice(`Saving "${cleanName}" & matching against verified faces...`);
      const updatedFaces = await invoke<FaceInstance[]>("assign_face_region_and_automatch", {
        hash: activePhoto.hash,
        imagePath: diskPathOf(activePhoto),
        bboxX: targetBbox.x,
        bboxY: targetBbox.y,
        bboxW: targetBbox.w,
        bboxH: targetBbox.h,
        personName: cleanName,
      });

      const activeFaceNames = Array.from(
        new Set(
          updatedFaces
            .map((f) => f.person_name?.trim())
            .filter((n): n is string => Boolean(n))
        )
      );

      setPhotos((prev) =>
        prev.map((p) => {
          if (p.hash !== activePhoto.hash) return p;
          const remainingManual = p.people.filter(
            (pe) => !previousFacePerson || pe.toLowerCase() !== previousFacePerson.toLowerCase()
          );
          const mergedPeople = Array.from(
            new Set([...remainingManual, ...activeFaceNames, cleanName])
          ).sort();
          return {
            ...p,
            faces: updatedFaces,
            people: mergedPeople,
          };
        })
      );
      addLog("FACE", `Assigned face "${cleanName}" on ${activePhoto.name}`);
      setFaceNameInput("");
      setDrawnBox(null);
      setSelectedFaceId(null);
      refreshPeople();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleBatchAssignPerson(personName: string, targetHashes?: string[]) {
    const clean = personName.trim();
    const hashes = resolveTargets(targetHashes);
    if (!clean || hashes.length === 0) return;
    try {
      // Undo removes the person only from photos that didn't have them before
      const added = hashes.filter((h) => !photoByHash.get(h)?.people.includes(clean));
      const addedSet = new Set(added);
      const applyPerson = (on: boolean) =>
        setPhotos((prev) =>
          prev.map((p) => {
            if (!addedSet.has(p.hash)) return p;
            if (!on) return { ...p, people: p.people.filter((n) => n !== clean) };
            return p.people.includes(clean) ? p : { ...p, people: [...p.people, clean].sort() };
          })
        );
      await invoke<number>("add_person_to_photos", { hashes, name: clean });
      applyPerson(true);
      if (added.length > 0) {
        pushCustomUndo(
          `Person "${clean}" on ${added.length} photo(s)`,
          hashes,
          async () => {
            await invoke("remove_person_from_photos", { hashes: added, name: clean });
            applyPerson(false);
            refreshPeople();
          },
          async () => {
            await invoke<number>("add_person_to_photos", { hashes: added, name: clean });
            applyPerson(true);
            refreshPeople();
          }
        );
      }
      addLog("FACE", `Assigned person "${clean}" to ${hashes.length} selected photo(s)`);
      setBulkInput("");
      setActiveBulkPopover(null);
      refreshPeople();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDismissAllStaged() {
    try {
      const staged = photos.filter((p) => p.staged_target);
      const before = captureSnapshots(staged, staged.map((p) => p.hash));
      const count = await invoke<number>("clear_all_staged", { rootFolder: folder || null });
      pushSnapshotUndo(
        `Dismiss ${before.length} staged move(s)`,
        before,
        before.map((s) => ({ ...s, staged_target: null }))
      );
      setPhotos((prev) => prev.map((p) => (p.staged_target ? { ...p, staged_target: null } : p)));
      setIsCommitModalOpen(false);
      if (smartFilter === "STAGED") setSmartFilter("ALL");
      addLog("DISK", `Dismissed ${count} staged move(s)`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleAutoOrganizeByPreset() {
    try {
      const updates = new Map<string, string>();
      const ops: { hash: string; target_subfolder: string | null }[] = [];
      for (const p of visiblePhotos) {
        const target = computePresetTargetFolder(p, autoStagePreset);
        if (!target) continue;
        ops.push({ hash: p.hash, target_subfolder: target });
        updates.set(p.hash, target);
      }
      if (ops.length === 0) {
        setAutoMatchNotice("None of the visible photos have the details this rule needs (date, place or person).");
        return;
      }
      const restaged = visiblePhotos.filter((p) => updates.has(p.hash) && p.staged_target).length;
      const ok = await confirmAction(
        `Stage ${ops.length} visible photo(s) into folders with this rule?` +
          (restaged > 0 ? `\n\n${restaged} of them are already staged elsewhere and will get the new target.` : "") +
          "\n\nNothing moves on disk until you Commit. You can undo this with Ctrl+Z.",
        "Stage photos"
      );
      if (!ok) return;
      const before = captureSnapshots(photos, Array.from(updates.keys()));
      await invoke("stage_photos_move", { ops });
      pushSnapshotUndo(
        `Auto-stage ${ops.length} photo(s)`,
        before,
        before.map((s) => ({ ...s, staged_target: updates.get(s.hash) ?? s.staged_target }))
      );
      setPhotos((prev) =>
        prev.map((p) => (updates.has(p.hash) ? { ...p, staged_target: updates.get(p.hash)! } : p))
      );
      addLog("DISK", `Auto-staged ${ops.length} photos using preset ${autoStagePreset}`);
    } catch (err) {
      setError(String(err));
    }
  }

  const isCommittingRef = useRef(false);
  async function handleCommitAllStaged() {
    if (!folder || isCommittingRef.current) return;
    isCommittingRef.current = true;
    try {
      const result = await invoke<CommitResult>("commit_staged_operations", {
        rootFolder: folder,
        smartRename: smartRenameOnCommit,
      });
      const res = await invoke<PhotoItem[]>("scan_folder", {
        folderPath: folder,
        forceReprocess: false,
      });
      setPhotos(res);
      setIsCommitModalOpen(false);
      addLog(
        "DISK",
        `Committed ${result.moved} physical file move(s) to disk`,
        smartRenameOnCommit ? "With Smart Chronological Rename" : "Original filenames"
      );
      for (const f of result.failures) {
        addLog("DISK", `Could not move ${f.file}`, f.error);
      }
      if (result.failures.length > 0) {
        setError(
          `${result.failures.length} file(s) could not be moved (they stay staged). See the Session Log for details.`
        );
      }
    } catch (err) {
      setError(String(err));
    } finally {
      isCommittingRef.current = false;
    }
  }

  // B toggles the basket for the selection; dropping photos on the Basket pins them (`pin` = true)
  async function handleToggleBasketSelection(targetHashes?: string[], pin?: boolean) {
    const hashes = resolveTargets(targetHashes);
    if (hashes.length === 0) return;
    try {
      const hashSet = new Set(hashes);
      const anyNotInBasket = pin ?? photos.some((p) => hashSet.has(p.hash) && !p.in_basket);
      const before = captureSnapshots(photos, hashSet);
      await invoke("set_photo_basket", { hashes, inBasket: anyNotInBasket });
      pushSnapshotUndo(
        `${anyNotInBasket ? "Pin" : "Unpin"} ${hashes.length} photo(s) ${anyNotInBasket ? "to" : "from"} Basket`,
        before,
        before.map((s) => ({ ...s, in_basket: anyNotInBasket }))
      );
      setPhotos((prev) =>
        prev.map((p) =>
          hashSet.has(p.hash) ? { ...p, in_basket: anyNotInBasket } : p
        )
      );
      addLog(
        "TRIAGE",
        `${anyNotInBasket ? "Pinned" : "Unpinned"} ${hashes.length} photo(s) ${
          anyNotInBasket ? "to" : "from"
        } Basket`
      );
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleMapPickCoordinates(lat: number, lon: number) {
    if (selectedHashes.size === 0) return;
    try {
      const hashes = expandWithRawPairs(Array.from(selectedHashes), photos);
      const hashSet = new Set(hashes);
      const location = await invoke<string>("set_manual_location", {
        hashes,
        location: "",
        latitude: lat,
        longitude: lon,
      });
      const value: LocationValue = { location, latitude: lat, longitude: lon };
      pushLocationUndo(`Map location on ${hashes.length} photo(s)`, hashes, () => value, value);
      // Patch just these photos (this used to rescan the whole folder)
      setPhotos((prev) => prev.map((p) => (hashSet.has(p.hash) ? { ...p, ...value } : p)));
      setIsPickingMapLocation(false);
      addLog("TRIAGE", `Assigned map GPS (${lat.toFixed(4)}, ${lon.toFixed(4)}) to ${hashes.length} photo(s)`);
      setAutoMatchNotice(
        `Assigned GPS (${lat.toFixed(4)}, ${lon.toFixed(4)}) to ${hashes.length} photo(s)!`
      );
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleShiftTimestamps(e: React.FormEvent) {
    e.preventDefault();
    if (selectedHashes.size === 0) return;
    const totalMinutes = shiftHoursInput * 60 + shiftMinutesInput;
    if (totalMinutes === 0) return;
    const applyShift = (rows: TimestampShiftResult[]) => {
      const map = new Map(rows.map((s) => [s.hash, s.captured_at]));
      setPhotos((prev) =>
        prev.map((p) => (map.has(p.hash) ? { ...p, captured_at: map.get(p.hash)! } : p))
      );
      refreshTimeline();
    };
    try {
      const hashes = Array.from(selectedHashes);
      const shifted = await invoke<TimestampShiftResult[]>("shift_capture_timestamps", {
        hashes,
        offsetMinutes: totalMinutes,
      });
      applyShift(shifted);
      const shiftedHashes = shifted.map((s) => s.hash);
      const label = `${totalMinutes > 0 ? `+${totalMinutes}` : totalMinutes} min`;
      if (shiftedHashes.length > 0) {
        pushCustomUndo(
          `Shift capture time ${label} on ${shiftedHashes.length} photo(s)`,
          shiftedHashes,
          async () =>
            applyShift(
              await invoke<TimestampShiftResult[]>("shift_capture_timestamps", {
                hashes: shiftedHashes,
                offsetMinutes: -totalMinutes,
              })
            ),
          async () =>
            applyShift(
              await invoke<TimestampShiftResult[]>("shift_capture_timestamps", {
                hashes: shiftedHashes,
                offsetMinutes: totalMinutes,
              })
            )
        );
      }
      setActiveBulkPopover(null);
      addLog("TRIAGE", `Shifted timestamps on ${shifted.length} photo(s) by ${totalMinutes} min`);
      setAutoMatchNotice(`Shifted ${shifted.length} timestamp(s) by ${label}.`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleOpenHealthDashboard() {
    try {
      setIsHealthModalOpen(true);
      const stats = await invoke<LibraryHealthStats>("get_library_health_stats", {
        rootFolder: folder || null,
      });
      setHealthStats(stats);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleExportXmp(onlySelected: boolean) {
    try {
      setIsExportingXmp(true);
      const hashes =
        onlySelected && selectedHashes.size > 0 ? Array.from(selectedHashes) : null;
      const res = await invoke<XmpExportResult>("export_xmp_sidecars", {
        hashes,
        rootFolder: folder || null,
      });
      const notes = [
        res.skipped_foreign > 0 &&
          `${res.skipped_foreign} skipped (sidecar from another app was kept)`,
        res.skipped_raw_pair > 0 && `${res.skipped_raw_pair} JPEG(s) covered by their RAW's sidecar`,
        res.failed > 0 && `${res.failed} failed to write`,
      ].filter(Boolean);
      const summary = `Exported ${res.exported} .xmp sidecar file(s)`;
      addLog("DISK", summary, notes.join(" · ") || undefined);
      setAutoMatchNotice(notes.length > 0 ? `${summary} — ${notes.join(", ")}` : `${summary}!`);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsExportingXmp(false);
    }
  }

  async function handlePruneCache() {
    try {
      const removed = await invoke<number>("prune_orphaned_cache");
      const stats = await invoke<LibraryHealthStats>("get_library_health_stats", {
        rootFolder: folder || null,
      });
      setHealthStats(stats);
      addLog("DISK", `Pruned ${removed} orphaned cache file(s)`);
      setAutoMatchNotice(`Pruned ${removed} orphaned cache file(s)!`);
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
      if (toTrash.length === 0) return;
      const ok = await confirmAction(
        `Keep the sharpest photo of each of the ${totalBurstGroups} burst groups and stage the other ${toTrash.length} photo(s) for _Trash?\n\nNothing is deleted until you Commit. You can undo this with Ctrl+Z.`,
        "Stage for _Trash"
      );
      if (!ok) return;
      const trashHashes = new Set(toTrash.map((p) => p.hash));
      const before = captureSnapshots(photos, trashHashes);
      const ops = toTrash.map((p) => ({ hash: p.hash, target_subfolder: "_Trash" }));
      await invoke("stage_photos_move", { ops });
      pushSnapshotUndo(
        `Keep sharpest: stage ${toTrash.length} photo(s) for _Trash`,
        before,
        before.map((s) => ({ ...s, staged_target: "_Trash" }))
      );
      setPhotos((prev) =>
        prev.map((p) => (trashHashes.has(p.hash) ? { ...p, staged_target: "_Trash" } : p))
      );
      addLog("TRIAGE", `Kept sharpest in all burst groups & staged ${toTrash.length} extras for _Trash`);
    } catch (err) {
      setError(String(err));
    }
  }

  // Native OS Context Menu Actions
  async function handleOpenInDefaultViewer(path: string) {
    try {
      await invoke("open_in_default_app", { path });
      addLog("LIBRARY", `Opened in default viewer: ${path.split(/[\\/]/).pop()}`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRevealInFileManager(path: string) {
    try {
      await invoke("reveal_in_file_manager", { path });
      addLog("LIBRARY", `Revealed in file manager: ${path}`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleCreateSubfolder(relativePath: string) {
    if (!folder || !relativePath.trim()) return;
    try {
      const created = await invoke<string>("create_library_subfolder", {
        rootFolder: folder,
        relativePath: relativePath.trim(),
      });
      addLog("DISK", `Created new subfolder: ${relativePath.trim()}`, created);
      setAutoMatchNotice(`Created folder: ${relativePath.trim()}`);
      await handleRescanFolder();
    } catch (err) {
      setError(String(err));
    }
  }

  // ---------- Smart search (CLIP) ----------
  const refreshSemanticStatus = useCallback(async (currentFolder: string) => {
    if (!currentFolder) return null;
    try {
      const status = await invoke<SemanticStatus>("semantic_status", { rootFolder: currentFolder });
      setSemanticStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const unlisten = listen<SemanticProgress>("semantic-progress", (event) => {
      const prog = event.payload;
      if (prog.done) {
        setSemanticProgress(null);
        refreshSemanticStatus(folderRef.current);
        if (prog.stage === "index" && prog.completed > 0) {
          addLog("AI", `Smart search: indexed ${prog.completed} of ${prog.total} photo(s)${prog.cancelled ? " (stopped)" : ""}`);
        }
      } else {
        setSemanticProgress(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog, refreshSemanticStatus]);

  async function startSemanticIndex(currentFolder = folder) {
    if (!currentFolder) return;
    try {
      await invoke<number>("start_semantic_index", { rootFolder: currentFolder });
    } catch (err) {
      setSemanticProgress(null);
      if (!String(err).includes(SEMANTIC_CANCELLED)) setError(`Smart search: ${String(err)}`);
    }
  }

  // Once the models are installed, new photos are indexed automatically after their thumbnails are made
  const thumbnailsBusy = progress !== null;
  useEffect(() => {
    if (!folder || !hasPhotos || thumbnailsBusy) return;
    const timer = setTimeout(async () => {
      const status = await refreshSemanticStatus(folder);
      if (status?.models_ready && !status.running && status.indexed < status.total) {
        startSemanticIndex(folder);
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [folder, hasPhotos, thumbnailsBusy, photos.length]);

  // Turning smart search on the first time downloads the models (asks first)
  async function toggleSmartSearch() {
    if (smartSearch) {
      setSmartSearch(false);
      if (semanticResult?.source.kind === "text") setSemanticResult(null);
      return;
    }
    const status = await refreshSemanticStatus(folder);
    if (status && !status.models_ready) {
      const ok = await ask(
        "Smart search finds photos by describing them, in Dutch, English and about 50 other languages (\"hond op het strand\", \"birthday cake\").\n\nIt needs a one-time download of about 470 MB of AI models, then indexes this library on your graphics card (about 1 minute per 5,000 photos). Everything stays on this computer.",
        { title: "Smart search", kind: "info", okLabel: "Download and index", cancelLabel: "Not now" }
      );
      if (!ok) return;
      addLog("AI", "Downloading the smart search models");
    }
    setSmartSearch(true);
    if (!status || status.indexed < status.total) startSemanticIndex(folder);
  }

  // Text queries: embedded after a short pause in typing; only the newest query may set the results
  const semanticSeqRef = useRef(0);
  useEffect(() => {
    const query = parseSearchQuery(searchQuery).text;
    if (!smartSearch || !query) return;
    const seq = ++semanticSeqRef.current;
    const timer = setTimeout(async () => {
      try {
        const hits = await invoke<SemanticHit[]>("semantic_search", { query });
        if (seq !== semanticSeqRef.current) return;
        setSemanticResult({
          source: { kind: "text", query },
          scores: new Map(hits.map((h) => [h.hash, h.score])),
        });
      } catch (err) {
        if (seq === semanticSeqRef.current) setError(`Smart search: ${String(err)}`);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, smartSearch]);

  async function handleFindSimilar(photo: PhotoItem) {
    try {
      const hits = await invoke<SemanticHit[]>("find_similar_photos", { hash: photo.hash });
      ++semanticSeqRef.current;
      setSemanticResult({
        source: { kind: "similar", hash: photo.hash, name: photo.name },
        scores: new Map(hits.map((h) => [h.hash, h.score])),
      });
      setViewMode("grid");
    } catch (err) {
      setError(String(err));
      if (semanticStatus?.models_ready === false) {
        setAutoMatchNotice('Turn on Smart search (the ✨ button in the search box) to index your photos first.');
      }
    }
  }

  function clearSemanticResult() {
    ++semanticSeqRef.current;
    setSemanticResult(null);
    if (smartSearch) setSearchQuery("");
  }

  async function handleCancelSemanticIndex() {
    try {
      await invoke("cancel_semantic_index");
    } catch (err) {
      setError(String(err));
    }
  }

  // ---------- Albums & smart albums ----------
  const refreshAlbums = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        invoke<Album[]>("get_albums"),
        invoke<SavedSearch[]>("get_saved_searches"),
      ]);
      setAlbums(a);
      setSavedSearches(s);
    } catch {}
  }, []);

  useEffect(() => {
    refreshAlbums();
  }, [refreshAlbums]);

  // Photos of each album that are in the open folder
  const albumCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const [id, set] of albumSets) {
      let n = 0;
      for (const h of set) if (photoByHash.has(h)) n++;
      counts.set(id, n);
    }
    return counts;
  }, [albumSets, photoByHash]);

  const patchAlbumHashes = (id: number, add: string[], remove: string[]) => {
    const removeSet = new Set(remove);
    setAlbums((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        const kept = a.hashes.filter((h) => !removeSet.has(h));
        const present = new Set(kept);
        return { ...a, hashes: [...kept, ...add.filter((h) => !present.has(h))] };
      })
    );
  };

  async function handleCreateAlbum(name: string, addHashes?: string[]) {
    try {
      const id = await invoke<number>("create_album", { name });
      setAlbums((prev) => [...prev, { id, name: name.trim(), hashes: [] }]);
      addLog("LIBRARY", `Created album "${name.trim()}"`);
      if (addHashes && addHashes.length > 0) await handleAddToAlbum(id, addHashes, name.trim());
      return id;
    } catch (err) {
      setError(String(err));
      return null;
    }
  }

  async function handleRenameAlbum(id: number, name: string) {
    try {
      await invoke("rename_album", { id, name });
      setAlbums((prev) => prev.map((a) => (a.id === id ? { ...a, name: name.trim() } : a)));
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDeleteAlbum(id: number) {
    const album = albums.find((a) => a.id === id);
    if (!album) return;
    const ok = await confirmAction(
      `Delete the album "${album.name}"?\n\nOnly the album goes; its ${album.hashes.length} photo(s) stay where they are.`,
      "Delete album"
    );
    if (!ok) return;
    try {
      await invoke("delete_album", { id });
      setAlbums((prev) => prev.filter((a) => a.id !== id));
      if (activeAlbumId === id) setActiveAlbumId(null);
      addLog("LIBRARY", `Deleted album "${album.name}"`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleAddToAlbum(id: number, targetHashes?: string[], albumName?: string) {
    const hashes = resolveTargets(targetHashes);
    const name = albumName ?? albums.find((a) => a.id === id)?.name ?? "album";
    if (hashes.length === 0) return;
    try {
      const added = await invoke<string[]>("add_to_album", { id, hashes });
      patchAlbumHashes(id, added, []);
      if (added.length > 0) {
        pushCustomUndo(
          `Add ${added.length} photo(s) to album "${name}"`,
          hashes,
          async () => {
            await invoke("remove_from_album", { id, hashes: added });
            patchAlbumHashes(id, [], added);
          },
          async () => {
            await invoke("add_to_album", { id, hashes: added });
            patchAlbumHashes(id, added, []);
          }
        );
      }
      addLog("LIBRARY", `Added ${added.length} photo(s) to album "${name}"`);
      setActiveBulkPopover(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRemoveFromAlbum(id: number, targetHashes?: string[]) {
    const hashes = resolveTargets(targetHashes);
    const name = albums.find((a) => a.id === id)?.name ?? "album";
    if (hashes.length === 0) return;
    try {
      const removed = await invoke<string[]>("remove_from_album", { id, hashes });
      patchAlbumHashes(id, [], removed);
      if (removed.length > 0) {
        pushCustomUndo(
          `Remove ${removed.length} photo(s) from album "${name}"`,
          hashes,
          async () => {
            await invoke("add_to_album", { id, hashes: removed });
            patchAlbumHashes(id, removed, []);
          },
          async () => {
            await invoke("remove_from_album", { id, hashes: removed });
            patchAlbumHashes(id, [], removed);
          }
        );
      }
      addLog("LIBRARY", `Removed ${removed.length} photo(s) from album "${name}"`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaveSearch(name: string) {
    try {
      const id = await invoke<number>("save_search", { name, query: searchQuery });
      setSavedSearches((prev) => [...prev, { id, name: name.trim(), query: searchQuery.trim() }]);
      setAutoMatchNotice(`Saved smart album "${name.trim()}": it updates by itself as your photos change.`);
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }

  async function handleDeleteSavedSearch(id: number) {
    try {
      await invoke("delete_saved_search", { id });
      setSavedSearches((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(String(err));
    }
  }

  function runSavedSearch(saved: SavedSearch) {
    setActiveAlbumId(null);
    setSearchQuery(saved.query);
  }

  // ---------- Export ----------
  // Photos chosen for the export dialog (null = dialog closed); RAW+JPEG pairs are not expanded here,
  // so one shot gives one exported file
  const [exportTargets, setExportTargets] = useState<string[] | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);

  useEffect(() => {
    const unlisten = listen<ExportProgress>("export-progress", (event) => {
      setExportProgress(event.payload.done ? null : event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  function openExport(targetHashes?: string[]) {
    const hashes = targetHashes ?? Array.from(selectedHashes);
    if (hashes.length === 0) {
      setAutoMatchNotice("Select the photos to export first.");
      return;
    }
    setExportTargets(hashes);
  }

  async function runExport(settings: ExportSettings) {
    const hashes = exportTargets ?? [];
    setExportTargets(null);
    if (hashes.length === 0) return;
    setExportProgress({ completed: 0, total: hashes.length, done: false, cancelled: false });
    try {
      const result = await invoke<ExportResult>("export_photos", {
        options: {
          hashes,
          dest_dir: settings.destDir,
          long_edge: settings.longEdge,
          quality: settings.quality,
          strip_gps: settings.stripGps,
        },
      });
      for (const f of result.failures) addLog("DISK", `Could not export ${f.file}`, f.error);
      addLog("DISK", `Exported ${result.exported} photo(s)`, settings.destDir);
      if (result.failures.length > 0) {
        setError(`${result.failures.length} photo(s) could not be exported. See the Session Log.`);
      }
      setAutoMatchNotice(
        `${result.cancelled ? "Export stopped: " : ""}${result.exported} photo(s) exported to ${settings.destDir}`
      );
    } catch (err) {
      setError(`Export failed: ${String(err)}`);
    } finally {
      setExportProgress(null);
    }
  }

  async function handleCancelExport() {
    try {
      await invoke("cancel_export");
    } catch {}
  }

  // ---------- People: rename / merge / hide ----------
  async function handleRenamePerson(oldName: string, newName: string) {
    const target = newName.trim();
    if (!target || target === oldName) return null;
    const merging = people.some(
      (p) => p.name.toLowerCase() === target.toLowerCase() && p.name.toLowerCase() !== oldName.toLowerCase()
    );
    if (merging) {
      const ok = await confirmAction(
        `"${target}" already exists. Merge "${oldName}" into "${target}"?\n\nAll photos, named faces and rejections of "${oldName}" move to "${target}".`,
        "Merge"
      );
      if (!ok) return null;
    }
    try {
      const finalName = await invoke<string>("rename_person", { oldName, newName: target });
      const old = oldName.toLowerCase();
      setPhotos((prev) =>
        prev.map((p) => {
          const hasOld = p.people.some((n) => n.toLowerCase() === old) || p.faces.some((f) => f.person_name?.toLowerCase() === old);
          if (!hasOld) return p;
          return {
            ...p,
            people: Array.from(new Set(p.people.map((n) => (n.toLowerCase() === old ? finalName : n)))).sort(),
            faces: p.faces.map((f) => (f.person_name?.toLowerCase() === old ? { ...f, person_name: finalName } : f)),
          };
        })
      );
      if (selectedPerson?.toLowerCase() === old) setSelectedPerson(finalName);
      addLog("FACE", merging ? `Merged "${oldName}" into "${finalName}"` : `Renamed "${oldName}" to "${finalName}"`);
      await refreshPeople();
      return finalName;
    } catch (err) {
      setError(String(err));
      return null;
    }
  }

  async function handleSetPersonHidden(name: string, hidden: boolean) {
    try {
      await invoke("set_person_hidden", { name, hidden });
      if (hidden && selectedPerson === name) setSelectedPerson(null);
      addLog("FACE", `${hidden ? "Hid" : "Unhid"} "${name}"`);
      await refreshPeople();
    } catch (err) {
      setError(String(err));
    }
  }

  // Latest photos for the long-running AI loop (the tag vocabulary is recomputed from the live library)
  const photosRef = useRef(photos);
  photosRef.current = photos;

  function applyAiResults(results: Map<string, AiAnalysisResult>) {
    if (results.size === 0) return;
    setPhotos((prev) =>
      prev.map((p) => {
        const res = results.get(p.hash);
        return res
          ? {
              ...p,
              tags: res.tags,
              people: res.people,
              faces: res.faces,
              ai_caption: res.caption,
              ocr_text: res.ocr_text,
            }
          : p;
      })
    );
  }

  async function handleAiAnalyzeSingle() {
    if (!activePhoto || analyzingHashes.has(activePhoto.hash)) return;
    if (aiBatchProgress) {
      // Ollama handles one request at a time: a single analysis would just queue behind the batch
      setError("Batch AI is running: wait for it to finish or stop it first.");
      return;
    }
    if (ollamaStatus && !ollamaStatus.running) {
      setError('Ollama is not running: click "Start Ollama" in the header first.');
      return;
    }
    const photo = activePhoto;
    try {
      setAnalyzingHashes((prev) => new Set(prev).add(photo.hash));
      const res = await invoke<AiAnalysisResult>("ai_analyze_photo", {
        hash: photo.hash,
        imagePathForAi: diskPathOf(photo),
        modelName: aiModel,
        existingTags: topLibraryTags(photosRef.current),
      });
      applyAiResults(new Map([[photo.hash, res]]));
      addLog("AI", `AI analyzed ${photo.name}`, `${res.tags.length} tags generated`);
      addLog("PERF", `AI analysis (${aiModel}): ${photo.name}`, summarizeAiPerf([res.perf]));
    } catch (err) {
      if (!String(err).includes(AI_CANCELLED)) {
        setError(`AI Error on ${photo.name}: ${String(err)}`);
      }
    } finally {
      setAnalyzingHashes((prev) => {
        const next = new Set(prev);
        next.delete(photo.hash);
        return next;
      });
    }
  }

  // Stop: also aborts the request Ollama is working on right now (it stops generating)
  async function handleStopAiBatch() {
    cancelBatchRef.current = true;
    setAiBatchProgress((p) => (p ? { ...p, stopping: true } : p));
    try {
      await invoke("cancel_ai_analysis");
    } catch {}
  }

  // Batch AI runner: one request at a time (qwen3-vl can't run requests in parallel in Ollama), with the next
  // photo's image prepared while the current one is analysed, retries for real failures, and batched UI updates.
  // Photos that already have AI results are skipped unless the user chooses to re-analyse them.
  async function runBatchAiOnList(requested: PhotoItem[], options: { reanalyze?: boolean } = {}) {
    if (aiBatchProgress || requested.length === 0) return;
    if (ollamaStatus && !ollamaStatus.running) {
      setError('Ollama is not running: click "Start Ollama" in the header first.');
      return;
    }

    let targets = requested;
    if (!options.reanalyze) {
      const analyzed = requested.filter((p) => p.ai_caption);
      if (analyzed.length > 0) {
        const fresh = requested.length - analyzed.length;
        const redo = await ask(
          fresh > 0
            ? `${analyzed.length} of these ${requested.length} photos already have AI results. Analyse those again as well? Their caption, text and tags will be replaced.\n\nChoose "Only new photos" to analyse just the ${fresh} photo(s) without results.`
            : `All ${requested.length} photo(s) already have AI results. Analyse them again? Their caption, text and tags will be replaced.`,
          {
            title: "Batch AI",
            kind: "info",
            okLabel: "Analyse again",
            cancelLabel: fresh > 0 ? "Only new photos" : "Cancel",
          }
        );
        if (!redo) targets = requested.filter((p) => !p.ai_caption);
      }
    }
    if (targets.length === 0) return;

    cancelBatchRef.current = false;
    setAiBatchReport(null);
    setAiBatchProgress({
      current: 0,
      total: targets.length,
      succeeded: 0,
      failed: 0,
      currentFile: targets[0]?.name,
      startedAt: Date.now(),
    });

    addLog("AI", `Started Batch AI on ${targets.length} photo(s) using ${aiModel}`);

    const batchStartedAt = performance.now();
    const batchPerfs: AiPerf[] = [];
    let completedCount = 0;
    let succeededCount = 0;
    let stopped = false;
    const failures: AiFailureItem[] = [];
    const MAX_ATTEMPTS = 3;

    // Results reach the grid in batches (every ~0.5 s) instead of one full re-render per photo
    const pending = new Map<string, AiAnalysisResult>();
    let lastFlush = performance.now();
    const flush = () => {
      applyAiResults(new Map(pending));
      pending.clear();
      lastFlush = performance.now();
    };

    for (let i = 0; i < targets.length; i++) {
      if (cancelBatchRef.current) break;
      const photo = targets[i];

      // Prepare the next photo's 896px image while Ollama works on this one
      const next = targets[i + 1];
      if (next) {
        invoke("prepare_ai_image", { hash: next.hash, imagePath: diskPathOf(next) }).catch(() => {});
      }

      setAnalyzingHashes((prev) => new Set(prev).add(photo.hash));
      setAiBatchProgress((p) => (p ? { ...p, currentFile: photo.name } : p));

      let attempt = 0;
      let success = false;
      let lastErr = "";

      while (attempt < MAX_ATTEMPTS && !success && !cancelBatchRef.current) {
        attempt++;
        try {
          const res = await invoke<AiAnalysisResult>("ai_analyze_photo", {
            hash: photo.hash,
            imagePathForAi: diskPathOf(photo),
            modelName: aiModel,
            existingTags: topLibraryTags(photosRef.current),
          });
          success = true;
          succeededCount++;
          batchPerfs.push(res.perf);
          pending.set(photo.hash, res);
        } catch (err) {
          lastErr = String(err);
          if (lastErr.includes(AI_CANCELLED)) {
            stopped = true;
            break;
          }
          if (attempt < MAX_ATTEMPTS && !cancelBatchRef.current) {
            await new Promise((r) => setTimeout(r, 450 * attempt));
          }
        }
      }

      setAnalyzingHashes((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(photo.hash);
        return nextSet;
      });
      if (stopped || cancelBatchRef.current) break;

      if (!success) {
        failures.push({
          photo,
          error: lastErr || "Unknown AI error",
          attempts: attempt,
        });
      }

      completedCount++;
      setAiBatchProgress((p) =>
        p ? { ...p, current: completedCount, succeeded: succeededCount, failed: failures.length } : p
      );
      if (performance.now() - lastFlush >= 500) flush();
    }

    flush();
    setAnalyzingHashes(new Set());
    setAiBatchProgress(null);

    const wasStopped = stopped || cancelBatchRef.current;
    addLog(
      "AI",
      wasStopped
        ? `Stopped Batch AI after ${completedCount} of ${targets.length} photo(s): ${succeededCount} succeeded, ${failures.length} failed`
        : `Finished Batch AI: ${succeededCount} succeeded, ${failures.length} failed`
    );

    if (batchPerfs.length > 0) {
      const wallSeconds = (performance.now() - batchStartedAt) / 1000;
      const perMinute = (succeededCount / (wallSeconds / 60)).toFixed(1);
      addLog(
        "PERF",
        `Batch AI (${aiModel}): ${succeededCount} photos in ${wallSeconds.toFixed(1)} s · ${perMinute} photos/min`,
        summarizeAiPerf(batchPerfs)
      );
    }

    if (targets.length > 1 || failures.length > 0) {
      setAiBatchReport({
        succeededCount,
        failures,
      });
    }
  }

  return {
    isAppReady,
    folder,
    setFolder,
    photos,
    setPhotos,
    people,
    selectedPerson,
    setSelectedPerson,
    pendingFaceCounts,
    faceReviewPerson,
    setFaceReviewPerson,
    trips,
    photoByHash,
    smartFilter,
    setSmartFilter,
    orientationFilter,
    setOrientationFilter,
    activeSubfolder,
    setActiveSubfolder,
    activeEvent,
    setActiveEvent,
    activeTag,
    setActiveTag,
    searchQuery,
    setSearchQuery,
    sortBy,
    setSortBy,
    isTimelineOpen,
    setIsTimelineOpen,
    timelineBuckets,
    selectedPeriodRange,
    setSelectedPeriodRange,
    dragAnchorDay,
    setDragAnchorDay,
    isEditingInspectorLocation,
    setIsEditingInspectorLocation,
    inspectorLocationQuery,
    setInspectorLocationQuery,
    faceScanProgress,
    scanProgress,
    isDetectingSingleFace,
    autoAdvance,
    setAutoAdvance,
    showAllBurstVersions,
    setShowAllBurstVersions,
    expandedBurstGroups,
    setExpandedBurstGroups,
    zoomLevel,
    setZoomLevel,
    viewMode,
    setViewMode,
    selectedHashes,
    setSelectedHashes,
    activeHash,
    setActiveHash,
    selectionAnchorHashRef,
    isLoupeOpen,
    setIsLoupeOpen,
    isCommitModalOpen,
    setIsCommitModalOpen,
    smartRenameOnCommit,
    setSmartRenameOnCommit,
    autoStagePreset,
    setAutoStagePreset,
    compareZoom,
    setCompareZoom,
    comparePan,
    setComparePan,
    isPickingMapLocation,
    setIsPickingMapLocation,
    shiftHoursInput,
    setShiftHoursInput,
    shiftMinutesInput,
    setShiftMinutesInput,
    isHealthModalOpen,
    setIsHealthModalOpen,
    healthStats,
    isExportingXmp,
    sessionLogs,
    addLog,
    clearSessionLogs,
    isSessionLogModalOpen,
    setIsSessionLogModalOpen,
    aiBatchReport,
    setAiBatchReport,
    activeBulkPopover,
    setActiveBulkPopover,
    bulkInput,
    setBulkInput,
    citySearchResults,
    setCitySearchResults,
    cityQuery,
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
    toasts,
    dismissToast,
    setAutoMatchNotice,
    isScanningFolder,
    expandedFolders,
    setExpandedFolders,
    ollamaStatus,
    setOllamaStatus,
    aiModel,
    setAiModel,
    analyzingHashes,
    isLoadingVram,
    setIsLoadingVram,
    aiBatchProgress,
    cancelBatchRef,
    progress,
    setError,
    tagInput,
    setTagInput,
    folderTree,
    autoEvents,
    handleRenameTrip,
    allLibraryTags,
    stagedPhotos,
    gpsPhotosCount,
    screenshotPhotosCount,
    picksCount,
    rejectsCount,
    basketCount,
    sharpestInGroup,
    burstGroupCounts,
    totalBurstGroups,
    duplicatePhotosCount,
    visiblePhotos,
    activePhoto,
    comparePhotos,
    compareCandidateCount,
    handlePhotoClick,
    toggleBurstGroupExpand,
    clearAllFilters,
    parsedSearch,
    albums,
    albumCounts,
    savedSearches,
    activeAlbumId,
    setActiveAlbumId,
    handleCreateAlbum,
    handleRenameAlbum,
    handleDeleteAlbum,
    handleAddToAlbum,
    handleRemoveFromAlbum,
    handleSaveSearch,
    handleDeleteSavedSearch,
    runSavedSearch,
    exportTargets,
    setExportTargets,
    exportProgress,
    openExport,
    runExport,
    handleCancelExport,
    handleRenamePerson,
    handleSetPersonHidden,
    smartSearch,
    toggleSmartSearch,
    semanticResult,
    semanticScores,
    semanticStatus,
    semanticProgress,
    startSemanticIndex,
    handleFindSimilar,
    clearSemanticResult,
    handleCancelSemanticIndex,
    handleOpenFolder,
    handleRescanFolder,
    handleRescanAndProcessFolder,
    handleForceRescanExifSelected,
    handleDetectFacesSingleOnnx,
    handleBatchScanFacesOnnx,
    handleCancelFaceScan,
    handleCancelOperation,
    handleCancelThumbnails,
    faceModelDownload,
    handleSetFlag,
    handleRejectToTrash,
    handleKeepAndTrashRest,
    handleSetColorLabel,
    handleRotateSelection,
    handleBatchRate,
    handleBatchAddTag,
    handleBatchStageMove,
    handleSearchCities,
    handleAssignCity,
    handleAssignCustomLocationText,
    handleSaveFaceAndAutomatch,
    handleBatchAssignPerson,
    refreshPeople,
    handleDismissAllStaged,
    handleAutoOrganizeByPreset,
    handleCommitAllStaged,
    handleToggleBasketSelection,
    handleMapPickCoordinates,
    handleShiftTimestamps,
    handleOpenHealthDashboard,
    handleExportXmp,
    handlePruneCache,
    handleKeepSharpestInAllGroups,
    handleOpenInDefaultViewer,
    handleRevealInFileManager,
    handleCreateSubfolder,
    handleAiAnalyzeSingle,
    runBatchAiOnList,
    handleStopAiBatch,
    recentFolders,
    simpleMode,
    toggleSimpleMode,
    gridStyle,
    setGridStyle,
    cardDetails,
    setCardDetails,
    isShortcutsModalOpen,
    setIsShortcutsModalOpen,
    ollamaPullProgress,
    handleLoadFolderPath,
    handlePullDefaultAiModel,
    handleEmptyTrashToRecycleBin,
    canUndo: undo.canUndo,
    canRedo: undo.canRedo,
    handleUndo: undo.handleUndo,
    handleRedo: undo.handleRedo,
  };
}

export type LibraryState = ReturnType<typeof useLibraryState>;
