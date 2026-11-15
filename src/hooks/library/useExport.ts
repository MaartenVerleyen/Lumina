import { useState, useEffect } from "react";
import { call, callLocal, originalsOf, subscribe, subscribeLocal } from "../../api";
import { ExportProgress, ExportResult, PhotoItem } from "../../types/lumina";
import type { ExportSettings } from "../../components/modals/ExportModal";
import type { GallerySettings } from "../../components/modals/GalleryModal";
import type { LibraryCore } from "./core";
import { plural } from "../../utils/plural";

// Exporting photos as JPEG (full size or resized, GPS optionally removed), and as a web gallery
export function useExport(core: LibraryCore) {
  const { selectedHashes, addLog, setError, setAutoMatchNotice, notify, photoByHash } = core;
  // Photos chosen for the export dialog (null = dialog closed); RAW+JPEG pairs are not expanded here,
  // so one shot gives one exported file
  const [exportTargets, setExportTargets] = useState<string[] | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  // Photos chosen for the web gallery dialog, with a suggested title (null = dialog closed)
  const [galleryTarget, setGalleryTarget] = useState<{ hashes: string[]; title: string } | null>(null);

  useEffect(() => {
    const unlisten = subscribe<ExportProgress>("export-progress", (event) => {
      setExportProgress(event.payload.done ? null : event.payload);
    });
    // Originals of a server's photos on their way first
    const unlistenFetch = subscribeLocal<{ completed: number; total: number }>("fetch-progress", (event) => {
      setExportProgress({ ...event.payload, done: false, cancelled: false, stage: "Downloading originals" });
    });
    return () => {
      unlisten.then((f) => f());
      unlistenFetch.then((f) => f());
    };
  }, []);

  // The photos to export: those with a copy on this computer by their ids here, the rest (a server's only)
  // downloaded first and sent with the values the window shows for them
  async function sourcesOf(hashes: string[]) {
    const { local, byServer } = originalsOf(hashes);
    const toFetch = [...byServer].flatMap(([server, list]) => list.map((hash) => ({ server, hash })));
    if (toFetch.length === 0) return { hashes: local, fetched: [] };
    setExportProgress({ completed: 0, total: toFetch.length, done: false, cancelled: false, stage: "Downloading originals" });
    const got = await callLocal<{ hash: string; path: string }[]>("fetch_originals", { photos: toFetch });
    const fetched = got.flatMap(({ hash, path }) => {
      const p: PhotoItem | undefined = photoByHash.get(hash);
      if (!p) return [];
      return [
        {
          path,
          name: p.name,
          rotation: p.rotation ?? 0,
          captured_at: p.captured_at ?? "",
          camera_model: p.camera_model ?? "",
          lens_model: p.lens_model ?? null,
          latitude: p.latitude ?? null,
          longitude: p.longitude ?? null,
          caption: p.ai_caption ?? "",
          location: p.location ?? "",
          people: p.people ?? [],
        },
      ];
    });
    const missing = toFetch.length - got.length;
    if (missing > 0) addLog("DISK", `${plural(missing, "original")} couldn't be downloaded from the server`);
    return { hashes: local, fetched };
  }

  // The downloaded originals go once the export has its own copies
  const dropFetched = () => callLocal("fetch_originals", { photos: [] }).catch(() => {});

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
      const { hashes: here, fetched } = await sourcesOf(hashes);
      const result = await call<ExportResult>("export_photos", {
        options: {
          hashes: here,
          fetched,
          dest_dir: settings.destDir,
          long_edge: settings.longEdge,
          quality: settings.quality,
          strip_gps: settings.stripGps,
        },
      });
      for (const f of result.failures) addLog("DISK", `Could not export ${f.file}`, f.error);
      addLog("DISK", `Exported ${plural(result.exported, "photo")}`, settings.destDir);
      if (result.failures.length > 0) {
        setError(`${plural(result.failures.length, "photo")} could not be exported. See the activity log.`);
      }
      setAutoMatchNotice(
        `${result.cancelled ? "Export stopped: " : ""}${plural(result.exported, "photo")} exported to ${settings.destDir}`
      );
    } catch (err) {
      setError(`Export failed: ${String(err)}`);
    } finally {
      void dropFetched();
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
      const { hashes: here, fetched } = await sourcesOf(hashes);
      const result = await call<{ folder: string; index: string; exported: number; failures: { file: string; error: string }[]; cancelled: boolean }>(
        "export_gallery",
        {
          options: {
            hashes: here,
            fetched,
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
      addLog("DISK", `Web gallery with ${plural(result.exported, "photo")}`, result.folder);
      if (result.failures.length > 0) setError(`${plural(result.failures.length, "photo")} could not be added. See the activity log.`);
      notify(`${result.cancelled ? "Gallery stopped: " : "Gallery ready: "}${plural(result.exported, "photo")} in ${result.folder}`, "info", {
        label: "Open the gallery",
        run: () => call("open_in_default_app", { path: result.index }).catch((e) => setError(String(e))),
      });
    } catch (err) {
      setError(`Gallery failed: ${String(err)}`);
    } finally {
      void dropFetched();
      setExportProgress(null);
    }
  }

  async function handleCancelExport() {
    try {
      await call("cancel_export");
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
