import { useEffect, useState } from "react";
import { Loader2, Undo2 } from "lucide-react";
import { call, mediaUrl } from "../../api";
import type { SimilarFaceCandidate } from "../../types/lumina";
import { plural } from "../../utils/plural";

// The faces ignored in "Who is this?" (strangers, faces on posters), the last ignored first. Selected faces are
// brought back: they are grouped and suggested again.
export default function IgnoredFaces({ folder, onBroughtBack }: { folder: string; onBroughtBack: () => void }) {
  const [faces, setFaces] = useState<SimilarFaceCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setFaces(null);
    call<SimilarFaceCandidate[]>("get_ignored_faces", { rootFolder: folder || null })
      .then((found) => live && setFaces(found))
      .catch((e) => live && setError(`Could not load the ignored faces: ${String(e)}`));
    return () => {
      live = false;
    };
  }, [folder]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function bringBack(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await call<number>("ignore_faces", { faceIds: ids, ignore: false });
      const back = new Set(ids);
      setFaces((prev) => (prev ?? []).filter((f) => !back.has(f.face_id)));
      setPicked(new Set());
      onBroughtBack();
    } catch (e) {
      setError(`Could not bring these faces back: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const all = faces ?? [];
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-3 bg-card border-b border-zinc-800/80 flex items-center justify-between gap-4 text-xs shrink-0">
        <div className="text-zinc-500">
          Faces you ignored are left out of the groups and of everyone's suggestions. Select the ones to bring back.
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {all.length > 0 && (
            <button
              onClick={() => setPicked(picked.size === all.length ? new Set() : new Set(all.map((f) => f.face_id)))}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300"
            >
              {picked.size === all.length ? "Select none" : "Select all"}
            </button>
          )}
          <button
            onClick={() => void bringBack([...picked])}
            disabled={picked.size === 0 || busy}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
            <span>Bring back {picked.size > 0 ? plural(picked.size, "face") : ""}</span>
          </button>
        </div>
      </div>
      {error && (
        <div role="alert" className="mx-6 mt-3 px-3 py-2 rounded-lg bg-red-950/70 border border-red-500/40 text-red-200 text-xs">
          {error}
        </div>
      )}
      {faces === null && !error ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-zinc-400 text-xs">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Loading the ignored faces…</span>
        </div>
      ) : all.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-zinc-500">No ignored faces.</div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="text-xs text-zinc-500 mb-3">{plural(all.length, "ignored face")}</div>
          <div className="flex flex-wrap gap-2">
            {all.map((f) => {
              const on = picked.has(f.face_id);
              return (
                <button
                  key={f.face_id}
                  onClick={() => toggle(f.face_id)}
                  aria-pressed={on}
                  title={f.photo_name}
                  className={`relative rounded-lg overflow-hidden border-2 ${on ? "border-emerald-400" : "border-transparent hover:border-zinc-600"}`}
                >
                  <img src={mediaUrl({ kind: "face", path: f.face_thumb })} alt="" loading="lazy" className={`w-20 h-20 object-cover ${on ? "" : "opacity-70"}`} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
