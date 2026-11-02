import { useEffect, useRef, useState } from "react";
import { call, subscribe } from "../../api";
import { ImportOptions, ImportProgress, ImportResult, ImportSource } from "../../types/lumina";
import { diskPathOf } from "../../utils/rawPairs";
import { getSettings } from "../../settings";
import { isSameFolder } from "./shared";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";
import type { useFolder } from "./useFolder";

const IMPORT_CANCELLED = "Import cancelled";
const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();

// Importing from a memory card, USB drive or folder: the dialog, progress, and afterwards the new photos
// selected and filtered ("Just imported"). A connected camera card raises a toast that opens the dialog.
export function useImport(core: LibraryCore, filters: FilterState, folderHook: ReturnType<typeof useFolder>) {
  const { folder, notify, addLog, setError, setSelectedHashes, setActiveHash, setViewMode } = core;
  const { setHashFilter } = filters;
  const { silentRescan, watchQuietUntilRef, handleLoadFolderPath } = folderHook;
  // The dialog: open with a source chosen in advance ("" = let the user pick), null when closed
  const [importSource, setImportSource] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);

  const openImport = (source = "") => setImportSource(source);

  useEffect(() => {
    const unlisten = subscribe<ImportProgress>("import-progress", (event) => {
      setImportProgress(event.payload.done ? null : event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const openImportRef = useRef(openImport);
  openImportRef.current = openImport;
  useEffect(() => {
    const unlisten = subscribe<ImportSource>("removable-drive-arrived", (event) => {
      if (!getSettings().offerImportOnCard) return;
      const d = event.payload;
      notify(`${d.label} (${d.path.replace(/\\$/, "")}) is connected.`, "info", {
        label: "Import photos…",
        run: () => openImportRef.current(d.path),
      });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [notify]);

  async function runImport(options: ImportOptions) {
    setImportSource(null);
    // The copies would otherwise make the folder watcher rescan halfway through
    watchQuietUntilRef.current = Number.POSITIVE_INFINITY;
    setImportProgress({ stage: "Reading", completed: 0, total: 0, copied: 0, skipped: 0, failed: 0, current: "", done: false });
    addLog("DISK", `Started importing from ${options.source}`, `into ${options.dest_root}`);
    try {
      const result = await call<ImportResult>("start_import", { options });
      for (const f of result.failures) addLog("DISK", `Could not import ${f.file}`, f.error);
      const parts = [
        `${result.copied} photo${result.copied === 1 ? "" : "s"} imported`,
        result.skipped > 0 && `${result.skipped} already in your library`,
        result.deleted > 0 && `${result.deleted} removed from the card`,
        result.ejected && "the card can be removed",
      ].filter(Boolean);
      addLog("DISK", `${result.cancelled ? "Import stopped: " : "Import finished: "}${parts.join(", ")}`);
      if (result.failures.length > 0) {
        setError(`${result.failures.length} file(s) could not be imported and were left on the card. See the Session Log.`);
      }

      // Show the new photos: rescan the library they went into, then select and filter on them
      if (result.new_paths.length > 0) {
        const inOpenLibrary = folder && norm(options.dest_root).startsWith(norm(folder).replace(/\\$/, ""));
        if (!inOpenLibrary) {
          await handleLoadFolderPath(options.dest_root);
        } else {
          const photos = await silentRescan();
          const wanted = new Set(result.new_paths.map(norm));
          const hashes = (photos ?? []).filter((p) => wanted.has(norm(diskPathOf(p)))).map((p) => p.hash);
          if (hashes.length > 0) {
            setHashFilter({ label: "Just imported", hashes: new Set(hashes) });
            setSelectedHashes(new Set(hashes));
            setActiveHash(hashes[0]);
            setViewMode("grid");
          }
        }
      }
      notify(`${result.cancelled ? "Import stopped: " : ""}${parts.join(", ")}.`);
    } catch (err) {
      if (!String(err).includes(IMPORT_CANCELLED)) setError(`Import failed: ${String(err)}`);
    } finally {
      setImportProgress(null);
      watchQuietUntilRef.current = Date.now() + 4000;
    }
  }

  async function handleCancelImport() {
    try {
      await call("cancel_import");
    } catch {}
  }

  // The destination for an import: the open library, unless it is the card itself
  const defaultImportDest = (source: string) =>
    folder && !(source && isSameFolder(folder, source)) ? folder : "";

  return {
    importSource,
    setImportSource,
    importProgress,
    openImport,
    runImport,
    handleCancelImport,
    defaultImportDest,
  };
}
