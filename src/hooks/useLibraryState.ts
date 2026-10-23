import { useState, useEffect, useMemo, useRef } from "react";
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
} from "../types/lumina";
import {
  buildFolderTree,
  getPhotoEventName,
  computePresetTargetFolder,
} from "../utils/photoHelpers";

export function useLibraryState() {
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

  // Slide-Out Timeline Slicer State
  const [isTimelineOpen, setIsTimelineOpen] = useState<boolean>(false);
  const [timelineBuckets, setTimelineBuckets] = useState<TimelineBucket[]>([]);
  const [selectedPeriodRange, setSelectedPeriodRange] = useState<[string, string] | null>(null);
  const [dragAnchorDay, setDragAnchorDay] = useState<string | null>(null);

  // Inspector Single-Photo Location Editor State
  const [isEditingInspectorLocation, setIsEditingInspectorLocation] = useState<boolean>(false);
  const [inspectorLocationQuery, setInspectorLocationQuery] = useState<string>("");

  // Neural ONNX Face Scanner Progress State
  const [faceScanProgress, setFaceScanProgress] = useState<FaceScanProgress | null>(null);
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
  const lastSelectedIndexRef = useRef<number | null>(null);

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
  } | null>(null);
  const cancelBatchRef = useRef<boolean>(false);

  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [error, setError] = useState<string>("");
  const [tagInput, setTagInput] = useState<string>("");

  // Poll Ollama status
  useEffect(() => {
    async function checkStatus() {
      try {
        const s = await invoke<OllamaStatus>("check_ollama_status");
        setOllamaStatus(s);
        if (
          s.installed_models.length > 0 &&
          !s.installed_models.some((m) => m.name === aiModel)
        ) {
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
    const unlisten = listen<FaceScanProgress>("face-scan-progress", (event) => {
      const prog = event.payload;

      if (prog.batch_faces && Object.keys(prog.batch_faces).length > 0) {
        const facesMap = prog.batch_faces;
        const peopleMap = prog.batch_people || {};
        setPhotos((prev) =>
          prev.map((p) => {
            const updatedFaces = facesMap[p.hash];
            if (!updatedFaces) return p;
            const extraPeople = peopleMap[p.hash] || [];
            const mergedPeople =
              extraPeople.length > 0
                ? Array.from(new Set([...p.people, ...extraPeople])).sort()
                : p.people;
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
        setAutoMatchNotice(
          `Neural ONNX Face Scan complete: detected ${prog.faces_found} human face(s)` +
            (prog.auto_matched > 0 ? ` & auto-matched ${prog.auto_matched} photo(s)!` : "!")
        );
        setTimeout(() => setAutoMatchNotice(""), 6000);
        refreshPeople(folder);
      } else {
        setFaceScanProgress(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [folder]);

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
  const gpsPhotosCount = useMemo(
    () => photos.filter((p) => p.latitude != null && p.longitude != null).length,
    [photos]
  );
  const screenshotPhotosCount = useMemo(
    () => photos.filter((p) => p.tags.includes("screenshot")).length,
    [photos]
  );
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

  const activePhoto = useMemo(
    () => photos.find((p) => p.hash === activeHash) || null,
    [photos, activeHash]
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
    setSelectedFaceId(null);
    setDrawnBox(null);
    setIsDrawingFace(false);
    setFaceNameInput("");
    setIsEditingInspectorLocation(false);
  }, [activeHash]);

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
          };
        })
      );
      refreshTimeline();
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
        imagePath: activePhoto.path,
        forceOnnx: true,
      });
      setPhotos((prev) =>
        prev.map((p) => (p.hash === activePhoto.hash ? { ...p, faces: detected } : p))
      );
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

  async function handleSetFlag(flag: "pick" | "reject" | null) {
    if (selectedHashes.size === 0) return;
    try {
      const hashes = Array.from(selectedHashes);
      await invoke("set_photo_flag", { hashes, flag });
      setPhotos((prev) => prev.map((p) => (selectedHashes.has(p.hash) ? { ...p, flag } : p)));
    } catch (err) {
      setError(String(err));
    }
  }

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

  async function handleBatchRate(rating: number) {
    if (selectedHashes.size === 0) return;
    try {
      const hashes = Array.from(selectedHashes);
      await invoke("set_photos_rating", { hashes, rating });
      setPhotos((prev) => prev.map((p) => (selectedHashes.has(p.hash) ? { ...p, rating } : p)));
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleBatchAddTag(tag: string) {
    if (!tag.trim() || selectedHashes.size === 0) return;
    try {
      const hashes = Array.from(selectedHashes);
      const clean = await invoke<string>("add_tag_batch", { hashes, tag });
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

  async function handleBatchStageMove(targetSub: string | null) {
    if (selectedHashes.size === 0) return;
    try {
      const ops = Array.from(selectedHashes).map((hash) => ({
        hash,
        target_subfolder: targetSub,
      }));
      await invoke("stage_photos_move", { ops });
      setPhotos((prev) =>
        prev.map((p) => (selectedHashes.has(p.hash) ? { ...p, staged_target: targetSub } : p))
      );
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
    if (drawnBox) {
      targetBbox = drawnBox;
    } else if (selectedFaceId) {
      const found = activePhoto.faces.find((f) => f.face_id === selectedFaceId);
      if (found) {
        targetBbox = {
          x: found.bbox_x,
          y: found.bbox_y,
          w: found.bbox_w,
          h: found.bbox_h,
        };
      }
    }

    if (!targetBbox) {
      setError("Please click an AI face box or draw a box over the person's face first!");
      return;
    }

    try {
      setError("");
      setAutoMatchNotice(`Saving "${cleanName}" & matching against verified faces...`);
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
                people: p.people.includes(cleanName)
                  ? p.people
                  : [...p.people, cleanName].sort(),
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
        prev.map((p) =>
          selectedHashes.has(p.hash) ? { ...p, in_basket: anyNotInBasket } : p
        )
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
      const count = await invoke<number>("export_xmp_sidecars", { hashes });
      setAutoMatchNotice(`Exported ${count} Adobe/Lightroom .xmp sidecar file(s)!`);
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
      const stats = await invoke<LibraryHealthStats>("get_library_health_stats", {
        rootFolder: folder || null,
      });
      setHealthStats(stats);
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
    const CONCURRENCY = 1;

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

  return {
    folder,
    setFolder,
    photos,
    setPhotos,
    people,
    selectedPerson,
    setSelectedPerson,
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
    lastSelectedIndexRef,
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
    handleSetFlag,
    handleSetColorLabel,
    handleRotateSelection,
    handleBatchRate,
    handleBatchAddTag,
    handleBatchStageMove,
    handleSearchCities,
    handleAssignCity,
    handleAssignCustomLocationText,
    handleSaveFaceAndAutomatch,
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
    handleAiAnalyzeSingle,
    runBatchAiOnList,
  };
}
