import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { FaceCluster, FaceInstance, PhotoItem } from "../../types/lumina";
import { Check, Loader2, RefreshCw, Users } from "lucide-react";

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

  async function load() {
    setIsLoading(true);
    setError("");
    try {
      setClusters(await invoke<FaceCluster[]>("get_unknown_face_clusters", { rootFolder: folder || null }));
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
      const updated = await invoke<Record<string, FaceInstance[]>>("assign_faces_to_person_batch", {
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

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-3 bg-card border-b border-zinc-800/80 flex items-center justify-between text-xs shrink-0">
        <div className="text-zinc-300">
          <span className="font-bold text-zinc-100">Who is this?</span>
          <span className="text-zinc-500 ml-2">
            Unnamed faces that look like the same person. Name a group to assign all of its faces at once.
          </span>
        </div>
        <button
          onClick={load}
          disabled={isLoading}
          className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          <span>Regroup</span>
        </button>
      </div>

      {error && (
        <div role="alert" className="mx-6 mt-3 px-3 py-2 rounded-lg bg-red-950/70 border border-red-500/40 text-red-200 text-xs">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-zinc-400 text-xs">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
          <span>Grouping unknown faces…</span>
        </div>
      ) : clusters.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center p-8 text-xs text-zinc-400">
          <Users className="w-8 h-8 text-zinc-600" />
          <span className="text-sm font-bold text-zinc-200">No groups of unknown faces</span>
          <span>Every recurring face is either named or already suggested for someone. Run Scan Faces to find more.</span>
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
                  <img
                    key={face.face_id}
                    src={convertFileSrc(face.face_thumb)}
                    alt=""
                    title={face.photo_name}
                    loading="lazy"
                    className="w-16 h-16 rounded-lg object-cover border border-zinc-800"
                  />
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
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="submit"
                  disabled={!names[index]?.trim() || busy !== null}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold flex items-center gap-1.5"
                >
                  {busy === index ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>Name all {cluster.size}</span>
                </button>
              </form>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
