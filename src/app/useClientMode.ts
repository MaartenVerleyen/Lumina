import { useEffect, useRef } from "react";
import { openLibraryIsAll, openLibraryServer, callLocal, subscribeLocal } from "../api";
import { open, pictureDir, join, platform } from "../api/platform";
import { confirmDialog } from "../confirm";
import type { LibraryState } from "../hooks/useLibraryState";
import type { Access } from "../components/auth/ServerGate";
import {
  clearTransfers,
  downloadOriginals,
  localCopiesChanged,
  transferJobs,
  transferSummary,
  uploadPaths,
  useTransfers,
  type TransferKind,
} from "../hooks/useTransfers";
import { useOnDeviceTracking } from "../hooks/useOnDevice";
import { useServers } from "../hooks/useServers";
import { plural } from "../utils/plural";

// A server's library open in the desktop app: uploading to it, downloading its originals, and which of its
// photos are on this PC. Everything here is a no-op for a library on this computer.
export function useClientMode(lib: LibraryState, access: Access) {
  const transfers = useTransfers();
  const { servers } = useServers();
  useOnDeviceTracking(lib.photos);
  const server = openLibraryServer();
  const label = servers.find((s) => s.id === server)?.label ?? server ?? "";

  // A queue that finished: what it did, once, then off the list (a failed file can be tried again by
  // uploading or downloading it once more)
  const wasRunning = useRef<Record<TransferKind, boolean>>({ upload: false, download: false });
  useEffect(() => {
    for (const kind of ["upload", "download"] as const) {
      const p = transfers[kind];
      if (!p) continue;
      const finished = p.done + p.skipped + p.failed === p.files;
      if (wasRunning.current[kind] && !p.running && finished && p.files > 0) {
        const text = transferSummary(kind, p);
        if (p.failed > 0) lib.setError(text);
        else lib.setAutoMatchNotice(text + ".");
        clearTransfers(kind).catch(() => {});
        // A backup: the photos it sent are on the server now, so their marks change
        if (kind === "upload" && openLibraryIsAll()) void lib.silentRescan();
      }
      wasRunning.current[kind] = p.running;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers]);

  // The server ended the session of the library open now: say so, rather than let it fail quietly
  const serverRef = useRef(server);
  serverRef.current = server;
  useEffect(() => {
    const off = subscribeLocal<{ server: string }>("remote-signed-out", (e) => {
      if (e.payload.server === serverRef.current)
        lib.setError(`Signed out of ${e.payload.server} (the password changed, or the account was removed). Sign in again in Settings → Servers.`);
    });
    return () => {
      off.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function upload(paths: string[]) {
    if (!server || paths.length === 0) return;
    if (!access.upload) {
      lib.setAutoMatchNotice(`Your account on ${label} can't upload photos (that needs the uploader role).`);
      return;
    }
    try {
      const { queued, ignored } = await uploadPaths(server, paths);
      const skipped = ignored > 0 ? ` (${ignored} file${ignored === 1 ? "" : "s"} that aren't photos or videos left out)` : "";
      lib.setAutoMatchNotice(
        queued > 0
          ? `Uploading ${queued} file${queued === 1 ? "" : "s"} to ${label}${skipped}. Files the server already has are skipped.`
          : `Nothing to upload${skipped}.`
      );
    } catch (e) {
      lib.setError(String(e));
    }
  }

  // Files or folders dropped on the window: uploaded when a server's library is open, opened otherwise
  function onDropPaths(paths: string[]) {
    if (server) upload(paths);
    else if (!platform.fullApp) lib.setAutoMatchNotice("Open a library on a server first, then drop photos on the window to upload them.");
    else if (paths[0]) lib.handleLoadFolderPath(paths[0]);
  }

  async function pickAndUpload() {
    const picked = await open({ multiple: true, directory: false, title: `Upload photos to ${label}` });
    if (!picked) return;
    upload(Array.isArray(picked) ? picked : [picked]);
  }

  function selectedPhotos() {
    return lib.visiblePhotos.filter((p) => lib.selectedHashes.has(p.hash)).map((p) => ({ hash: p.hash, name: p.name }));
  }

  async function downloadSelection() {
    if (!server) return;
    const photos = selectedPhotos();
    if (photos.length === 0) return;
    let defaultPath: string | undefined;
    try {
      defaultPath = await join(await pictureDir(), "Lumina", label);
    } catch {
      // no Pictures folder: the picker starts where it likes
    }
    const folder = await open({ directory: true, multiple: false, title: `Download ${plural(photos.length, "original")} to…`, defaultPath });
    if (!folder || Array.isArray(folder)) return;
    try {
      const queued = await downloadOriginals(server, photos, folder);
      lib.setAutoMatchNotice(`Downloading ${queued} original${queued === 1 ? "" : "s"} to ${folder}.`);
    } catch (e) {
      lib.setError(String(e));
    }
  }

  async function removeLocalSelection() {
    if (!server) return;
    const hashes = selectedPhotos().map((p) => p.hash);
    const ok = await confirmDialog(
      `The copies on this PC of the ${plural(hashes.length, "selected photo", "selected photos")} go to the Recycle Bin, but only for photos ${label} has. The server's photos stay as they are.`,
      { title: "Remove from this PC?", kind: "warning", okLabel: "Remove from this PC", cancelLabel: "Keep" }
    );
    if (!ok) return;
    try {
      const r = await callLocal<{ removed: number; kept_not_on_server: number; in_library: number; failed: string[] }>("remove_local_copies", {
        server,
        hashes,
      });
      const notes = [
        `${r.removed} cop${r.removed === 1 ? "y" : "ies"} moved to the Recycle Bin`,
        r.kept_not_on_server > 0 ? `${r.kept_not_on_server} kept: the server doesn't have them` : "",
        r.in_library > 0 ? `${r.in_library} only in a library on this PC (remove those there)` : "",
        r.failed.length > 0 ? `${r.failed.length} couldn't be moved: ${r.failed[0]}` : "",
      ].filter(Boolean);
      lib.setAutoMatchNotice(notes.join("; ") + ".");
      localCopiesChanged();
    } catch (e) {
      lib.setError(String(e));
    }
  }

  return {
    server,
    serverLabel: label,
    onDropPaths,
    pickAndUpload: server && access.upload ? pickAndUpload : undefined,
    downloadSelection: server ? downloadSelection : undefined,
    removeLocalSelection: server ? removeLocalSelection : undefined,
    jobs: transferJobs(transfers),
  };
}
