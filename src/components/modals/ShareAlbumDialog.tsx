import { useEffect, useState } from "react";
import { Check, Loader2, Share2, X } from "lucide-react";
import { call, type Role } from "../../api";
import { useDialogFocus } from "../../hooks/useDialogFocus";

interface ShareUser {
  name: string;
  role: Role;
}

const WHO: Record<Role, string> = {
  guest: "sees only what is shared",
  viewer: "already sees the library",
  uploader: "already sees the library",
  editor: "already sees the library",
  admin: "sees everything",
};

// Share an album with other people on the server (the web client; the desktop app has no users). A guest
// sees only the albums shared with them; someone whose role already shows the library gets nothing more,
// unless their role on that library is guest.
export default function ShareAlbumDialog({ album, onClose }: { album: { id: number; name: string } | null; onClose: () => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(album !== null);
  const [users, setUsers] = useState<ShareUser[] | null>(null);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!album) return;
    setUsers(null);
    setError(null);
    Promise.all([call<ShareUser[]>("list_share_users"), call<string[]>("get_album_shares", { id: album.id })])
      .then(([list, names]) => {
        setUsers(list);
        setShared(new Set(names.map((n) => n.toLowerCase())));
      })
      .catch((e) => setError(String(e)));
  }, [album]);

  if (!album) return null;

  async function toggle(name: string) {
    if (!album) return;
    const on = !shared.has(name.toLowerCase());
    setBusy(name);
    setError(null);
    try {
      await call("share_album", { id: album.id, userName: name, shared: on });
      setShared((prev) => {
        const next = new Set(prev);
        if (on) next.add(name.toLowerCase());
        else next.delete(name.toLowerCase());
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-[9995] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${album.name}`}
        onClick={(e) => e.stopPropagation()}
        className="bg-raised border border-zinc-800 rounded-2xl w-full max-w-md p-5 shadow-2xl flex flex-col gap-3 text-xs"
      >
        <div className="flex items-center justify-between">
          <span className="font-bold text-sm text-zinc-100 flex items-center gap-2 min-w-0">
            <Share2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="truncate">Share “{album.name}”</span>
          </span>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-zinc-400 leading-relaxed">
          The people you tick can look at the photos in this album (not change them), also if they may not see the rest of
          the library.
        </p>
        {error && <p className="text-red-400">{error}</p>}
        {users === null && !error ? (
          <div className="flex items-center gap-2 text-zinc-400 py-3">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-400" /> Loading…
          </div>
        ) : users && users.length === 0 ? (
          <p className="text-zinc-400 py-2">There's nobody else on this server yet.</p>
        ) : (
          <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
            {users?.map((u) => {
              const on = shared.has(u.name.toLowerCase());
              return (
                <button
                  key={u.name}
                  onClick={() => toggle(u.name)}
                  disabled={busy !== null}
                  aria-pressed={on}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition ${
                    on ? "bg-emerald-500/15 border-emerald-500/40" : "bg-zinc-900 border-zinc-800 hover:bg-zinc-800"
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                      on ? "bg-emerald-500 border-emerald-400" : "border-zinc-600"
                    }`}
                  >
                    {busy === u.name ? <Loader2 className="w-3 h-3 animate-spin text-white" /> : on && <Check className="w-3 h-3 text-white" />}
                  </span>
                  <span className="font-medium text-zinc-100 truncate">{u.name}</span>
                  <span className="ml-auto text-[11px] text-zinc-500 shrink-0">
                    {u.role} · {WHO[u.role]}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="flex justify-end pt-1">
          <button onClick={onClose} className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-semibold">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
