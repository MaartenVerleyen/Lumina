import { useEffect, useRef, useState } from "react";
import { Check, GalleryVerticalEnd, LayoutGrid, Loader2, UserPen, UserRound, X } from "lucide-react";
import { call, mediaUrl } from "../../api";
import { confirmDialog } from "../../confirm";
import type { LibraryState } from "../../hooks/useLibraryState";
import type { FaceCluster, FaceInstance, SimilarFaceCandidate } from "../../types/lumina";
import { FaceSheet } from "./PhoneViewer";
import { Page } from "./PhoneParts";
import { applyFaces } from "./faces";
import { useBackCloses } from "./navigation";
import SpotlightPhoto from "../modals/SpotlightPhoto";
import FaceCards from "./FaceCards";

// The phone app's face review (the People tab): the faces the server thinks are someone already named, to
// confirm or turn down, and the groups of faces of someone without a name, to name at once. The server works
// both out (face_review.rs); the desktop's Review Studio and "Unknown faces" do the same on a big screen.

// At or above this similarity a suggestion was right every time in face_eval: those start ticked
const LIKELY = 62;
// Answering more faces than this at once asks first (a batch is up to 300, all of them likely)
const ASK_ABOVE = 20;

// The people's counts and covers again once the page closes, by its arrow or by the phone's back
// One by one (cards to swipe) or the grid: the one used last, remembered on this device
const MODE_KEY = "lumina_phone_review_mode";
type ReviewMode = "cards" | "grid";
function savedMode(): ReviewMode {
  try {
    return localStorage.getItem(MODE_KEY) === "grid" ? "grid" : "cards";
  } catch {
    return "cards";
  }
}

function useRefreshOnLeave(lib: LibraryState) {
  const refresh = useRef(lib.refreshPeople);
  refresh.current = lib.refreshPeople;
  useEffect(() => () => void refresh.current(), []);
}

export function ReviewPerson({ lib, name, onBack }: { lib: LibraryState; name: string; onBack: () => void }) {
  const [candidates, setCandidates] = useState<SimilarFaceCandidate[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Someone else": the ticked faces, waiting for their right name
  const [naming, setNaming] = useState<string[] | null>(null);
  const [mode, setModeState] = useState<ReviewMode>(savedMode);
  const setMode = (m: ReviewMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
  };
  const person = lib.people.find((p) => p.name === name);
  const cardsShown = useRef(false);

  useEffect(() => {
    let live = true;
    call<SimilarFaceCandidate[]>("find_similar_faces", { personName: name, rootFolder: null })
      .then((found) => {
        if (!live) return;
        // The likeliest first: the cards go through them in this order, the grid shows them so
        setCandidates([...found].sort((a, b) => b.similarity - a.similarity));
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
    if (ids.length > ASK_ABOVE) {
      const n = ids.length.toLocaleString();
      const ok = await confirmDialog(
        yes
          ? `All ${n} ticked faces are ${name}? Lumina names them and looks for more like them. Undo is face by face, in their photos.`
          : `None of the ${n} ticked faces is ${name}? Lumina won't suggest them for ${name} again.`,
        { title: yes ? `${n} faces are ${name}` : `${n} faces aren't ${name}`, okLabel: yes ? `Yes, ${n} are ${name}` : `Not ${name}`, cancelLabel: "Check them first" }
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      if (yes) {
        const changed = await call<Record<string, FaceInstance[]>>("assign_faces_to_person_batch", { faceIds: ids, personName: name });
        applyFaces(lib, changed);
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

  // Named as someone else: they're also turned down for this person, so they aren't suggested for them again
  const namedSomeoneElse = async (ids: string[], changed: Record<string, FaceInstance[]>) => {
    applyFaces(lib, changed);
    const named = new Set(ids);
    setCandidates((prev) => (prev ?? []).filter((c) => !named.has(c.face_id)));
    setTicked((prev) => new Set([...prev].filter((id) => !named.has(id))));
    setNaming(null);
    lib.reducePendingCount(name, ids.length);
    try {
      await call("reject_face_candidates_batch", { faceIds: ids, personName: name });
    } catch (e) {
      setError(String(e));
    }
  };

  useRefreshOnLeave(lib);

  const modeButton = candidates && candidates.length > 0 && (
    <button
      onClick={() => setMode(mode === "cards" ? "grid" : "cards")}
      className="flex items-center gap-1.5 px-3 py-2 rounded-full text-xs text-zinc-300 active:bg-white/10"
      aria-label={mode === "cards" ? "Show all at once" : "One by one"}
    >
      {mode === "cards" ? <LayoutGrid className="w-4 h-4" /> : <GalleryVerticalEnd className="w-4 h-4" />}
      {mode === "cards" ? "All at once" : "One by one"}
    </button>
  );

  // Once the cards are on screen they stay, to their own end ("That's all for Emma")
  if (mode === "cards" && candidates && (candidates.length > 0 || cardsShown.current)) {
    cardsShown.current = true;
    return (
      <Page title={`Is this ${name}?`} onBack={onBack} action={modeButton} fill>
        <FaceCards lib={lib} name={name} candidates={candidates} setCandidates={setCandidates} likely={LIKELY} onFinished={onBack} />
      </Page>
    );
  }

  return (
    <Page title={`Is this ${name}?`} onBack={onBack} action={modeButton}>
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
          <div className="grid grid-cols-3 min-[520px]:grid-cols-5 gap-2 p-4 pb-36">
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
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-[11px] text-zinc-200 text-left truncate">
                    {c.current_person ? `Now ${c.current_person}` : c.similarity >= LIKELY ? "Likely" : "Maybe"}
                  </span>
                </button>
              );
            })}
          </div>
          {/* A solid bar, its labels on one line: the two answers side by side, someone else as a link above them */}
          <div
            className="fixed inset-x-0 bottom-0 z-40 bg-panel border-t border-zinc-800 px-4 pt-1"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
          >
            <div className="flex justify-center">
              <button
                disabled={busy || ticked.size === 0}
                onClick={() => setNaming([...ticked])}
                className="min-h-11 flex items-center gap-1.5 px-3 rounded-full text-[15px] text-emerald-400 disabled:opacity-40 active:bg-white/5"
              >
                <UserPen className="w-4 h-4" />
                Someone else…
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                disabled={busy || ticked.size === 0}
                onClick={() => void answer(false)}
                className="min-w-0 min-h-11 flex items-center justify-center gap-1.5 px-3 rounded-full bg-zinc-800 text-[15px] text-zinc-100 disabled:opacity-40 active:bg-zinc-700"
              >
                <X className="w-4 h-4 shrink-0" />
                <span className="truncate">Not {name}</span>
              </button>
              <button
                disabled={busy || ticked.size === 0}
                onClick={() => void answer(true)}
                className="min-w-0 min-h-11 flex items-center justify-center gap-1.5 px-3 rounded-full bg-emerald-600 text-[15px] font-semibold text-white disabled:opacity-40 active:bg-emerald-700"
              >
                {busy ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : <Check className="w-4 h-4 shrink-0" />}
                <span className="truncate">
                  {name}
                  {ticked.size > 0 ? ` (${ticked.size.toLocaleString()})` : ""}
                </span>
              </button>
            </div>
          </div>
        </>
      )}
      {error && <p className="px-4 pt-4 text-xs text-red-300">{error}</p>}
      {naming && (
        <FaceSheet
          faceIds={naming}
          thumb={candidates?.find((c) => c.face_id === naming[0])?.face_thumb ?? ""}
          current={name}
          title={naming.length === 1 ? `Not ${name}: who is it?` : `Not ${name}: who are these ${naming.length} faces?`}
          people={lib.people}
          onClose={() => setNaming(null)}
          onDone={(changed) => void namedSomeoneElse(naming, changed)}
        />
      )}
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
  // Naming names only the faces shown (and not left out): the rest of a big group comes back as suggestions
  const shown = (g: FaceCluster) => g.samples.map((f) => f.face_id).filter((id) => !left.has(id));
  // A group opened bigger, with the photo of one of its faces
  const [large, setLarge] = useState<FaceCluster | null>(null);
  const toggleLeft = (id: string) =>
    setLeft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The ignored faces on a page of their own; faces brought back there: the groups are asked for again
  const [ignored, setIgnored] = useState(false);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    setGroups(null);
    call<FaceCluster[]>("get_unknown_face_clusters", { rootFolder: null })
      .then((found) => live && setGroups(found))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [asked]);

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

  useRefreshOnLeave(lib);

  return (
    <Page
      title="Without a name"
      onBack={onBack}
      action={
        <button onClick={() => setIgnored(true)} className="px-3 py-2 rounded-full text-sm text-emerald-400 active:bg-white/10">
          Ignored
        </button>
      }
    >
      <p className="px-4 pt-4 text-[15px] text-zinc-300">
        {groups === null
          ? "Grouping the faces without a name… This can take a minute when the server is busy."
          : groups.length === 0
            ? "Every face that comes back often has a name."
            : "Faces that look like the same person. Name a group and the faces shown get that name; tap a face that is someone else to leave it out."}
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
            <button onClick={() => setLarge(g)} className="flex-1 text-left text-xs text-zinc-400 active:text-zinc-200">
              {g.size.toLocaleString()} {g.size === 1 ? "face" : "faces"} · <span className="text-emerald-400">Larger</span>
            </button>
            {/* Setting a group aside is the rare answer: quiet, and away from Name… */}
            <button onClick={() => void ignore(g)} className="px-2 py-1.5 text-xs text-zinc-500 active:text-zinc-300">
              Don't know
            </button>
            <button disabled={shown(g).length === 0} onClick={() => setNaming(g)} className="disabled:opacity-40 ml-2 px-4 py-1.5 rounded-full bg-emerald-600 text-xs font-medium text-white active:bg-emerald-700">
              Name…
            </button>
          </div>
        </section>
      ))}
      {error && <p className="px-4 pt-4 text-xs text-red-300">{error}</p>}
      {groups && groups.some((g) => g.size > g.samples.length) && (
        <p className="px-4 pt-4 text-xs text-zinc-500">
          In a big group, naming names the faces shown; the others come back as suggestions to check for that person.
        </p>
      )}
      {large && <LargeGroup group={large} left={left} onToggle={toggleLeft} onBack={() => setLarge(null)} />}
      {ignored && (
        <IgnoredFacesPage
          onBack={(broughtBack) => {
            setIgnored(false);
            if (broughtBack) setAsked((n) => n + 1);
          }}
        />
      )}
      {naming && (
        <FaceSheet
          faceIds={shown(naming)}
          thumb={naming.samples.find((s) => !left.has(s.face_id))?.face_thumb ?? ""}
          current=""
          title={`Who are these ${shown(naming).length} faces?`}
          people={lib.people}
          onClose={() => setNaming(null)}
          onDone={(changed) => {
            applyFaces(lib, changed);
            done(naming);
            setNaming(null);
          }}
        />
      )}
    </Page>
  );
}

// The faces marked "Don't know", the last first: tap the ones to bring back, and they are grouped and
// suggested again
function IgnoredFacesPage({ onBack }: { onBack: (broughtBack: boolean) => void }) {
  const [faces, setFaces] = useState<SimilarFaceCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const broughtBack = useRef(false);
  const close = () => onBack(broughtBack.current);
  useBackCloses(close);

  useEffect(() => {
    let live = true;
    call<SimilarFaceCandidate[]>("get_ignored_faces", { rootFolder: null })
      .then((found) => live && setFaces(found))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, []);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function bringBack() {
    const ids = [...picked];
    setBusy(true);
    setError(null);
    try {
      await call("ignore_faces", { faceIds: ids, ignore: false });
      const back = new Set(ids);
      setFaces((prev) => (prev ?? []).filter((f) => !back.has(f.face_id)));
      setPicked(new Set());
      broughtBack.current = true;
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const all = faces ?? [];
  return (
    <Page title="Ignored faces" onBack={close}>
      <p className="px-4 pt-4 text-[15px] text-zinc-300">
        {faces === null
          ? "Loading the faces you don't know…"
          : all.length === 0
            ? "No ignored faces."
            : `${all.length.toLocaleString()} ${all.length === 1 ? "face" : "faces"} marked as someone you don't know. They aren't grouped or suggested. Tap the ones to bring back.`}
      </p>
      {faces === null && !error && (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
        </div>
      )}
      {error && <p className="px-4 pt-4 text-xs text-red-300">{error}</p>}
      <div className="grid grid-cols-4 gap-2 p-4 pb-28">
        {all.map((f) => {
          const on = picked.has(f.face_id);
          return (
            <button key={f.face_id} onClick={() => toggle(f.face_id)} aria-pressed={on} className="relative aspect-square">
              <img
                src={mediaUrl({ kind: "face", path: f.face_thumb })}
                alt=""
                loading="lazy"
                className={`w-full h-full rounded-2xl object-cover bg-zinc-800 border-2 ${on ? "border-emerald-400" : "border-transparent opacity-70"}`}
              />
              {on && <Check className="absolute top-1 right-1 w-5 h-5 p-0.5 rounded-full bg-emerald-500 text-white" />}
            </button>
          );
        })}
      </div>
      {all.length > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-50 flex gap-2 px-4 pt-3 bg-panel border-t border-zinc-800"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
        >
          <button
            onClick={() => setPicked(picked.size === all.length ? new Set() : new Set(all.map((f) => f.face_id)))}
            className="flex-1 min-h-[44px] rounded-xl bg-zinc-800 text-sm text-zinc-200 active:bg-zinc-700"
          >
            {picked.size === all.length ? "Select none" : "Select all"}
          </button>
          <button
            onClick={() => void bringBack()}
            disabled={picked.size === 0 || busy}
            className="flex-1 min-h-[44px] rounded-xl bg-emerald-600 text-sm font-semibold text-white disabled:opacity-40 active:bg-emerald-700"
          >
            {busy ? "Bringing back…" : picked.size > 0 ? `Bring back ${picked.size.toLocaleString()}` : "Bring back"}
          </button>
        </div>
      )}
    </Page>
  );
}

// A group of faces bigger, two to a row: tap one to see the photo it is in, and leave out the ones that are
// someone else. The phone's back closes it.
function LargeGroup({
  group,
  left,
  onToggle,
  onBack,
}: {
  group: FaceCluster;
  left: Set<string>;
  onToggle: (id: string) => void;
  onBack: () => void;
}) {
  useBackCloses(onBack);
  const [face, setFace] = useState(group.samples[0]);
  return (
    <Page title={`${group.size.toLocaleString()} faces in this group`} onBack={onBack}>
      <div className="h-[42vh] mx-3 mt-3 rounded-2xl bg-zinc-950 border border-zinc-800 p-2">
        <SpotlightPhoto cand={face} upcoming={[]} label="This face" />
      </div>
      <div className="grid grid-cols-2 gap-3 p-3">
        {group.samples.map((f) => {
          const out = left.has(f.face_id);
          return (
            <div key={f.face_id} className="flex flex-col gap-1.5">
              <button onClick={() => setFace(f)} className={`rounded-2xl overflow-hidden border-2 ${f.face_id === face.face_id ? "border-emerald-400" : "border-transparent"}`}>
                <img src={mediaUrl({ kind: "face", path: f.face_thumb })} alt="" loading="lazy" className={`w-full aspect-square object-cover bg-zinc-800 ${out ? "opacity-30" : ""}`} />
              </button>
              <button onClick={() => onToggle(f.face_id)} aria-pressed={out} className="py-1.5 rounded-full border border-zinc-700 text-xs text-zinc-300 active:bg-white/5">
                {out ? "Left out · add back" : "Leave out"}
              </button>
            </div>
          );
        })}
      </div>
    </Page>
  );
}
