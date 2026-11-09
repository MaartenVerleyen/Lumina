import { useEffect, useState } from "react";
import SpotlightPhoto from "./SpotlightPhoto";
import { plural } from "../../utils/plural";
import { call, mediaUrl } from "../../api";
import { FaceCluster, FaceInstance, PhotoItem } from "../../types/lumina";
import { Check, EyeOff, Loader2, Maximize2, RefreshCw, Undo2, Users, X } from "lucide-react";

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
  // Faces clicked away from their group (someone else in with them): named or ignored without them
  const [left, setLeft] = useState<Set<string>>(new Set());
  const kept = (c: FaceCluster) => c.face_ids.filter((id) => !left.has(id));
  // Naming gives the name only to the faces shown (and not left out): the rest of a big group comes back as
  // suggestions for that person, to check one by one in the review
  const shown = (c: FaceCluster) => c.samples.map((f) => f.face_id).filter((id) => !left.has(id));
  // A group opened in the larger view, and the face whose photo it shows
  const [large, setLarge] = useState<{ index: number; face: string } | null>(null);
  const toggleLeft = (id: string) =>
    setLeft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
        faceIds: shown(cluster),
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

  // Escape closes the larger view first, not the whole review behind it
  useEffect(() => {
    if (!large) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setLarge(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [large]);

  const largeGroup = large ? clusters[large.index] : undefined;
  const largeFace = largeGroup ? largeGroup.samples.find((f) => f.face_id === large?.face) ?? largeGroup.samples[0] : undefined;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-3 bg-card border-b border-zinc-800/80 flex items-center justify-between text-xs shrink-0">
        <div className="text-zinc-300">
          <span className="font-semibold text-zinc-100">Who is this?</span>
          <span className="text-zinc-500 ml-2">
            Unnamed faces that look like the same person. Click a face that is someone else to leave it out, then
            name the group, or ignore faces you don't want to name.
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
          <span className="text-sm font-semibold text-zinc-200">No groups of unknown faces</span>
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
                {cluster.samples.map((face) => {
                  const out = left.has(face.face_id);
                  return (
                    <button
                      key={face.face_id}
                      type="button"
                      onClick={() => toggleLeft(face.face_id)}
                      aria-pressed={out}
                      title={out ? `${face.photo_name}: left out, click to add it back` : `${face.photo_name}: click if this is someone else`}
                      className="relative"
                    >
                      <img
                        src={mediaUrl({ kind: "face", path: face.face_thumb })}
                        alt=""
                        loading="lazy"
                        className={`w-16 h-16 rounded-lg object-cover border transition-opacity ${out ? "opacity-30 border-zinc-800" : "border-zinc-800 hover:border-zinc-600"}`}
                      />
                      {out && (
                        <span className="absolute inset-0 grid place-items-center">
                          <X className="w-6 h-6 text-zinc-300" />
                        </span>
                      )}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setLarge({ index, face: cluster.samples.find((f) => !left.has(f.face_id))?.face_id ?? cluster.samples[0].face_id })}
                  className="ml-1 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-xs flex items-center gap-1.5"
                  title="See these faces bigger, and the photos they are in"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                  <span>Larger</span>
                </button>
                {cluster.size > cluster.samples.length && (
                  <span className="text-[11px] text-zinc-500 px-2">
                    Naming names the {shown(cluster).length} shown; the other {(cluster.size - cluster.samples.length).toLocaleString()} come back as suggestions to check
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
                <span className="text-zinc-400 shrink-0 tabular-nums">{plural(cluster.size, "face")}</span>
                <input
                  list="known-people"
                  value={names[index] || ""}
                  onChange={(e) => setNames((prev) => ({ ...prev, [index]: e.target.value }))}
                  placeholder="Who is this? (new or existing name)"
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-emerald-500/80"
                />
                <button
                  type="submit"
                  disabled={!names[index]?.trim() || busy !== null || shown(cluster).length === 0}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold flex items-center gap-1.5"
                >
                  {busy === index ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>Name {shown(cluster).length === cluster.size ? `all ${cluster.size}` : shown(cluster).length}</span>
                </button>
                <button
                  type="button"
                  onClick={() => ignoreFaces(index, kept(cluster))}
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
      {large && largeGroup && largeFace && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-6" onClick={() => setLarge(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Faces in this group"
            data-own-escape
            className="bg-card border border-zinc-800 rounded-2xl w-full max-w-6xl h-[86vh] flex flex-col overflow-hidden shadow-2xl"
          >
            <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between gap-4">
              <div className="text-sm text-zinc-100 font-medium">
                {plural(largeGroup.size, "face")} in this group
                <span className="ml-3 text-xs font-normal text-zinc-500">Click a face to see its photo. Leave out the faces that are someone else.</span>
              </div>
              <button onClick={() => setLarge(null)} aria-label="Close" className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 flex">
              <div className="w-[360px] shrink-0 overflow-y-auto p-4 grid grid-cols-2 gap-3 content-start border-r border-zinc-800">
                {largeGroup.samples.map((f) => {
                  const out = left.has(f.face_id);
                  const on = f.face_id === largeFace.face_id;
                  return (
                    <div key={f.face_id} className="flex flex-col gap-1">
                      <button
                        onClick={() => setLarge({ index: large.index, face: f.face_id })}
                        title={f.photo_name}
                        className={`rounded-xl overflow-hidden border-2 ${on ? "border-emerald-400" : "border-transparent hover:border-zinc-600"}`}
                      >
                        <img src={mediaUrl({ kind: "face", path: f.face_thumb })} alt="" className={`w-full aspect-square object-cover ${out ? "opacity-30" : ""}`} />
                      </button>
                      <button
                        onClick={() => toggleLeft(f.face_id)}
                        aria-pressed={out}
                        className={`text-[11px] py-0.5 rounded-md border ${out ? "border-zinc-600 text-zinc-200" : "border-zinc-800 text-zinc-500 hover:text-zinc-200"}`}
                      >
                        {out ? "Left out · add back" : "Leave out"}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="flex-1 min-w-0 p-4 bg-zinc-950 flex flex-col gap-2">
                <div className="flex-1 min-h-0">
                  <SpotlightPhoto cand={largeFace} upcoming={[]} label="This face" />
                </div>
                <div className="text-xs text-zinc-500 truncate">{largeFace.photo_name}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
