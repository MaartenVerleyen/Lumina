import { useEffect, useState } from "react";
import { call, mediaUrl } from "../../api";
import { FaceCluster, FaceInstance, PhotoItem } from "../../types/lumina";
import { Check, EyeOff, Loader2, RefreshCw, Undo2, Users, X } from "lucide-react";

interface UnknownFaceClustersProps {
  folder: string;
  peopleNames: string[];
  setPhotos: React.Dispatch<React.SetStateAction<PhotoItem[]>>;
  refreshPeople: (currentFolder?: string, skipPendingScan?: boolean) => Promise<void>;
}

// "Who is this?": groups of unnamed faces that look like the same person. Naming a group assigns every face
// in it at once; those faces then also serve as references for future suggestions.
export default function UnknownFaceClusters({
  folder,
  peopleNames,
  setPhotos,
  refreshPeople,
}: UnknownFaceClustersProps) {
  const [clusters, setClusters] = useState<FaceCluster[]>([]);
  const [names, setNames] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  // The last faces ignored, for Undo
  const [lastIgnored, setLastIgnored] = useState<string[] | null>(null);

  async function load() {
    setIsLoading(true);
    setError("");
    try {
      setClusters(await call<FaceCluster[]>("get_unknown_face_clusters", { rootFolder: folder || null }));
      setNames({});
    } catch (err) {
      setError(`Could not group unknown faces: ${String(err)}`);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [folder]);

  async function nameCluster(index: number) {
    const name = (names[index] || "").trim();
    const cluster = clusters[index];
    if (!name || !cluster) return;
    setBusy(index);
    setError("");
    try {
      const updated = await call<Record<string, FaceInstance[]>>("assign_faces_to_person_batch", {
        faceIds: cluster.face_ids,
        personName: name,
      });
      setPhotos((prev) =>
        prev.map((p) => {
          const faces = updated[p.hash];
          if (!faces) return p;
          const names = new Set([...p.people, ...faces.map((f) => f.person_name?.trim()).filter((n): n is string => Boolean(n))]);
          return { ...p, faces, people: Array.from(names).sort() };
        })
      );
      setClusters((prev) => prev.filter((_, i) => i !== index));
      setNames({});
      await refreshPeople();
    } catch (err) {
      setError(`Could not name this group: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  // Ignore a whole group (strangers, faces on posters) or one face that doesn't belong in its group, without
  // naming anyone: they are no longer grouped or suggested
  async function ignoreFaces(index: number, faceIds: string[]) {
    setError("");
    try {
      await call<number>("ignore_faces", { faceIds, ignore: true });
      const ignored = new Set(faceIds);
      setClusters((prev) =>
        prev
          .map((c, i) =>
            i !== index
              ? c
              : {
                  ...c,
                  size: c.size - faceIds.length,
                  face_ids: c.face_ids.filter((id) => !ignored.has(id)),
                  samples: c.samples.filter((f) => !ignored.has(f.face_id)),
                }
          )
          .filter((c) => c.size >= 2)
      );
      setNames({});
      setLastIgnored(faceIds);
    } catch (err) {
      setError(`Could not ignore these faces: ${String(err)}`);
    }
  }

  async function undoIgnore() {
    if (!lastIgnored) return;
    try {
      await call<number>("ignore_faces", { faceIds: lastIgnored, ignore: false });
      setLastIgnored(null);
      await load();
    } catch (err) {
      setError(`Could not undo: ${String(err)}`);
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-3 bg-card border-b border-zinc-800/80 flex items-center justify-between text-xs shrink-0">
        <div className="text-zinc-300">
          <span className="font-bold text-zinc-100">Who is this?</span>
          <span className="text-zinc-500 ml-2">
            Unnamed faces that look like the same person. Name a group to assign all of its faces at once, or
            ignore faces you don't want to name.
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {lastIgnored && (
            <button
              onClick={undoIgnore}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 flex items-center gap-1.5"
            >
              <Undo2 className="w-3.5 h-3.5" />
              <span>
                Undo ignore ({lastIgnored.length} face{lastIgnored.length === 1 ? "" : "s"})
              </span>
            </button>
          )}
          <button
            onClick={load}
            disabled={isLoading}
            className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            <span>Regroup</span>
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="mx-6 mt-3 px-3 py-2 rounded-lg bg-red-950/70 border border-red-500/40 text-red-200 text-xs">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-zinc-400 text-xs">
          <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
          <span>Grouping unknown faces…</span>
        </div>
      ) : clusters.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center p-8 text-xs text-zinc-400">
          <Users className="w-8 h-8 text-zinc-600" />
          <span className="text-sm font-bold text-zinc-200">No groups of unknown faces</span>
          <span>Every recurring face is either named or already suggested for someone. Run Scan faces to find more.</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-3">
          <datalist id="known-people">
            {peopleNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {clusters.map((cluster, index) => (
            <div key={cluster.face_ids[0]} className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800 flex flex-col gap-2.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                {cluster.samples.map((face) => (
                  <div key={face.face_id} className="relative group">
                    <img
                      src={mediaUrl({ kind: "face", path: face.face_thumb })}
                      alt=""
                      title={face.photo_name}
                      loading="lazy"
                      className="w-16 h-16 rounded-lg object-cover border border-zinc-800"
                    />
                    <button
                      onClick={() => ignoreFaces(index, [face.face_id])}
                      disabled={busy !== null}
                      title="Ignore this face (not part of this group)"
                      aria-label="Ignore this face"
                      className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-zinc-950/85 border border-zinc-700 text-zinc-300 hover:text-red-300 hover:border-red-500/60 items-center justify-center hidden group-hover:flex"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {cluster.size > cluster.samples.length && (
                  <span className="text-[11px] text-zinc-500 font-mono px-2">
                    +{cluster.size - cluster.samples.length} more
                  </span>
                )}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  nameCluster(index);
                }}
                className="flex items-center gap-2 text-xs"
              >
                <span className="text-zinc-400 font-mono shrink-0">{cluster.size} faces</span>
                <input
                  list="known-people"
                  value={names[index] || ""}
                  onChange={(e) => setNames((prev) => ({ ...prev, [index]: e.target.value }))}
                  placeholder="Who is this? (new or existing name)"
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-emerald-500/80"
                />
                <button
                  type="submit"
                  disabled={!names[index]?.trim() || busy !== null}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold flex items-center gap-1.5"
                >
                  {busy === index ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>Name all {cluster.size}</span>
                </button>
                <button
                  type="button"
                  onClick={() => ignoreFaces(index, cluster.face_ids)}
                  disabled={busy !== null}
                  title="Don't name these faces: they are no longer grouped or suggested"
                  className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 border border-zinc-800 text-zinc-300 flex items-center gap-1.5"
                >
                  <EyeOff className="w-3.5 h-3.5" />
                  <span>Ignore</span>
                </button>
              </form>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
