import { useSyncExternalStore } from "react";
import { callLocal, onAndroid } from "../../api";

// The phone's backup (phone_backup.rs) as the screens show it: the header's ring, the photos uploading in the
// grid, the banner, the Backup page. One look for all of them, every 2 s (every second while it runs or waits),
// only while shown.

export interface BackupSettings {
  enabled: boolean;
  server: string | null;
  wifiOnly: boolean;
  charging: boolean;
  videos: boolean;
  // The phone's folders backed up ("DCIM/Camera/")
  folders: string[];
}

export interface BackupProgress {
  running: boolean;
  stage: string;
  files: number;
  done: number;
  failed: number;
  bytes_total: number;
  bytes_done: number;
  uploading: string[];
  failures: [string, string][];
}

export interface BackupStatus {
  progress: BackupProgress;
  // A Back up now Android hasn't started yet (waiting for Wi-Fi)
  waiting: boolean;
  last: { at: number; uploaded: number; failed: number; outcome: string } | null;
  backed_up: number;
  total: number;
}

interface State {
  settings: BackupSettings | null;
  status: BackupStatus | null;
  uploading: Set<string>;
}

let state: State = { settings: null, status: null, uploading: new Set() };
const listeners = new Set<() => void>();
let timer: number | null = null;
let polling = false;
// Asked again while a look was under way (refreshBackup): look again as soon as it is done
let again = false;

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

async function poll() {
  if (polling) {
    again = true;
    return;
  }
  polling = true;
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  try {
    const settings = state.settings ?? (await callLocal<BackupSettings>("phone_backup_settings"));
    let status: BackupStatus | null = null;
    if (settings.server) {
      status = await callLocal<BackupStatus>("phone_backup_status", { server: settings.server, videos: settings.videos, folders: settings.folders });
    }
    const uploading = status?.progress.running ? new Set(status.progress.uploading) : new Set<string>();
    // The same set while nothing changed, so the grid doesn't draw again every second
    const same = uploading.size === state.uploading.size && [...uploading].every((h) => state.uploading.has(h));
    set({ settings, status, uploading: same ? state.uploading : uploading });
  } catch {
    // The next look tries again
  }
  polling = false;
  // Looking on while anything shows it (the loop starts and stops with its listeners)
  if (listeners.size === 0) return;
  if (again) {
    again = false;
    void poll();
    return;
  }
  const busy = state.status?.progress.running || state.status?.waiting;
  timer = window.setTimeout(poll, busy ? 1000 : 2000);
}

// After Backup's settings changed: shown at once, and the counts asked again
export function setBackupSettings(settings: BackupSettings) {
  set({ settings });
  refreshBackup();
}

export function refreshBackup() {
  if (onAndroid) void poll();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && onAndroid) void poll();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
}

export function usePhoneBackup(): State {
  return useSyncExternalStore(subscribe, () => state);
}
