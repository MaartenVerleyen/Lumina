import { useEffect, useState } from "react";
import { Check, Loader2, UserRound, X } from "lucide-react";
import { call, mediaUrl } from "../../api";
import type { LibraryState } from "../../hooks/useLibraryState";
import type { FaceCluster, FaceInstance, SimilarFaceCandidate } from "../../types/lumina";
import { FaceSheet } from "./PhoneViewer";
import { Page } from "./PhoneParts";
import { withFaces } from "./faces";

// The phone app's face review (Search → People): the faces the server thinks are someone already named, to
// confirm or turn down, and the groups of faces of someone without a name, to name at once. The server works
// both out (face_review.rs); the desktop's Review Studio and "Unknown faces" do the same on a big screen.

// At or above this similarity a suggestion was right every time in face_eval: those start ticked
const LIKELY = 62;

export function ReviewPerson({ lib, name, onBack }: { lib: LibraryState; name: string; onBack: () => void }) {
  const [candidates, setCandidates] = useState<SimilarFaceCandidate[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const person = lib.people.find((p) => p.name === name);

  useEffect(() => {
    let live = true;
    call<SimilarFaceCandidate[]>("find_similar_faces", { personName: name, rootFolder: null })
      .then((found) => {
        if (!live) return;
        setCandidates(found);
        setTicked(new Set(found.filter((c) => c.similarity >= LIKELY).map((c) => c.face_id)));
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [name]);

  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Yes: the ticked faces are this person. No: they aren't, and the server stops suggesting them for them.
  const answer = async (yes: boolean) => {
    const ids = [...ticked];
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (yes) {
        const changed = await call<Record<string, FaceInstance[]>>("assign_faces_to_person_batch", { faceIds: ids, personName: name });
        lib.setPhotos((prev) => withFaces(prev, changed));
      } else {
        await call("reject_face_candidates_batch", { faceIds: ids, personName: name });
      }
      lib.reducePendingCount(name, ids.length);
      setCandidates((prev) => (prev ?? []).filter((c) => !ticked.has(c.face_id)));
      setTicked(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const leave = () => {
    void lib.refreshPeople();
    onBack();
  };

  return (
    <Page title={`Is this ${name}?`} onBack={leave}>
      <div className="flex items-center gap-3 px-4 pt-4">
        <div className="w-16 h-16 shrink-0 rounded-full overflow-hidden bg-zinc-800 border-2 border-emerald-500/70">
          {person?.cover_thumb ? (
            <img src={mediaUrl({ kind: "face", path: person.cover_thumb })} alt="" className="w-full h-full object-cover" />
          ) : (
            <UserRound className="w-1/2 h-1/2 m-auto mt-[25%] text-zinc-600" />
          )}
        </div>
        <p className="text-sm text-zinc-300">
          {candidates === null
            ? `Looking for faces like ${name}'s…`
            : candidates.length === 0
              ? `No more faces to check for ${name}.`
              : `Tick the faces that are ${name}. The likely ones are ticked already.`}
        </p>
      </div>

      {candidates === null && !error && (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
        </div>
      )}

      {candidates && candidates.length > 0 && (
        <>
          <div className="flex items-center justify-between px-4 pt-4 text-xs text-zinc-400">
            <span>
              {ticked.size} of {candidates.length} ticked
            </span>
            <button
              onClick={() => setTicked(ticked.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.face_id)))}
              className="text-emerald-400"
            >
              {ticked.size === candidates.length ? "Untick all" : "Tick all"}
            </button>
          </div>
          <div className="grid grid-cols-3 min-[520px]:grid-cols-5 gap-2 p-3 pb-28">
            {candidates.map((c) => {
              const on = ticked.has(c.face_id);
              return (
                <button key={c.face_id} onClick={() => toggle(c.face_id)} className="relative aspect-square rounded-xl overflow-hidden bg-zinc-800 active:opacity-80">
                  <img src={mediaUrl({ kind: "face", path: c.face_thumb })} alt="" loading="lazy" className={`w-full h-full object-cover transition-opacity ${on ? "" : "opacity-50"}`} />
                  <span
                    className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center border-2 ${
                      on ? "bg-emerald-500 border-emerald-500 text-white" : "bg-black/40 border-white/70"
                    }`}
                  >
                    {on && <Check className="w-4 h-4" />}
                  </span>
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-[10px] text-zinc-200 text-left truncate">
                    {c.current_person ? `Now ${c.current_person}` : c.similarity >= LIKELY ? "Likely" : "Maybe"}
                  </span>
                </button>
              );
            })}
          </div>
          <div
            className="fixed inset-x-0 bottom-0 z-40 flex gap-2 bg-panel/95 border-t border-zinc-800 px-3 pt-3"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
          >
            <button
              disabled={busy || ticked.size === 0}
              onClick={() => void answer(false)}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border border-zinc-700 text-zinc-200 disabled:opacity-40 active:bg-white/5"
            >
              <X className="w-4 h-4" />
              Not {name}
            </button>
            <button
              disabled={busy || ticked.size === 0}
              onClick={() => void answer(true)}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-600 text-white font-medium disabled:opacity-40 active:bg-emerald-700"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {ticked.size > 0 ? `${ticked.size} ${ticked.size === 1 ? "is" : "are"} ${name}` : `Is ${name}`}
            </button>
          </div>
        </>
      )}
      {error && <p className="px-4 pt-4 text-xs text-red-300">{error}</p>}
    </Page>
  );
}

export function UnnamedGroups({ lib, onBack }: { lib: LibraryState; onBack: () => void }) {
  const [groups, setGroups] = useState<FaceCluster[] | null>(null);
  const [naming, setNaming] = useState<FaceCluster | null>(null);
  // Faces tapped away from their group (someone else the server put in with them): named or ignored without them
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const kept = (g: FaceCluster) => g.face_ids.filter((id) => !left.has(id));
  const toggleLeft = (id: string) =>
    setLeft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    let live = true;
    call<FaceCluster[]>("get_unknown_face_clusters", { rootFolder: null })
      .then((found) => live && setGroups(found))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, []);

  const done = (group: FaceCluster) => setGroups((prev) => (prev ?? []).filter((g) => g !== group));

  // Faces of someone who doesn't matter (a passer-by, a poster): no group, no suggestions, no name asked again
  const ignore = async (group: FaceCluster) => {
    try {
      await call("ignore_faces", { faceIds: kept(group), ignore: true });
      done(group);
    } catch (e) {
      setError(String(e));
    }
  };

  const leave = () => {
    void lib.refreshPeople();
    onBack();
  };

  return (
    <Page title="Without a name" onBack={leave}>
      <p className="px-4 pt-4 text-sm text-zinc-300">
        {groups === null
          ? "Grouping the faces without a name…"
          : groups.length === 0
            ? "Every face that comes back often has a name."
            : "Faces that look like the same person. Name a group and all its faces get that name; tap a face that is someone else to leave it out."}
      </p>
      {groups === null && !error && (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
        </div>
      )}
      {groups?.map((g) => (
        <section key={g.face_ids[0]} className="mx-3 mt-3 rounded-2xl bg-raised/70 border border-zinc-800 p-3">
          <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {g.samples.map((s) => (
              <button key={s.face_id} onClick={() => toggleLeft(s.face_id)} className="relative w-14 h-14 shrink-0" aria-pressed={left.has(s.face_id)}>
                <img
                  src={mediaUrl({ kind: "face", path: s.face_thumb })}
                  alt=""
                  loading="lazy"
                  className={`w-full h-full rounded-full object-cover bg-zinc-800 ${left.has(s.face_id) ? "opacity-25" : ""}`}
                />
                {left.has(s.face_id) && <X className="absolute inset-0 m-auto w-6 h-6 text-zinc-300" />}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-3">
            <span className="flex-1 text-xs text-zinc-400">
              {kept(g).length} {kept(g).length === 1 ? "face" : "faces"}
            </span>
            <button onClick={() => void ignore(g)} className="px-3 py-1.5 rounded-full border border-zinc-700 text-xs text-zinc-300 active:bg-white/5">
              Not someone I know
            </button>
            <button disabled={kept(g).length === 0} onClick={() => setNaming(g)} className="disabled:opacity-40 px-3 py-1.5 rounded-full bg-emerald-600 text-xs font-medium text-white active:bg-emerald-700">
              Name…
            </button>
          </div>
        </section>
      ))}
      {error && <p className="px-4 pt-4 text-xs text-red-300">{error}</p>}
      {naming && (
        <FaceSheet
          faceIds={kept(naming)}
          thumb={naming.samples.find((s) => !left.has(s.face_id))?.face_thumb ?? ""}
          current=""
          title={`Who are these ${kept(naming).length} faces?`}
          people={lib.people}
          onClose={() => setNaming(null)}
          onDone={(changed) => {
            lib.setPhotos((prev) => withFaces(prev, changed));
            done(naming);
            setNaming(null);
          }}
        />
      )}
    </Page>
  );
}
