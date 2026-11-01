import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog, type ConfirmKind } from "../../confirm";
import { PhotoItem, SessionLogEntry, BulkPopover, PhotoActionSnapshot, ViewMode } from "../../types/lumina";
import { expandWithRawPairs } from "../../utils/rawPairs";
import { expandWithLivePairs } from "../../utils/media";
import { MAX_TOASTS, Toast } from "./shared";
import { useUndoStack } from "./undo";

// The library's shared state: the open folder, its photos, the selection, notifications and undo.
// Every area hook (folder, triage, people, AI ...) receives this.
export function useLibraryCore() {
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
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set());
  const [activeHash, setActiveHash] = useState<string | null>(null);
  // Shift-click / Shift+arrow range anchor (a photo hash, resolved to an index at use time)
  const selectionAnchorHashRef = useRef<string | null>(null);

  // Bulk Dock Popover States
  const [activeBulkPopover, setActiveBulkPopover] = useState<
    BulkPopover | null
  >(null);
  const [bulkInput, setBulkInput] = useState<string>("");
  const [tagInput, setTagInput] = useState<string>("");

  // Session Activity Log State
  const [sessionLogs, setSessionLogs] = useState<SessionLogEntry[]>([]);
  const [isSessionLogModalOpen, setIsSessionLogModalOpen] = useState<boolean>(false);

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
    (message: string, kind: Toast["kind"] = "info", action?: Toast["action"]) => {
      if (!message) return;
      const id = ++toastSeqRef.current;
      // The same message again (e.g. a repeated failure) replaces the old toast instead of stacking
      setToasts((prev) => [...prev.filter((t) => t.message !== message), { id, kind, message, action }].slice(-MAX_TOASTS));
      // Toasts with a button stay long enough to use it
      const ttl = kind === "error" ? 12000 : action ? 20000 : Math.min(9000, 3500 + message.length * 25);
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

  // Dismiss Splashscreen IMMEDIATELY on mount so startup never waits on Ollama TCP timeouts
  useEffect(() => {
    if (!splashClosedRef.current) {
      splashClosedRef.current = true;
      setIsAppReady(true);
      invoke("close_splashscreen").catch(() => {});
    }
  }, []);

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

  // Latest photos for long-running loops (the AI batch reads the live library)
  const photosRef = useRef(photos);
  photosRef.current = photos;
  // Current folder for event listeners registered once (avoids stale-closure comparisons)
  const folderRef = useRef(folder);

  // Triage handlers act on `targetHashes` when given (e.g. the right-clicked photo), otherwise on the
  // current selection. Undo entries are recorded only after the backend accepted the change.
  function resolveTargets(targetHashes?: string[]): string[] {
    const base = targetHashes ?? Array.from(selectedHashes);
    return base.length === 0 ? [] : expandWithLivePairs(expandWithRawPairs(base, photos), photos);
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

  // Confirmation for bulk, destructive or slow actions ("danger" turns the button red)
  function confirmAction(message: string, okLabel: string, options: { title?: string; kind?: ConfirmKind } = {}) {
    return confirmDialog(message, { title: options.title, kind: options.kind ?? "warning", okLabel });
  }

  return {
    isAppReady,
    folder,
    setFolder,
    folderRef,
    photos,
    setPhotos,
    photosRef,
    photoByHash,
    activePhoto,
    viewMode,
    setViewMode,
    selectedHashes,
    setSelectedHashes,
    activeHash,
    setActiveHash,
    selectionAnchorHashRef,
    activeBulkPopover,
    setActiveBulkPopover,
    bulkInput,
    setBulkInput,
    tagInput,
    setTagInput,
    sessionLogs,
    addLog,
    clearSessionLogs,
    isSessionLogModalOpen,
    setIsSessionLogModalOpen,
    toasts,
    dismissToast,
    notify,
    setError,
    setAutoMatchNotice,
    undo,
    resolveTargets,
    pushCustomUndo,
    pushSnapshotUndo,
    confirmAction,
  };
}

export type LibraryCore = ReturnType<typeof useLibraryCore>;
