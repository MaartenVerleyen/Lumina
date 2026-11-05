import { useState } from "react";
import { call } from "../../api";
import { confirmDialog } from "../../confirm";
import { LibraryHealthStats, XmpExportResult } from "../../types/lumina";
import type { LibraryCore } from "./core";

// Library health: cache statistics, XMP sidecar export, pruning orphaned cache files
export function useHealth(core: LibraryCore) {
  const { folder, selectedHashes, addLog, setError, setAutoMatchNotice } = core;
  // Library Health & XMP Modal State
  const [isHealthModalOpen, setIsHealthModalOpen] = useState<boolean>(false);
  const [healthStats, setHealthStats] = useState<LibraryHealthStats | null>(null);
  const [isExportingXmp, setIsExportingXmp] = useState<boolean>(false);

  async function handleOpenHealthDashboard() {
    try {
      setIsHealthModalOpen(true);
      const stats = await call<LibraryHealthStats>("get_library_health_stats", {
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
      const res = await call<XmpExportResult>("export_xmp_sidecars", {
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

  // The rows of files deleted outside Lumina go, with their ratings, tags, names and album places, and people
  // left on no photo
  async function handleForgetMissing() {
    if (!folder || !healthStats) return;
    const n = healthStats.missing_count;
    const people = healthStats.unused_people;
    if (n === 0 && people === 0) return;
    const parts = [
      n > 0 &&
        `${n} photo${n === 1 ? " is" : "s are"} no longer in the folder (deleted, or moved outside Lumina to a place it doesn't know): ${n === 1 ? "it goes" : "they go"} with ${n === 1 ? "its" : "their"} ratings, tags, names and album places, and a file that comes back later is a new photo.`,
      people > 0 && `${people} ${people === 1 ? "person has" : "people have"} no photos left and ${people === 1 ? "goes" : "go"} from the people list.`,
    ].filter(Boolean);
    const ok = await confirmDialog(parts.join(" "), { title: "Forget what is gone", okLabel: "Forget", kind: "danger" });
    if (!ok) return;
    try {
      const forgotten = await call<number>("forget_missing_files", { rootFolder: folder });
      setHealthStats(await call<LibraryHealthStats>("get_library_health_stats", { rootFolder: folder }));
      addLog("DISK", `Forgot ${forgotten} photo(s) whose file is gone, and ${people} person(s) without photos`);
      setAutoMatchNotice(
        [
          forgotten > 0 && `Forgot ${forgotten} photo${forgotten === 1 ? "" : "s"} whose file is gone`,
          people > 0 && `${people} ${people === 1 ? "person" : "people"} without photos left the list`,
        ]
          .filter(Boolean)
          .join("; ") + "."
      );
    } catch (err) {
      setError(String(err));
    }
  }

  async function handlePruneCache() {
    try {
      const removed = await call<number>("prune_orphaned_cache");
      const stats = await call<LibraryHealthStats>("get_library_health_stats", {
        rootFolder: folder || null,
      });
      setHealthStats(stats);
      addLog("DISK", `Pruned ${removed} orphaned cache file(s)`);
      setAutoMatchNotice(`Pruned ${removed} orphaned cache file(s)!`);
    } catch (err) {
      setError(String(err));
    }
  }

  return {
    isHealthModalOpen,
    setIsHealthModalOpen,
    healthStats,
    isExportingXmp,
    handleOpenHealthDashboard,
    handleExportXmp,
    handlePruneCache,
    handleForgetMissing,
  };
}
