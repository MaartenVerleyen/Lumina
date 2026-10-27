import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ExportProgress, ExportResult } from "../../types/lumina";
import type { ExportSettings } from "../../components/modals/ExportModal";
import type { GallerySettings } from "../../components/modals/GalleryModal";
import type { LibraryCore } from "./core";

// Exporting photos as JPEG (full size or resized, GPS optionally removed), and as a web gallery
export function useExport(core: LibraryCore) {
  const { selectedHashes, addLog, setError, setAutoMatchNotice, notify } = core;
  // Photos chosen for the export dialog (null = dialog closed); RAW+JPEG pairs are not expanded here,
  // so one shot gives one exported file
  const [exportTargets, setExportTargets] = useState<string[] | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  // Photos chosen for the web gallery dialog, with a suggested title (null = dialog closed)
  const [galleryTarget, setGalleryTarget] = useState<{ hashes: string[]; title: string } | null>(null);

  useEffect(() => {
    const unlisten = listen<ExportProgress>("export-progress", (event) => {
      setExportProgress(event.payload.done ? null : event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  function openExport(targetHashes?: string[]) {
    const hashes = targetHashes ?? Array.from(selectedHashes);
    if (hashes.length === 0) {
      setAutoMatchNotice("Select the photos to export first.");
      return;
    }
    setExportTargets(hashes);
  }

  async function runExport(settings: ExportSettings) {
    const hashes = exportTargets ?? [];
    setExportTargets(null);
    if (hashes.length === 0) return;
    setExportProgress({ completed: 0, total: hashes.length, done: false, cancelled: false });
    try {
      const result = await invoke<ExportResult>("export_photos", {
        options: {
          hashes,
          dest_dir: settings.destDir,
          long_edge: settings.longEdge,
          quality: settings.quality,
          strip_gps: settings.stripGps,
        },
      });
      for (const f of result.failures) addLog("DISK", `Could not export ${f.file}`, f.error);
      addLog("DISK", `Exported ${result.exported} photo(s)`, settings.destDir);
      if (result.failures.length > 0) {
        setError(`${result.failures.length} photo(s) could not be exported. See the Session Log.`);
      }
      setAutoMatchNotice(
        `${result.cancelled ? "Export stopped: " : ""}${result.exported} photo(s) exported to ${settings.destDir}`
      );
    } catch (err) {
      setError(`Export failed: ${String(err)}`);
    } finally {
      setExportProgress(null);
    }
  }

  function openGallery(title: string, targetHashes?: string[]) {
    const hashes = targetHashes ?? Array.from(selectedHashes);
    if (hashes.length === 0) {
      setAutoMatchNotice("Select the photos for the gallery first.");
      return;
    }
    setGalleryTarget({ hashes, title });
  }

  async function runGallery(settings: GallerySettings) {
    const hashes = galleryTarget?.hashes ?? [];
    setGalleryTarget(null);
    if (hashes.length === 0) return;
    setExportProgress({ completed: 0, total: hashes.length, done: false, cancelled: false });
    try {
      const result = await invoke<{ folder: string; index: string; exported: number; failures: { file: string; error: string }[]; cancelled: boolean }>(
        "export_gallery",
        {
          options: {
            hashes,
            dest_dir: settings.destDir,
            title: settings.title.trim(),
            captions: settings.captions,
            people: settings.people,
            places: settings.places,
            zip: settings.zip,
          },
        }
      );
      for (const f of result.failures) addLog("DISK", `Could not add ${f.file} to the gallery`, f.error);
      addLog("DISK", `Web gallery with ${result.exported} photo(s)`, result.folder);
      if (result.failures.length > 0) setError(`${result.failures.length} photo(s) could not be added. See the Session Log.`);
      notify(`${result.cancelled ? "Gallery stopped: " : "Gallery ready: "}${result.exported} photo(s) in ${result.folder}`, "info", {
        label: "Open the gallery",
        run: () => invoke("open_in_default_app", { path: result.index }).catch((e) => setError(String(e))),
      });
    } catch (err) {
      setError(`Gallery failed: ${String(err)}`);
    } finally {
      setExportProgress(null);
    }
  }

  async function handleCancelExport() {
    try {
      await invoke("cancel_export");
    } catch {}
  }

  return {
    exportTargets,
    setExportTargets,
    exportProgress,
    openExport,
    runExport,
    handleCancelExport,
    galleryTarget,
    setGalleryTarget,
    openGallery,
    runGallery,
  };
}
