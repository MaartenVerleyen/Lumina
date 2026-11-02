import { useState, useRef, useCallback } from "react";
import { call } from "../../api";
import { PhotoItem, PhotoActionSnapshot, UndoHistoryEntry } from "../../types/lumina";
import { MAX_UNDO_STEPS } from "./shared";

// Undo/redo: photo snapshots (flag, rating, label, staging, basket, rotation) or custom undo/redo actions

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
      await call("set_photo_flag", { hashes, flag });
    }
  }
  if (fields.has("rating")) {
    for (const [rating, hashes] of byRating.entries()) {
      await call("set_photos_rating", { hashes, rating });
    }
  }
  if (fields.has("color_label")) {
    for (const [color, hashes] of byColor.entries()) {
      await call("set_photo_color_label", { hashes, color });
    }
  }
  if (fields.has("in_basket")) {
    for (const [inBasket, hashes] of byBasket.entries()) {
      await call("set_photo_basket", { hashes, inBasket });
    }
  }
  if (fields.has("staged_target") && stageOps.length > 0) {
    await call("stage_photos_move", { ops: stageOps });
  }
  if (fields.has("rotation")) {
    const rotOps = snapshots.map((s) => ({ hash: s.hash, rotation: s.rotation }));
    await call("set_photos_rotation_exact", { ops: rotOps });
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
