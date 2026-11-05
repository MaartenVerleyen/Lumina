import { useEffect, useState } from "react";
import { FolderDown, Loader2, X } from "lucide-react";
import { allPhotosSources, callLocal } from "../../api";
import { open } from "../../api/platform";
import { useDialogFocus } from "../../hooks/useDialogFocus";

export interface FollowTarget {
  // The album on its server: the server and the album's own id there
  server: string;
  albumId: number;
  name: string;
  source: string;
}

// Follow an album shared with you (docs/plans/one-view.md, milestone 4): its photos come into a library of
// yours, a folder on this PC or a library of a server where you may upload, with their tags and people names,
// and new ones follow by themselves. They are yours to keep, also when the album stops being shared.
export default function FollowAlbumDialog({ album, onClose, onFollowed }: { album: FollowTarget | null; onClose: () => void; onFollowed: () => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(album !== null);
  const sources = [...allPhotosSources().values()];
  const firstFolder = sources.find((s) => s.server === null)?.root;
  const servers = [...new Map(sources.filter((s) => s.server && s.server !== album?.server && s.uploadable).map((s) => [s.server!, s.label])).entries()];
  const [into, setInto] = useState<string>("pc");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!album) return;
    const sep = firstFolder?.includes("\\") ? "\\" : "/";
    setFolder(firstFolder ? `${firstFolder.replace(/[\\/]+$/, "")}${sep}${album.name.replace(/[\\/:*?"<>|]/g, "_")}` : "");
    setInto("pc");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [album]);

  if (!album) return null;

  async function choose() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") setFolder(picked);
  }

  async function follow() {
    if (!album) return;
    setBusy(true);
    setError(null);
    try {
      await callLocal("follow_album", {
        server: album.server,
        albumId: album.albumId,
        albumName: album.name,
        folder: into === "pc" ? folder : null,
        uploadTo: into === "pc" ? null : into,
      });
      onFollowed();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const option = "flex items-start gap-2 p-2 rounded-lg border cursor-pointer";
  return (
    <div onClick={onClose} className="fixed inset-0 z-[9995] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Follow ${album.name}`}
        onClick={(e) => e.stopPropagation()}
        className="bg-raised border border-zinc-800 rounded-2xl w-full max-w-md p-5 shadow-2xl flex flex-col gap-3 text-xs"
      >
        <div className="flex items-center justify-between">
          <span className="font-bold text-sm text-zinc-100 flex items-center gap-2 min-w-0">
            <FolderDown className="w-4 h-4 text-sky-400 shrink-0" />
            <span className="truncate">Follow “{album.name}”</span>
          </span>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-zinc-400 leading-relaxed">
          The album's photos come into a library of yours, with who is in them and their tags, and photos added to the
          album later follow by themselves. They are yours to keep, also if {album.source} stops sharing the album.
        </p>
        <label className={`${option} ${into === "pc" ? "border-sky-500/50 bg-sky-950/20" : "border-zinc-800"}`}>
          <input type="radio" checked={into === "pc"} onChange={() => setInto("pc")} className="mt-0.5" />
          <span className="flex flex-col gap-1.5 flex-1 min-w-0">
            <span className="text-zinc-200">A folder on this PC</span>
            <span className="flex gap-1">
              <input
                value={folder}
                onChange={(e) => {
                  setFolder(e.target.value);
                  setInto("pc");
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-zinc-200 select-text focus:outline-none focus:border-sky-500"
                aria-label="Folder"
              />
              <button type="button" onClick={choose} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200">
                Choose…
              </button>
            </span>
          </span>
        </label>
        {servers.map(([id, label]) => (
          <label key={id} className={`${option} ${into === id ? "border-sky-500/50 bg-sky-950/20" : "border-zinc-800"}`}>
            <input type="radio" checked={into === id} onChange={() => setInto(id)} className="mt-0.5" />
            <span className="flex flex-col">
              <span className="text-zinc-200">{label.includes(": ") ? label.slice(0, label.lastIndexOf(": ")) : label}</span>
              <span className="text-zinc-500">A library there where you may upload; the photos pass through this PC while the app runs</span>
            </span>
          </label>
        ))}
        {error && <p className="text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">
            Cancel
          </button>
          <button
            type="button"
            onClick={follow}
            disabled={busy || (into === "pc" && !folder.trim())}
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-semibold flex items-center gap-1.5"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Follow
          </button>
        </div>
      </div>
    </div>
  );
}
