import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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
  XmpExportResult,
  CommitResult,
  TrashResult,
  OllamaPullProgress,
  ScanProgressEvent,
  AiFailureItem,
  AiBatchReport,
  SessionLogEntry,
  PhotoActionSnapshot,
  UndoHistoryEntry,
} from "../types/lumina";
import {
  buildFolderTree,
  getPhotoEventName,
  computePresetTargetFolder,
} from "../utils/photoHelpers";
import { expandWithRawPairs, diskPathOf, RAW_OR_HEIC_NAME } from "../utils/rawPairs";

const MAX_UNDO_STEPS = 20;

// Windows paths: compare case-insensitively and ignore a trailing separator
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
  setAutoMatchNotice: React.Dispatch<React.SetStateAction<string>>
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
          await applySnapshotsToBackend(last.before, changedSnapshotFields(last), setPhotos);
        } catch (err) {
          setAutoMatchNotice(`Undo failed (${last.description}): ${String(err)}`);
          setTimeout(() => setAutoMatchNotice(""), 5000);
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
        setTimeout(() => setAutoMatchNotice(""), 3000);
      }),
    [enqueue, bump, setPhotos, setActiveHash, setSelectedHashes, setAutoMatchNotice]
  );

  const handleRedo = useCallback(
    () =>
      enqueue(async () => {
        const next = redoRef.current[redoRef.current.length - 1];
        if (!next) return;
        try {
          await applySnapshotsToBackend(next.after, changedSnapshotFields(next), setPhotos);
        } catch (err) {
          setAutoMatchNotice(`Redo failed (${next.description}): ${String(err)}`);
          setTimeout(() => setAutoMatchNotice(""), 5000);
          return;
        }
        redoRef.current = redoRef.current.slice(0, -1);
        undoRef.current = [...undoRef.current, next];
        bump();
        setAutoMatchNotice(`Redid: ${next.description}`);
        setTimeout(() => setAutoMatchNotice(""), 3000);
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
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState<boolean>(false);
  const [ollamaPullProgress, setOllamaPullProgress] = useState<OllamaPullProgress | null>(null);
  const [people, setPeople] = useState<PersonItem[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [pendingFaceCounts, setPendingFaceCounts] = useState<Record<string, number>>({});
  const [faceReviewPerson, setFaceReviewPerson] = useState<string | null>(null);

  const [smartFilter, setSmartFilter] = useState<SmartFilter>("ALL");
  const [orientationFilter, setOrientationFilter] = useState<OrientationFilter>("ALL");
  const [activeSubfolder, setActiveSubfolder] = useState<string>("ALL");
  const [activeEvent, setActiveEvent] = useState<string>("ALL");
  const [activeTag, setActiveTag] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
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
  const [viewMode, setViewMode] = useState<"grid" | "map" | "compare">("grid");
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
    "tag" | "person" | "move" | "location" | "time" | null
  >(null);
  const [bulkInput, setBulkInput] = useState<string>("");
  const [citySearchResults, setCitySearchResults] = useState<CitySearchResult[]>([]);

  // Interactive Face Box State
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(null);
  const [isDrawingFace, setIsDrawingFace] = useState<boolean>(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawnBox, setDrawnBox] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null
  );
  const [faceNameInput, setFaceNameInput] = useState<string>("");
  const [autoMatchNotice, setAutoMatchNotice] = useState<string>("");
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
  } | null>(null);
  const cancelBatchRef = useRef<boolean>(false);

  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [error, setError] = useState<string>("");
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
        setTimeout(() => setAutoMatchNotice(""), 5000);
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
          `Auto-matched "${person_name}" across ${total_matched} other verified face${
            total_matched === 1 ? "" : "s"
          }!`
        );
        addLog("FACE", `Auto-matched "${person_name}" across ${total_matched} photo(s)`);
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
          setTimeout(() => setAutoMatchNotice(""), 6000);
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
          return (
            (b.captured_at || "").localeCompare(a.captured_at || "") ||
            a.name.localeCompare(b.name)
          );
        case "DATE_ASC":
          return (
            (a.captured_at || "9999").localeCompare(b.captured_at || "9999") ||
            a.name.localeCompare(b.name)
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
      setError("");
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
        total: 100,
        percent: 5,
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
      setError(String(err));
    }
  }

  async function handleOpenFolder() {
    try {
      setError("");
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
      setError("");
      addLog("AI", `Started downloading Ollama model: ${modelToPull}`);
      await invoke<string>("pull_ollama_model", { modelName: modelToPull });
      const s = await invoke<OllamaStatus>("check_ollama_status");
      setOllamaStatus(s);
      setAiModel(modelToPull);
    } catch (err) {
      setOllamaPullProgress(null);
      setError(String(err));
    }
  }

  async function handleEmptyTrashToRecycleBin() {
    if (!folder) return;
    try {
      setError("");
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
        setTimeout(() => setAutoMatchNotice(""), 4500);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRescanFolder() {
    if (!folder || isScanningFolder) return;
    try {
      setError("");
      setIsScanningFolder(true);
      setScanProgress({
        stage: "Quick Rescanning folder...",
        current_file: folder,
        completed: 0,
        total: 100,
        percent: 10,
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
      setError(String(err));
    } finally {
      setIsScanningFolder(false);
      setScanProgress(null);
    }
  }

  async function handleRescanAndProcessFolder() {
    if (!folder || isScanningFolder) return;
    try {
      setError("");
      setIsScanningFolder(true);
      setScanProgress({
        stage: "Deep Reprocessing thumbnails, dHash & focus scores...",
        current_file: folder,
        completed: 0,
        total: 100,
        percent: 10,
        done: false,
      });
      const res = await invoke<PhotoItem[]>("scan_folder", {
        folderPath: folder,
        forceReprocess: true,
      });
      setPhotos(res);
      addLog("LIBRARY", `Deep reprocessed library (${res.length} items)`, folder);
    } catch (err) {
      setError(String(err));
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
      setError("");
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
        setTimeout(() => setAutoMatchNotice(""), 4500);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDetectFacesSingleOnnx() {
    if (!activePhoto || isDetectingSingleFace) return;
    try {
      setError("");
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
      setTimeout(() => setAutoMatchNotice(""), 4000);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsDetectingSingleFace(false);
    }
  }

  async function handleBatchScanFacesOnnx() {
    if (faceScanProgress || photos.length === 0) return;
    try {
      setError("");
      const hashes = photos.map((p) => p.hash);
      // Unconfirmed faces are replaced photo by photo as results arrive (face-scan-progress),
      // so a cancelled scan leaves the photos it never reached untouched.
      setPendingFaceCounts({});
      setFaceScanProgress({
        completed: 0,
        total: hashes.length,
        faces_found: 0,
        auto_matched: 0,
        done: false,
        cancelled: false,
      });
      addLog("FACE", `Started full ONNX Face Rescan on ${hashes.length} photos`);
      await invoke<number>("scan_library_faces_batch", { hashes });
    } catch (err) {
      setFaceScanProgress(null);
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
      const hashSet = new Set(hashes);
      const clean = await invoke<string>("add_tag_batch", { hashes, tag });
      setPhotos((prev) =>
        prev.map((p) =>
          hashSet.has(p.hash) && !p.tags.includes(clean)
            ? { ...p, tags: [...p.tags, clean].sort() }
            : p
        )
      );
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
      addLog("TRIAGE", `Assigned location "${locStr}" to ${targets.length} photo(s)`);
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
            ? {
                ...p,
                location: clean,
                latitude: clean ? p.latitude : null,
                longitude: clean ? p.longitude : null,
              }
            : p
        )
      );
      addLog("TRIAGE", `Set custom location "${clean || "cleared"}" on ${targets.length} photo(s)`);
      setIsEditingInspectorLocation(false);
      setActiveBulkPopover(null);
      setInspectorLocationQuery("");
      setBulkInput("");
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
      setError("");
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

  async function handleBatchAssignPerson(personName: string) {
    const clean = personName.trim();
    if (!clean || selectedHashes.size === 0) return;
    try {
      const hashes = expandWithRawPairs(Array.from(selectedHashes), photos);
      const hashSet = new Set(hashes);
      for (const h of hashes) {
        await invoke<string[]>("add_person_to_photo", { hash: h, name: clean });
      }
      setPhotos((prev) =>
        prev.map((p) =>
          hashSet.has(p.hash) && !p.people.includes(clean)
            ? { ...p, people: [...p.people, clean].sort() }
            : p
        )
      );
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
      const count = await invoke<number>("clear_all_staged", { rootFolder: folder || null });
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
      if (ops.length > 0) {
        await invoke("stage_photos_move", { ops });
        setPhotos((prev) =>
          prev.map((p) =>
            updates.has(p.hash) ? { ...p, staged_target: updates.get(p.hash)! } : p
          )
        );
        addLog("DISK", `Auto-staged ${ops.length} photos using preset ${autoStagePreset}`);
      }
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

  async function handleToggleBasketSelection() {
    if (selectedHashes.size === 0) return;
    try {
      const hashes = expandWithRawPairs(Array.from(selectedHashes), photos);
      const hashSet = new Set(hashes);
      const anyNotInBasket = photos.some((p) => hashSet.has(p.hash) && !p.in_basket);
      await invoke("set_photo_basket", { hashes, inBasket: anyNotInBasket });
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
      addLog("TRIAGE", `Assigned map GPS (${lat.toFixed(4)}, ${lon.toFixed(4)}) to ${hashes.length} photo(s)`);
      setAutoMatchNotice(
        `Assigned GPS (${lat.toFixed(4)}, ${lon.toFixed(4)}) to ${hashes.length} photo(s)!`
      );
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
      addLog("TRIAGE", `Shifted timestamps on ${shifted.length} photo(s) by ${totalMinutes} min`);
      setAutoMatchNotice(
        `Shifted ${shifted.length} timestamp(s) by ${
          totalMinutes > 0 ? `+${totalMinutes}` : totalMinutes
        } min.`
      );
      setTimeout(() => setAutoMatchNotice(""), 4000);
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
      setTimeout(() => setAutoMatchNotice(""), 6000);
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
      if (toTrash.length === 0) return;
      const ops = toTrash.map((p) => ({ hash: p.hash, target_subfolder: "_Trash" }));
      await invoke("stage_photos_move", { ops });
      setPhotos((prev) =>
        prev.map((p) =>
          p.duplicate_group &&
          p.subfolder !== "_Trash" &&
          sharpestInGroup.get(p.duplicate_group)?.hash !== p.hash
            ? { ...p, staged_target: "_Trash" }
            : p
        )
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
      setTimeout(() => setAutoMatchNotice(""), 3500);
      await handleRescanFolder();
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
      addLog("AI", `AI analyzed ${activePhoto.name}`, `${res.tags.length} tags generated`);
      addLog("PERF", `AI analysis (${aiModel}): ${activePhoto.name}`, summarizeAiPerf([res.perf]));
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

  // Resilient Batch AI Runner with Automatic Retry (up to 3 attempts) & Post-Run Report Modal
  async function runBatchAiOnList(targets: PhotoItem[]) {
    if (aiBatchProgress || targets.length === 0) return;

    cancelBatchRef.current = false;
    setError("");
    setAiBatchReport(null);
    setAiBatchProgress({
      current: 0,
      total: targets.length,
      succeeded: 0,
      failed: 0,
      currentFile: targets[0]?.name,
    });

    addLog("AI", `Started Batch AI on ${targets.length} photo(s) using ${aiModel}`);

    const batchStartedAt = performance.now();
    const batchPerfs: AiPerf[] = [];
    let completedCount = 0;
    let succeededCount = 0;
    const failures: AiFailureItem[] = [];
    const MAX_ATTEMPTS = 3;

    for (let i = 0; i < targets.length; i++) {
      if (cancelBatchRef.current) break;
      const photo = targets[i];

      setAnalyzingHashes((prev) => new Set(prev).add(photo.hash));
      setAiBatchProgress({
        current: completedCount,
        total: targets.length,
        succeeded: succeededCount,
        failed: failures.length,
        currentFile: photo.name,
      });

      let attempt = 0;
      let success = false;
      let lastErr = "";

      while (attempt < MAX_ATTEMPTS && !success && !cancelBatchRef.current) {
        attempt++;
        try {
          const res = await invoke<AiAnalysisResult>("ai_analyze_photo", {
            hash: photo.hash,
            imagePathForAi: photo.path,
            modelName: aiModel,
            existingTags: allLibraryTags,
          });
          success = true;
          succeededCount++;
          batchPerfs.push(res.perf);
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
          lastErr = String(err);
          if (attempt < MAX_ATTEMPTS && !cancelBatchRef.current) {
            await new Promise((r) => setTimeout(r, 450 * attempt));
          }
        }
      }

      if (!success && !cancelBatchRef.current) {
        failures.push({
          photo,
          error: lastErr || "Unknown AI error",
          attempts: attempt,
        });
      }

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
        failed: failures.length,
        currentFile: photo.name,
      });

      if (succeededCount > 0 && completedCount % 6 === 0) {
        refreshPeople();
      }
    }

    setAnalyzingHashes(new Set());
    setAiBatchProgress(null);
    refreshPeople();

    addLog(
      "AI",
      `Finished Batch AI: ${succeededCount} succeeded, ${failures.length} failed`
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
    autoMatchNotice,
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
    error,
    setError,
    tagInput,
    setTagInput,
    folderTree,
    autoEvents,
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
    handlePhotoClick,
    toggleBurstGroupExpand,
    handleOpenFolder,
    handleRescanFolder,
    handleRescanAndProcessFolder,
    handleForceRescanExifSelected,
    handleDetectFacesSingleOnnx,
    handleBatchScanFacesOnnx,
    handleCancelFaceScan,
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
    recentFolders,
    simpleMode,
    toggleSimpleMode,
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
