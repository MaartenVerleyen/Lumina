import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PhotoItem, AutoStagePreset, CommitResult, PhotoActionSnapshot } from "../../types/lumina";
import { computePresetTargetFolder } from "../../utils/photoHelpers";
import { captureSnapshots } from "./undo";
import type { LibraryView } from "./useLibraryView";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";
import type { useFolder } from "./useFolder";

// Staged moves: stage to a folder, auto-organize by rule, dismiss, and commit to disk
export function useStaging(
  core: LibraryCore,
  filters: FilterState,
  view: LibraryView,
  folderHook: ReturnType<typeof useFolder>
) {
  const {
    folder,
    photos,
    setPhotos,
    activeHash,
    undo,
    resolveTargets,
    pushSnapshotUndo,
    confirmAction,
    addLog,
    setError,
    setAutoMatchNotice,
    setBulkInput,
    setActiveBulkPopover,
  } = core;
  const { smartFilter, setSmartFilter } = filters;
  const { visiblePhotos } = view;
  const { watchQuietUntilRef, setProgressTitle } = folderHook;
  const [isCommitModalOpen, setIsCommitModalOpen] = useState<boolean>(false);
  const [smartRenameOnCommit, setSmartRenameOnCommit] = useState<boolean>(false);
  const [autoStagePreset, setAutoStagePreset] = useState<AutoStagePreset>("YEAR_MONTH_CITY");

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
        "Stage photos",
        { title: "Stage photos", kind: "info" }
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
    // The moves are Lumina's own: the folder watcher shouldn't rescan for each of them
    watchQuietUntilRef.current = Number.POSITIVE_INFINITY;
    try {
      setProgressTitle("Committing changes to disk");
      const result = await invoke<CommitResult>("commit_staged_operations", {
        rootFolder: folder,
        smartRename: smartRenameOnCommit,
      });
      setProgressTitle(null);
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
      watchQuietUntilRef.current = Date.now() + 4000;
      setProgressTitle(null);
    }
  }

  return {
    isCommitModalOpen,
    setIsCommitModalOpen,
    smartRenameOnCommit,
    setSmartRenameOnCommit,
    autoStagePreset,
    setAutoStagePreset,
    handleBatchStageMove,
    handleDismissAllStaged,
    handleAutoOrganizeByPreset,
    handleCommitAllStaged,
  };
}
