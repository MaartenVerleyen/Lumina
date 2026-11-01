import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TimestampShiftResult, PhotoActionSnapshot } from "../../types/lumina";
import { expandWithRawPairs } from "../../utils/rawPairs";
import { expandWithLivePairs, isVideo } from "../../utils/media";
import { captureSnapshots } from "./undo";
import type { LibraryView } from "./useLibraryView";
import type { LibraryCore } from "./core";

// Culling actions on photos: flag, reject, rate, colour label, rotate, tag, basket, time shift, keep sharpest
export function useTriage(core: LibraryCore, view: LibraryView) {
  const {
    photos,
    setPhotos,
    photoByHash,
    activeHash,
    selectedHashes,
    undo,
    resolveTargets,
    pushCustomUndo,
    pushSnapshotUndo,
    confirmAction,
    addLog,
    setError,
    setAutoMatchNotice,
    setTagInput,
    setBulkInput,
    setActiveBulkPopover,
  } = core;
  const { sharpestInGroup, totalBurstGroups } = view;
  // Camera Clock Shift State
  const [shiftHoursInput, setShiftHoursInput] = useState<number>(0);
  const [shiftMinutesInput, setShiftMinutesInput] = useState<number>(0);

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
    const keep = expandWithLivePairs(expandWithRawPairs([keepHash], photos), photos);
    const keepSet = new Set(keep);
    const rest = expandWithLivePairs(expandWithRawPairs(otherHashes, photos), photos).filter((h) => !keepSet.has(h));
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
    // Videos play the way their file says; turning them is for a video editor
    const videoHashes = new Set(photos.filter(isVideo).map((p) => p.hash));
    const hashes = resolveTargets(targetHashes).filter((h) => !videoHashes.has(h));
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
      const hashes = expandWithLivePairs(expandWithRawPairs(Array.from(selectedHashes), photos), photos);
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
        `Keep the best photo of each of the ${totalBurstGroups} burst groups (open eyes and a sharp face first, then the sharpest) and stage the other ${toTrash.length} photo(s) for _Trash?\n\nNothing is deleted until you Commit. You can undo this with Ctrl+Z.`,
        "Stage for _Trash",
        { title: "Keep the best of each burst" }
      );
      if (!ok) return;
      const trashHashes = new Set(toTrash.map((p) => p.hash));
      const before = captureSnapshots(photos, trashHashes);
      const ops = toTrash.map((p) => ({ hash: p.hash, target_subfolder: "_Trash" }));
      await invoke("stage_photos_move", { ops });
      pushSnapshotUndo(
        `Keep best: stage ${toTrash.length} photo(s) for _Trash`,
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

  return {
    handleSetFlag,
    handleRejectToTrash,
    handleKeepAndTrashRest,
    handleSetColorLabel,
    handleRotateSelection,
    handleBatchRate,
    handleBatchAddTag,
    handleToggleBasketSelection,
    shiftHoursInput,
    setShiftHoursInput,
    shiftMinutesInput,
    setShiftMinutesInput,
    handleShiftTimestamps,
    handleKeepSharpestInAllGroups,
  };
}
