import { useEffect, useRef } from "react";
import { openLibraryIsAll, openLibraryServer, callLocal, subscribeLocal, originalsOf, allPhotosSources, serversHolding } from "../api";
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
      // The open library's server, or one of All photos' (its photos leave the view)
      if (e.payload.server === serverRef.current || openLibraryIsAll())
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

  // Files or folders dropped on the window: uploaded when a server's library is open, opened otherwise. A file
  // (it has an extension) can't be opened as a library: its folder can.
  async function onDropPaths(paths: string[]) {
    if (server) {
      if (access.upload) upload(paths);
      else lib.setAutoMatchNotice(`Your account can't add photos to ${label}.`);
      return;
    }
    if (!platform.fullApp) {
      lib.setAutoMatchNotice("Open a library on a server first, then drop photos on the window to upload them.");
      return;
    }
    const first = paths[0];
    if (!first) return;
    const name = first.split(/[\\/]/).pop() ?? "";
    if (/\.[A-Za-z0-9]{1,5}$/.test(name)) {
      const parent = first.slice(0, first.length - name.length).replace(/[\\/]+$/, "");
      if (parent && (await confirmDialog(`Open the folder ${name} is in as a library?\n\n${parent}`, { title: "Open its folder?", okLabel: "Open folder" }))) {
        lib.handleLoadFolderPath(parent);
      }
      return;
    }
    lib.handleLoadFolderPath(first);
  }

  // What dropping files on the window does here, for the overlay shown while they are dragged
  const dropHint = server
    ? access.upload
      ? `Drop photos or folders to upload them to ${label}`
      : `Your account can't add photos to ${label}`
    : platform.fullApp
      ? "Drop a folder to open it"
      : "Open a library on a server to upload photos";

  async function pickAndUpload() {
    const picked = await open({ multiple: true, directory: false, title: `Upload photos to ${label}` });
    if (!picked) return;
    upload(Array.isArray(picked) ? picked : [picked]);
  }

  function selectedPhotos() {
    return lib.visiblePhotos.filter((p) => lib.selectedHashes.has(p.hash)).map((p) => ({ hash: p.hash, name: p.name }));
  }

  // The originals of the selected photos into a folder on this computer: from the open server library, or in
  // All photos from the server each photo is on (photos already on this computer are left as they are)
  async function downloadSelection() {
    const photos = selectedPhotos();
    if (photos.length === 0) return;
    const { local, byServer } = originalsOf(photos.map((p) => p.hash));
    const onServers = [...byServer.values()].reduce((n, list) => n + list.length, 0);
    if (onServers === 0) {
      lib.setAutoMatchNotice(`${local.length === 1 ? "This photo is" : "These photos are"} on this PC already.`);
      return;
    }
    let defaultPath: string | undefined;
    try {
      defaultPath = await join(await pictureDir(), "Lumina", server ? label : "Downloads");
    } catch {
      // no Pictures folder: the picker starts where it likes
    }
    const folder = await open({ directory: true, multiple: false, title: `Download ${plural(onServers, "original")} to…`, defaultPath });
    if (!folder || Array.isArray(folder)) return;
    const names = new Map(photos.map((p) => [p.hash, p.name]));
    try {
      let queued = 0;
      for (const [from, hashes] of byServer) {
        queued += await downloadOriginals(from, hashes.map((hash) => ({ hash, name: names.get(hash) ?? hash })), folder);
      }
      const here = local.length > 0 ? ` (${plural(local.length, "photo")} on this PC already left out)` : "";
      lib.setAutoMatchNotice(`Downloading ${queued} original${queued === 1 ? "" : "s"} to ${folder}${here}.`);
    } catch (e) {
      lib.setError(String(e));
    }
  }

  // The downloaded copies on this PC of photos a server has go to the Recycle Bin (in All photos, per server)
  async function removeLocalSelection() {
    const hashes = selectedPhotos().map((p) => p.hash);
    const byServer = serversHolding(hashes);
    if (byServer.size === 0) {
      lib.setAutoMatchNotice("None of these photos is on a server, so there is no copy to remove: they are only on this PC.");
      return;
    }
    const where = server ? label : "the server";
    const ok = await confirmDialog(
      `The copies on this PC of the ${plural(hashes.length, "selected photo", "selected photos")} go to the Recycle Bin, but only for photos ${where} has. The server's photos stay as they are.`,
      { title: "Remove from this PC?", kind: "warning", okLabel: "Remove from this PC", cancelLabel: "Keep" }
    );
    if (!ok) return;
    try {
      type Removed = { removed: number; kept_not_on_server: number; in_library: number; failed: string[] };
      const parts = await Promise.all(
        [...byServer].map(([from, list]) => callLocal<Removed>("remove_local_copies", { server: from, hashes: list }))
      );
      const r = parts.reduce<Removed>(
        (acc, p) => ({
          removed: acc.removed + p.removed,
          kept_not_on_server: acc.kept_not_on_server + p.kept_not_on_server,
          in_library: acc.in_library + p.in_library,
          failed: [...acc.failed, ...p.failed],
        }),
        { removed: 0, kept_not_on_server: hashes.length - [...byServer.values()].reduce((n, l) => n + l.length, 0), in_library: 0, failed: [] }
      );
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
    dropHint,
    pickAndUpload: server && access.upload ? pickAndUpload : undefined,
    downloadSelection: server || (openLibraryIsAll() && [...allPhotosSources().values()].some((s) => s.server !== null)) ? downloadSelection : undefined,
    removeLocalSelection: server || (openLibraryIsAll() && [...allPhotosSources().values()].some((s) => s.server !== null)) ? removeLocalSelection : undefined,
    jobs: transferJobs(transfers),
  };
}
