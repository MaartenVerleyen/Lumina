import { useState, useEffect, useRef } from "react";
import { call, openLibraryRole, rememberLibraryRoles, setOpenLibrary, subscribe, type Role } from "../../api";
import { useAccount } from "../../components/auth/ServerGate";
import { open, platform } from "../../api/platform";
import { PhotoItem, ThumbBatchProgress, ThumbBatchItem, ExifRefreshResult, PerfLogEvent, TrashResult, TrashSummary, ScanProgressEvent } from "../../types/lumina";
import { formatBytes } from "../../utils/photoHelpers";
import { RAW_OR_HEIC_NAME } from "../../utils/rawPairs";
import { isSameFolder, SCAN_CANCELLED } from "./shared";
import { useSettings } from "../../settings";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";

// The open library folder: opening, scanning, thumbnails as they arrive, rescans, _Trash, Explorer actions
export function useFolder(core: LibraryCore, filters: FilterState) {
  const {
    folder,
    setFolder,
    folderRef,
    photos,
    setPhotos,
    activeHash,
    setActiveHash,
    selectedHashes,
    setSelectedHashes,
    selectionAnchorHashRef,
    addLog,
    setError,
    setAutoMatchNotice,
    confirmAction,
    undo,
  } = core;
  const { setExpandedFolders, setExpandedBurstGroups, setSelectedPeriodRange } = filters;
  const [recentFolders, setRecentFolders] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("lumina_recent_folders");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [scanProgress, setScanProgress] = useState<ScanProgressEvent | null>(null);
  const [isScanningFolder, setIsScanningFolder] = useState<boolean>(false);
  // Title of the progress dialog when it isn't a folder scan (e.g. emptying _Trash)
  const [progressTitle, setProgressTitle] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  // A quiet rescan (files changed outside Lumina, or after an import) shows no progress dialog
  const silentScanRef = useRef(false);
  // Changes Lumina makes itself (an import) don't need the watcher's rescan: it waits until this time
  const watchQuietUntilRef = useRef(0);
  const { watchLibrary } = useSettings();

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

  // Listen for Folder Scan Progress Events. A rescan of an indexed library sends hundreds a second; only the
  // latest is shown, once per frame (setting state for each one made React report an update loop)
  useEffect(() => {
    let latest: ScanProgressEvent | null = null;
    let frame = 0;
    const unlisten = subscribe<ScanProgressEvent>("scan-progress", (event) => {
      const prog = event.payload;
      if (silentScanRef.current) return;
      latest = prog.done ? null : prog;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setScanProgress(latest);
        });
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      unlisten.then((f) => f());
    };
  }, []);

  // Listen for backend performance timings (scan, thumbnails, face scan, previews)
  useEffect(() => {
    const unlisten = subscribe<PerfLogEvent>("perf-log", (event) => {
      const { label, millis, count, details } = event.payload;
      const items = count === 1 ? "" : ` for ${count} items`;
      addLog("PERF", `${label}: ${(millis / 1000).toFixed(2)} s${items}`, details);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog]);

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

  useEffect(() => {
    folderRef.current = folder;
    setProgress(null);
    // Undo entries reference photos of the previous folder; replaying them here would be wrong
    undo.clearHistory();
  }, [folder]);

  useEffect(() => {
    const unlisten = subscribe<ThumbBatchProgress>("thumb-batch-ready", (event) => {
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
            duration_ms: hit.duration_ms ?? p.duration_ms,
          };
        })
      );
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

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
      const res = await call<PhotoItem[]>("scan_folder", {
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
    // The web client has no folders to pick: back to the list of the server's libraries
    if (!platform.fileDialogs) {
      setFolder("");
      setPhotos([]);
      return;
    }
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

  async function handleEmptyTrashToRecycleBin() {
    if (!folder) return;
    let summary: TrashSummary;
    try {
      summary = await call<TrashSummary>("trash_summary", { rootFolder: folder });
    } catch (err) {
      setError(String(err));
      return;
    }
    if (summary.photos === 0 && summary.orphan_sidecars === 0) {
      setAutoMatchNotice("_Trash is empty: commit staged rejects first to move them there.");
      return;
    }
    const { bin } = summary;
    const what =
      summary.photos > 0
        ? `${summary.photos} photo(s) in _Trash (${formatBytes(summary.bytes)}) and their sidecars`
        : `${summary.orphan_sidecars} leftover sidecar file(s) in _Trash`;
    // Windows deletes for good what doesn't fit, so stay well under the limit
    const fits = bin.supported && (bin.capacity === null || summary.bytes <= bin.capacity * 0.95);
    let permanent = false;
    if (fits) {
      const overflow = bin.capacity === null ? 0 : bin.used + summary.bytes - bin.capacity;
      const room =
        overflow > 0
          ? `\n\nTo make room, Windows will remove the oldest ${formatBytes(overflow)} already in the Recycle Bin.`
          : "";
      const ok = await confirmAction(
        `Move ${what} to the Windows Recycle Bin?\n\nYou can still restore them from the Recycle Bin, but not from Lumina.${room}`,
        "Move to Recycle Bin",
        { title: "Empty _Trash", kind: "danger" }
      );
      if (!ok) return;
    } else {
      const why = !platform.localFiles
        ? "The server has no Recycle Bin."
        : !bin.supported
        ? `Drive ${bin.drive} has no Recycle Bin (a network or removable drive, or the Recycle Bin is switched off for it).`
        : `The Recycle Bin on ${bin.drive} holds at most ${formatBytes(bin.capacity ?? 0)}, so it can't keep these files.`;
      const ok = await confirmAction(
        `${why}\n\nDelete ${what} permanently? This can't be undone.${
          platform.localFiles && bin.supported
            ? `\n\nTo keep them recoverable, cancel and make the Recycle Bin bigger first (right-click the Recycle Bin › Properties › choose drive ${bin.drive}).`
            : ""
        }`,
        "Delete permanently",
        { title: "Empty _Trash", kind: "danger" }
      );
      if (!ok) return;
      permanent = true;
    }

    // Lumina's own deletes shouldn't trigger the folder watcher's rescan
    watchQuietUntilRef.current = Number.POSITIVE_INFINITY;
    setProgressTitle("Emptying _Trash");
    try {
      const result = await call<TrashResult>("empty_library_trash_to_os", { rootFolder: folder, permanent });
      const removed = new Set(result.removed_hashes);
      if (removed.size > 0) setPhotos((prev) => prev.filter((p) => !removed.has(p.hash)));
      for (const f of result.failures) {
        addLog("DISK", `Could not ${permanent ? "delete" : "recycle"} ${f.file}`, f.error);
      }
      const left = summary.photos - result.recycled;
      if (result.refused_permanent) {
        setError(
          `The Recycle Bin on ${bin.drive} couldn't take more files, so Lumina stopped instead of letting Windows delete them permanently. ${left} photo(s) are still in _Trash.`
        );
      } else if (result.failures.length > 0) {
        setError(`${result.failures.length} file(s) could not be removed and were left in place. See the Session Log.`);
      }
      const verb = permanent ? "Deleted" : "Moved";
      const where = permanent ? "permanently" : "to the Recycle Bin";
      const sidecars = result.sidecars > 0 ? ` and ${result.sidecars} sidecar(s)` : "";
      const stopped = result.cancelled ? ` Stopped: ${left} photo(s) are still in _Trash.` : "";
      setAutoMatchNotice(`${verb} ${result.recycled} photo(s)${sidecars} ${where}.${stopped}`);
      addLog("DISK", `${verb} ${result.recycled} _Trash photo(s)${sidecars} ${where}`);
    } catch (err) {
      setError(String(err));
    } finally {
      watchQuietUntilRef.current = Date.now() + 4000;
      setProgressTitle(null);
      setScanProgress(null);
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
      const res = await call<PhotoItem[]>("scan_folder", {
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
      "Reprocess",
      { title: "Rebuild thumbnails" }
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
      const res = await call<PhotoItem[]>("scan_folder", {
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
      const results = await call<ExifRefreshResult[]>("rescan_exif_batch", {
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

  // Jobs panel: stop making thumbnails (the rest is picked up the next time the folder is opened)
  async function handleCancelThumbnails() {
    try {
      await call("cancel_thumbnail_pass");
      setProgress(null);
      addLog("LIBRARY", "Stopped making thumbnails; the rest follows the next time this folder is opened");
    } catch (err) {
      setError(String(err));
    }
  }

  // Native OS Context Menu Actions
  async function handleOpenInDefaultViewer(path: string) {
    try {
      await call("open_in_default_app", { path });
      addLog("LIBRARY", `Opened in default viewer: ${path.split(/[\\/]/).pop()}`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRevealInFileManager(path: string) {
    try {
      await call("reveal_in_file_manager", { path });
      addLog("LIBRARY", `Revealed in file manager: ${path}`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleCreateSubfolder(relativePath: string) {
    if (!folder || !relativePath.trim()) return;
    try {
      const created = await call<string>("create_library_subfolder", {
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

  // Rescans without the progress dialog and keeps the selection; returns the photos, or null when it couldn't
  async function silentRescan(): Promise<PhotoItem[] | null> {
    const target = folderRef.current;
    if (!target || isScanningFolder || silentScanRef.current) return null;
    silentScanRef.current = true;
    try {
      const res = await call<PhotoItem[]>("scan_folder", { folderPath: target, forceReprocess: false });
      if (!isSameFolder(target, folderRef.current)) return null;
      setPhotos(res);
      return res;
    } catch {
      return null;
    } finally {
      silentScanRef.current = false;
    }
  }

  // Watch the open library for photos added, changed or removed outside Lumina (Settings → Library)
  useEffect(() => {
    call("watch_library", { root: watchLibrary && folder ? folder : null }).catch((err) =>
      addLog("LIBRARY", "Could not watch the library folder for changes", String(err))
    );
  }, [folder, watchLibrary]);

  const silentRescanRef = useRef(silentRescan);
  silentRescanRef.current = silentRescan;
  useEffect(() => {
    const unlisten = subscribe<string>("library-files-changed", (event) => {
      if (!isSameFolder(event.payload, folderRef.current) || Date.now() < watchQuietUntilRef.current) return;
      silentRescanRef.current().then((res) => {
        if (res) addLog("LIBRARY", `Picked up changes made outside Lumina (${res.length} items)`);
      });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog]);

  // A guest sees a library through its shared albums: when an album changes (a photo added or taken out),
  // what they see changes, so their window lists the library again
  useEffect(() => {
    const off = subscribe("albums-changed", () => {
      if (openLibraryRole() === "guest" && folderRef.current) silentRescanRef.current();
    });
    return () => {
      off.then((f) => f());
    };
  }, []);

  // Rights follow the open library (see useAccess)
  useEffect(() => {
    setOpenLibrary(folder || null);
  }, [folder]);

  // An album was shared with this user (or no longer is), or an admin changed their role: what they may see
  // changed, so the library is listed again, and the roles per library fetched again
  const account = useAccount();
  const myName = account?.user.name;
  useEffect(() => {
    if (!myName) return;
    const offs = ["shares-changed", "roles-changed"].map((name) =>
      subscribe<{ users?: string[] }>(name, (event) => {
        if (!(event.payload.users ?? []).some((u) => u.toLowerCase() === myName.toLowerCase())) return;
        call<{ root: string; role: Role }[]>("list_libraries")
          .then((list) => {
            rememberLibraryRoles(list);
            const open = folderRef.current;
            if (!open) return;
            // Nothing of the open library is left for them: back to the list of what they have
            if (!list.some((l) => isSameFolder(l.root, open))) {
              setFolder("");
              setPhotos([]);
            } else {
              silentRescanRef.current();
            }
          })
          .catch(() => {});
      })
    );
    return () => {
      for (const off of offs) off.then((f) => f());
    };
  }, [myName]);

  return {
    silentRescan,
    watchQuietUntilRef,
    recentFolders,
    scanProgress,
    progressTitle,
    setProgressTitle,
    isScanningFolder,
    progress,
    handleLoadFolderPath,
    handleOpenFolder,
    handleEmptyTrashToRecycleBin,
    handleRescanFolder,
    handleRescanAndProcessFolder,
    handleForceRescanExifSelected,
    handleCancelThumbnails,
    handleOpenInDefaultViewer,
    handleRevealInFileManager,
    handleCreateSubfolder,
  };
}
