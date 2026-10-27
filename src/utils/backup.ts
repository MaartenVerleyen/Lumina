// Library backups on the frontend side: which settings go into a backup, and moving the folder paths in them
// to where the library lives after a restore (the database's paths are rewritten by the backend the same way).

export interface RootRemap {
  from: string;
  to: string;
}

// Settings that travel with a backup: every lumina_* entry, as stored
export const SETTINGS_PREFIX = "lumina_";

const isSep = (c: string) => c === "\\" || c === "/";
const trimSeps = (p: string) => p.replace(/[\\/]+$/, "");

function underRoot(path: string, root: string): boolean {
  const r = trimSeps(root);
  if (!r || path.length < r.length) return false;
  return path.slice(0, r.length).toLowerCase() === r.toLowerCase() && (path.length === r.length || isSep(path[r.length]));
}

// `path` moved from the longest matching remap's `from` to its `to`; null when no remap covers it
export function remapPath(path: string, remaps: RootRemap[]): string | null {
  let best: RootRemap | null = null;
  for (const r of remaps) {
    if (!r.from.trim() || !r.to.trim() || !underRoot(path, r.from)) continue;
    if (!best || trimSeps(r.from).length > trimSeps(best.from).length) best = r;
  }
  if (!best) return null;
  return trimSeps(best.to.trim()) + path.slice(trimSeps(best.from.trim()).length);
}

function remapValue(value: unknown, remaps: RootRemap[]): unknown {
  if (typeof value === "string") return remapPath(value, remaps) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapValue(v, remaps));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapValue(v, remaps)]));
  }
  return value;
}

// The saved settings with every folder path inside a remapped library moved along. Values are stored as
// text; JSON values are rewritten inside, plain text as a whole.
export function remapSettings(saved: Record<string, string>, remaps: RootRemap[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(saved)) {
    if (typeof raw !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      out[key] = remapPath(raw, remaps) ?? raw;
      continue;
    }
    out[key] = typeof parsed === "string" ? raw : JSON.stringify(remapValue(parsed, remaps));
  }
  return out;
}

// "Lumina backup 2026-10-27 2145": sortable, and the same for every automatic backup up to the date
export function backupName(kind: "manual" | "auto", now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${kind === "auto" ? AUTO_BACKUP_PREFIX : "Lumina backup"} ${stamp}`;
}

export const AUTO_BACKUP_PREFIX = "Lumina auto-backup";
export const AUTO_BACKUP_KEEP = 5;

export type AutoBackup = "off" | "daily" | "weekly";
const INTERVAL_MS: Record<Exclude<AutoBackup, "off">, number> = { daily: 86_400_000, weekly: 7 * 86_400_000 };

// Whether an automatic backup is due
export function backupDue(mode: AutoBackup, lastBackupAt: number, now = Date.now()): boolean {
  if (mode === "off") return false;
  return now - lastBackupAt >= INTERVAL_MS[mode];
}
