import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { documentDir, join } from "@tauri-apps/api/path";
import { getSettings, updateSettings, useSettings } from "../../settings";
import {
  AUTO_BACKUP_KEEP,
  AUTO_BACKUP_PREFIX,
  SETTINGS_PREFIX,
  backupDue,
  backupName,
  remapSettings,
  type RootRemap,
} from "../../utils/backup";
import type { BackupManifest, BackupResult, RestoreResult } from "../../types/lumina";
import type { LibraryCore } from "./core";

// The first automatic backup waits until Lumina has settled after starting; later ones are checked hourly
const AUTO_FIRST_DELAY_MS = 3 * 60_000;
const AUTO_CHECK_MS = 60 * 60_000;

function settingsSnapshot(): string {
  const saved: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(SETTINGS_PREFIX)) saved[key] = localStorage.getItem(key) ?? "";
    }
  } catch {}
  return JSON.stringify(saved);
}

export async function defaultBackupDir(): Promise<string> {
  return join(await documentDir(), "Lumina Backups");
}

// Backing up the library (now or on a schedule), restoring a backup with its folders moved, and a CSV
export function useBackup(core: LibraryCore, recentFolders: string[]) {
  const { folder, addLog, setError, setAutoMatchNotice, confirmAction } = core;
  const { autoBackup } = useSettings();
  const [backupBusy, setBackupBusy] = useState<"backup" | "restore" | "csv" | null>(null);
  // The backup chosen to restore, with what it holds (null = dialog closed)
  const [restoreTarget, setRestoreTarget] = useState<{ path: string; manifest: BackupManifest } | null>(null);
  const busyRef = useRef(false);
  const knownRootsRef = useRef<string[]>([]);
  knownRootsRef.current = [folder, ...recentFolders].filter(Boolean);

  async function backupNow(kind: "manual" | "auto" = "manual"): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBackupBusy("backup");
    try {
      const destDir = getSettings().backupDir || (await defaultBackupDir());
      const result = await invoke<BackupResult>("backup_library", {
        destDir,
        name: backupName(kind),
        knownRoots: knownRootsRef.current,
        settings: settingsSnapshot(),
        keep: kind === "auto" ? AUTO_BACKUP_KEEP : null,
        keepPrefix: kind === "auto" ? AUTO_BACKUP_PREFIX : null,
      });
      updateSettings({ lastBackupAt: Date.now() });
      const mb = (result.bytes / 1_048_576).toFixed(result.bytes < 10_485_760 ? 1 : 0);
      addLog("DISK", `${kind === "auto" ? "Automatic backup" : "Backup"} saved (${mb} MB)`, result.path);
      if (kind === "manual") setAutoMatchNotice(`Library backed up (${mb} MB) to ${result.path}`);
      return true;
    } catch (err) {
      setError(`Backup failed: ${String(err)}`);
      return false;
    } finally {
      busyRef.current = false;
      setBackupBusy(null);
    }
  }

  // Automatic backups: once Lumina has settled, then whenever the chosen interval has passed
  const backupNowRef = useRef(backupNow);
  backupNowRef.current = backupNow;
  useEffect(() => {
    if (autoBackup === "off") return;
    const check = () => {
      const s = getSettings();
      if (backupDue(s.autoBackup, s.lastBackupAt)) void backupNowRef.current("auto");
    };
    const first = window.setTimeout(check, AUTO_FIRST_DELAY_MS);
    const every = window.setInterval(check, AUTO_CHECK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [autoBackup]);

  async function chooseBackupToRestore() {
    const picked = await open({
      multiple: false,
      defaultPath: getSettings().backupDir || (await defaultBackupDir().catch(() => undefined)),
      filters: [{ name: "Lumina backup", extensions: ["luminabackup"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const manifest = await invoke<BackupManifest>("inspect_backup", { path: picked });
      setRestoreTarget({ path: picked, manifest });
    } catch (err) {
      setError(String(err));
    }
  }

  // Prepares the backup for the next start (paths moved to `remaps`), puts its settings back and restarts
  async function runRestore(remaps: RootRemap[]) {
    if (!restoreTarget || busyRef.current) return;
    const ok = await confirmAction(
      "Lumina restarts with the library from this backup. Your current library is kept as a safety copy in Lumina's data folder.",
      "Restore and restart"
    );
    if (!ok) return;
    busyRef.current = true;
    setBackupBusy("restore");
    try {
      const result = await invoke<RestoreResult>("restore_library", { path: restoreTarget.path, remaps });
      if (result.settings) {
        try {
          const saved = remapSettings(JSON.parse(result.settings), remaps);
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (key?.startsWith(SETTINGS_PREFIX)) localStorage.removeItem(key);
          }
          for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
        } catch {}
      }
      addLog("DISK", `Restored ${result.photos} photo(s) from a backup; restarting`, restoreTarget.path);
      await invoke("restart_app");
    } catch (err) {
      setError(`Restore failed: ${String(err)}`);
      busyRef.current = false;
      setBackupBusy(null);
    }
  }

  async function exportCsv() {
    const name = folder ? folder.split(/[\\/]/).filter(Boolean).pop() : "library";
    const dest = await save({
      defaultPath: `Lumina ${name}.csv`,
      filters: [{ name: "Spreadsheet (CSV)", extensions: ["csv"] }],
    });
    if (!dest) return;
    setBackupBusy("csv");
    try {
      const rows = await invoke<number>("export_library_csv", { destPath: dest, rootFolder: folder || null });
      setAutoMatchNotice(`${rows.toLocaleString()} photo(s) listed in ${dest}`);
    } catch (err) {
      setError(`CSV export failed: ${String(err)}`);
    } finally {
      setBackupBusy(null);
    }
  }

  return { backupBusy, backupNow, restoreTarget, setRestoreTarget, chooseBackupToRestore, runRestore, exportCsv };
}
