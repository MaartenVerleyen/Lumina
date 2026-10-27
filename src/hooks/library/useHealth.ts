import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  };
}
