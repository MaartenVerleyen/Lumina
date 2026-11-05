import { useEffect, useSyncExternalStore } from "react";
import { callLocal, inDesktopApp, subscribeLocal } from "../api";
import type { BackgroundJob } from "../components/layout/BottomStatusBar";
import { formatBytes } from "../utils/photoHelpers";

// Uploads to and downloads from a server (client mode): the queues run in the app (src-tauri/src/transfers.rs)
// and survive a restart; this follows their progress and offers their buttons

export interface TransferProgress {
  running: boolean;
  files: number;
  done: number;
  // Upload: already on the server
  skipped: number;
  failed: number;
  bytes_total: number;
  bytes_done: number;
  current: string[];
  stage: string;
  failures: { name: string; error: string }[];
  // Backup: photos whose ratings, tags, albums and names went on at the server, or didn't; names put on
  // faces, waiting for the server to find the faces, and photos with a named face it didn't find
  values_sent: number;
  values_failed: number;
  // Why, for the first of them
  values_failures: { name: string; error: string }[];
  names_placed: number;
  names_waiting: number;
  names_unplaced: number;
}

export type TransferKind = "upload" | "download";

const state: Record<TransferKind, TransferProgress | null> = { upload: null, download: null };
let snapshot = { ...state };
const listeners = new Set<() => void>();
// Called when a queue finishes a file, to update "On this device"
const finishedListeners = new Set<() => void>();

function setProgress(kind: TransferKind, p: TransferProgress) {
  const before = state[kind];
  state[kind] = p;
  snapshot = { ...state };
  for (const l of listeners) l();
  if (!before || before.done !== p.done || before.skipped !== p.skipped) for (const l of finishedListeners) l();
}

let watching = false;
function watch() {
  if (watching || !inDesktopApp) return;
  watching = true;
  for (const kind of ["upload", "download"] as const) {
    callLocal<TransferProgress>("transfer_progress", { kind })
      .then((p) => setProgress(kind, p))
      .catch(() => {});
    subscribeLocal<TransferProgress>(`${kind}-progress`, (e) => setProgress(kind, e.payload));
  }
}

// Copies on this PC changed some other way (removed): "On this device" asks again
export function localCopiesChanged() {
  for (const l of finishedListeners) l();
}

export function onTransferFinished(listener: () => void): () => void {
  finishedListeners.add(listener);
  return () => finishedListeners.delete(listener);
}

export function useTransfers() {
  useEffect(watch, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot
  );
}

export function uploadPaths(server: string, paths: string[]) {
  return callLocal<{ queued: number; ignored: number }>("upload_paths", { server, paths });
}

// All photos → Back up now: photos of this PC's libraries to a server, with their values here when the
// account may edit there
export function backUp(server: string, hashes: string[], withValues: boolean) {
  return callLocal<{ queued: number; ignored: number }>("back_up", { server, hashes, withValues });
}

export function downloadOriginals(server: string, photos: { hash: string; name: string }[], folder: string) {
  return callLocal<number>("download_originals", { server, photos: photos.map((p) => [p.hash, p.name]), folder });
}

const transferAction = (command: string, kind: TransferKind) => () => {
  callLocal(command, { kind }).catch((e) => console.error(e));
};

// What a finished queue did, in one line ("Uploaded 12 of 340 · 328 already on the server")
export function transferSummary(kind: TransferKind, p: TransferProgress): string {
  const what = kind === "upload" ? "Uploaded" : "Downloaded";
  return [
    `${what} ${p.done} of ${p.files} file${p.files === 1 ? "" : "s"}`,
    p.skipped > 0 ? `${p.skipped} already on the server` : "",
    p.failed > 0 ? `${p.failed} failed (${p.failures[0]?.name}: ${p.failures[0]?.error})` : "",
    ...(kind === "upload" ? backupSummary(p) : []),
  ]
    .filter(Boolean)
    .join(" · ");
}

// What a backup did with the photos' values, for the line above
export function backupSummary(p: TransferProgress): string[] {
  const photos = (n: number) => `${n} photo${n === 1 ? "" : "s"}`;
  const names = (n: number) => `${n} name${n === 1 ? "" : "s"}`;
  return [
    p.values_sent > 0 ? `ratings, tags and names went along for ${photos(p.values_sent)}` : "",
    p.values_failed > 0
      ? `not for ${photos(p.values_failed)}${p.values_failures[0] ? ` (${p.values_failures[0].name}: ${p.values_failures[0].error})` : ""}`
      : "",
    p.names_waiting > 0 ? `${names(p.names_waiting)} ${p.names_waiting === 1 ? "goes" : "go"} on once the server has found the faces` : "",
    p.names_unplaced > 0 ? `${photos(p.names_unplaced)} have a named face the server didn't find` : "",
  ];
}

// The queues as jobs in the status bar while they run, or while they wait to carry on (signed out, say).
// A finished queue is told once as a notice (useClientMode) and cleared.
export function transferJobs(progress: Record<TransferKind, TransferProgress | null>): BackgroundJob[] {
  const jobs: BackgroundJob[] = [];
  for (const kind of ["upload", "download"] as const) {
    const p = progress[kind];
    if (!p || p.files === 0) continue;
    const verb = kind === "upload" ? "Uploading" : "Downloading";
    const finished = p.done + p.skipped + p.failed;
    const waiting = p.files - finished;
    const failedNote = p.failed > 0 ? `${p.failed} failed (${p.failures[0]?.name}: ${p.failures[0]?.error})` : "";
    const skippedNote = p.skipped > 0 ? `${p.skipped} already on the server` : "";
    if (p.running) {
      jobs.push({
        id: `${kind}s`,
        label: `${verb} ${p.files} file${p.files === 1 ? "" : "s"}`,
        detail:
          [p.stage && p.stage !== "Uploading" && p.stage !== "Downloading" ? p.stage : p.current.join(", "), skippedNote, failedNote]
            .filter(Boolean)
            .join(" · ") || `${formatBytes(p.bytes_done)} of ${formatBytes(p.bytes_total)}`,
        // Bytes, so the time left follows big files too; downloads don't know their sizes up front
        completed: kind === "upload" && p.bytes_total > 0 ? p.bytes_done : finished,
        total: kind === "upload" && p.bytes_total > 0 ? p.bytes_total : p.files,
        onCancel: transferAction("cancel_transfers", kind),
      });
    } else if (waiting > 0) {
      jobs.push({
        id: `${kind}s`,
        label: `${verb} paused: ${waiting} file${waiting === 1 ? "" : "s"} left`,
        detail: [p.stage, skippedNote, failedNote].filter(Boolean).join(" · "),
        completed: finished,
        total: p.files,
        onCancel: transferAction("cancel_transfers", kind),
        action: { label: "Try again", onClick: transferAction("retry_transfers", kind) },
      });
    }
  }
  return jobs;
}

export function clearTransfers(kind: TransferKind) {
  return callLocal("clear_transfers", { kind });
}
