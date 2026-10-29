import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PhotoItem } from "../../types/lumina";
import { captureSnapshots } from "./undo";
import { mergeIntoKeeper } from "../../utils/duplicates";
import type { LibraryCore } from "./core";

export interface DuplicateSet {
  kind: "exact" | "same_photo";
  // The copy to keep first: the largest, then the oldest, then the one with the most information
  hashes: string[];
}

export interface DuplicateStage {
  keep: string;
  extras: string[];
}

// Duplicates: exact copies and the same photo as different files, found across the open folder; the extras
// are staged for _Trash after the kept copy takes over their stars, tags, people and albums
export function useDuplicates(core: LibraryCore) {
  const { folder, photos, setPhotos, pushSnapshotUndo, addLog, setError, notify } = core;
  // null: the dialog is closed; sets null while searching
  const [duplicates, setDuplicates] = useState<{ sets: DuplicateSet[] | null } | null>(null);

  async function openDuplicates() {
    setDuplicates({ sets: null });
    try {
      const sets = await invoke<DuplicateSet[]>("find_duplicates", { rootFolder: folder || null });
      setDuplicates((d) => (d ? { sets } : d));
    } catch (err) {
      setDuplicates(null);
      setError(`Find duplicates: ${String(err)}`);
    }
  }

  async function stageDuplicates(stages: DuplicateStage[]): Promise<boolean> {
    const extras = stages.flatMap((s) => s.extras);
    if (extras.length === 0) return false;
    try {
      const touched = new Set([...extras, ...stages.map((s) => s.keep)]);
      const before = captureSnapshots(photos, touched);
      await invoke<number>("stage_duplicate_extras", { sets: stages });

      const byHash = new Map(photos.map((p) => [p.hash, p]));
      const merged = new Map<string, PhotoItem>();
      for (const s of stages) {
        const keep = byHash.get(s.keep);
        if (keep) merged.set(s.keep, mergeIntoKeeper(keep, s.extras.map((h) => byHash.get(h)).filter((p): p is PhotoItem => Boolean(p))));
      }
      const extraSet = new Set(extras);
      setPhotos((prev) =>
        prev.map((p) => (extraSet.has(p.hash) ? { ...p, staged_target: "_Trash" } : merged.get(p.hash) ?? p))
      );
      // Ctrl+Z puts the extras back and the kept copies' stars, flag and label as they were (tags, people and
      // albums the kept copy gained stay: they are only additions)
      const after = before.map((s) =>
        extraSet.has(s.hash)
          ? { ...s, staged_target: "_Trash" }
          : { ...s, rating: merged.get(s.hash)?.rating ?? s.rating, flag: merged.get(s.hash)?.flag ?? s.flag, color_label: merged.get(s.hash)?.color_label ?? s.color_label }
      );
      pushSnapshotUndo(`Duplicates: stage ${extras.length} extra cop${extras.length === 1 ? "y" : "ies"} for _Trash`, before, after);

      setDuplicates((d) => {
        if (!d?.sets) return d;
        const done = new Set(stages.map((s) => s.keep));
        return { sets: d.sets.filter((set) => !set.hashes.some((h) => done.has(h))) };
      });
      addLog("TRIAGE", `Duplicates: staged ${extras.length} extra copies for _Trash (${stages.length} sets)`);
      notify(`Staged ${extras.length.toLocaleString()} extra cop${extras.length === 1 ? "y" : "ies"} for _Trash. Nothing is deleted until you Commit.`);
      return true;
    } catch (err) {
      setError(`Could not stage the duplicates: ${String(err)}`);
      return false;
    }
  }

  return { duplicates, setDuplicates, openDuplicates, stageDuplicates };
}
