import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PhotoActionSnapshot, PhotoItem, UndoHistoryEntry } from "../types/lumina";

const MAX_UNDO_STEPS = 20;

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

async function applySnapshotsToBackend(
  snapshots: PhotoActionSnapshot[],
  setPhotos: React.Dispatch<React.SetStateAction<PhotoItem[]>>
) {
  if (snapshots.length === 0) return;

  // Group by value to minimize IPC calls
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

  for (const [flag, hashes] of byFlag.entries()) {
    await invoke("set_photo_flag", { hashes, flag });
  }
  for (const [rating, hashes] of byRating.entries()) {
    await invoke("set_photos_rating", { hashes, rating });
  }
  for (const [color, hashes] of byColor.entries()) {
    await invoke("set_photo_color_label", { hashes, color });
  }
  for (const [inBasket, hashes] of byBasket.entries()) {
    await invoke("set_photo_basket", { hashes, inBasket });
  }
  if (stageOps.length > 0) {
    await invoke("stage_photos_move", { ops: stageOps });
  }
  const rotOps = snapshots.map((s) => ({ hash: s.hash, rotation: s.rotation }));
  if (rotOps.length > 0) {
    await invoke("set_photos_rotation_exact", { ops: rotOps });
  }

  const snapMap = new Map(snapshots.map((s) => [s.hash, s]));
  setPhotos((prev) =>
    prev.map((p) => {
      const hit = snapMap.get(p.hash);
      if (!hit) return p;
      return {
        ...p,
        flag: hit.flag,
        rating: hit.rating,
        color_label: hit.color_label,
        staged_target: hit.staged_target,
        in_basket: hit.in_basket,
        rotation: hit.rotation,
      };
    })
  );
}

export function useUndoStack(
  setPhotos: React.Dispatch<React.SetStateAction<PhotoItem[]>>,
  setActiveHash: React.Dispatch<React.SetStateAction<string | null>>,
  setSelectedHashes: React.Dispatch<React.SetStateAction<Set<string>>>,
  setAutoMatchNotice: React.Dispatch<React.SetStateAction<string>>
) {
  const [undoStack, setUndoStack] = useState<UndoHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoHistoryEntry[]>([]);

  const pushUndoEntry = useCallback((entry: UndoHistoryEntry) => {
    setUndoStack((prev) => [...prev.slice(-(MAX_UNDO_STEPS - 1)), entry]);
    setRedoStack([]);
  }, []);

  const handleUndo = useCallback(async () => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, last]);

    await applySnapshotsToBackend(last.before, setPhotos);
    if (last.previousActiveHash) {
      setActiveHash(last.previousActiveHash);
    }
    if (last.previousSelectedHashes.length > 0) {
      setSelectedHashes(new Set(last.previousSelectedHashes));
    }
    setAutoMatchNotice(`Undid: ${last.description}`);
    setTimeout(() => setAutoMatchNotice(""), 3000);
  }, [undoStack, setPhotos, setActiveHash, setSelectedHashes, setAutoMatchNotice]);

  const handleRedo = useCallback(async () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev, next]);

    await applySnapshotsToBackend(next.after, setPhotos);
    setAutoMatchNotice(`Redid: ${next.description}`);
    setTimeout(() => setAutoMatchNotice(""), 3000);
  }, [redoStack, setPhotos, setAutoMatchNotice]);

  return {
    undoStack,
    redoStack,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    pushUndoEntry,
    handleUndo,
    handleRedo,
  };
}
