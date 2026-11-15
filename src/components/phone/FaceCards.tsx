import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Check, Loader2, Undo2, UserPen, X } from "lucide-react";
import { call, callLocal, mediaUrl, onAndroid } from "../../api";
import type { LibraryState } from "../../hooks/useLibraryState";
import type { FaceInstance, SimilarFaceCandidate } from "../../types/lumina";
import { swipeAnswer, swipeHint, swipeTilt, type SwipeAnswer } from "../../utils/swipe";
import SpotlightPhoto from "../modals/SpotlightPhoto";
import { useBackCloses } from "./navigation";
import { FaceSheet } from "./PhoneViewer";
import { withFaces } from "./faces";

// Checking faces one by one (docs/plans/android.md, "Checking faces one by one"): a card per face, the likeliest
// first. Swipe right: it's them; left: it isn't; up: someone else (the name sheet). Each answer is saved at once;
// Undo takes the answers back one by one. The grid in FaceReview.tsx does the same for many faces at once.

interface Answered {
  cand: SimilarFaceCandidate;
  answer: SwipeAnswer;
  // Who it was instead (someone else)
  other?: string;
}

// How long a card takes to fly off (ms)
const FLY_MS = 220;

function haptic() {
  if (onAndroid) void callLocal("phone_haptic").catch(() => {});
  else navigator.vibrate?.(15);
}

export default function FaceCards({
  lib,
  name,
  candidates,
  setCandidates,
  likely,
  onFinished,
}: {
  lib: LibraryState;
  name: string;
  // Still to answer, the likeliest first
  candidates: SimilarFaceCandidate[];
  setCandidates: Dispatch<SetStateAction<SimilarFaceCandidate[] | null>>;
  // At or above this similarity a face is labelled Likely
  likely: number;
  onFinished: () => void;
}) {
  const [total] = useState(() => candidates.length);
  const [history, setHistory] = useState<Answered[]>([]);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [flying, setFlying] = useState<SwipeAnswer | null>(null);
  const [naming, setNaming] = useState<SimilarFaceCandidate | null>(null);
  const [spotlight, setSpotlight] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number; t: number; lastX: number; lastY: number; lastT: number; moved: boolean } | null>(null);
  // The answer a let-go would give now: the phone buzzes once each time it changes to one
  const armed = useRef<SwipeAnswer | null>(null);
  // The last press was a tap (not a drag): its click opens the whole photo
  const tapped = useRef(false);
  const current = candidates[0] ?? null;
  const next = candidates[1] ?? null;

  // The next faces load ahead, so a card is there at once
  useEffect(() => {
    const ahead = candidates.slice(1, 5).map((c) => {
      const img = new Image();
      img.src = mediaUrl({ kind: "face", path: c.face_thumb });
      return img;
    });
    return () => ahead.forEach((img) => (img.src = ""));
  }, [candidates.slice(1, 5).map((c) => c.face_id).join("|")]);

  // An answer is saved at once; if the server refuses it, the card comes back with the reason
  async function save(cand: SimilarFaceCandidate, answer: "yes" | "no") {
    setCandidates((prev) => (prev ?? []).filter((c) => c.face_id !== cand.face_id));
    setHistory((h) => [...h, { cand, answer }]);
    lib.reducePendingCount(name, 1);
    try {
      if (answer === "yes") {
        const changed = await call<Record<string, FaceInstance[]>>("assign_faces_to_person_batch", { faceIds: [cand.face_id], personName: name });
        lib.setPhotos((prev) => withFaces(prev, changed));
      } else {
        await call("reject_face_candidates_batch", { faceIds: [cand.face_id], personName: name });
      }
    } catch (e) {
      setError(String(e));
      setHistory((h) => h.filter((a) => a.cand.face_id !== cand.face_id));
      setCandidates((prev) => [cand, ...(prev ?? [])]);
      lib.reducePendingCount(name, -1);
    }
  }

  // `buzz`: false when the drag already buzzed as it passed the line
  function answer(a: SwipeAnswer, buzz = true) {
    if (!current || flying) return;
    setError(null);
    if (a === "else") {
      // The card waits under the name sheet; closing the sheet without a name leaves it as it was
      setDrag(null);
      setNaming(current);
      return;
    }
    if (buzz) haptic();
    setFlying(a);
    const cand = current;
    setTimeout(() => {
      setFlying(null);
      setDrag(null);
      void save(cand, a);
    }, FLY_MS);
  }

  // Named as someone else: turned down for this person too, so it isn't suggested for them again (as the grid)
  async function namedSomeoneElse(cand: SimilarFaceCandidate, changed: Record<string, FaceInstance[]>) {
    haptic();
    setNaming(null);
    lib.setPhotos((prev) => withFaces(prev, changed));
    const other = Object.values(changed)
      .flat()
      .find((f) => f.face_id === cand.face_id)?.person_name ?? undefined;
    setCandidates((prev) => (prev ?? []).filter((c) => c.face_id !== cand.face_id));
    setHistory((h) => [...h, { cand, answer: "else", other: other ?? undefined }]);
    lib.reducePendingCount(name, 1);
    try {
      await call("reject_face_candidates_batch", { faceIds: [cand.face_id], personName: name });
    } catch (e) {
      setError(String(e));
    }
  }

  // The last answer taken back, on the server too, and its card on top again
  async function undo() {
    const last = history[history.length - 1];
    if (!last || undoing) return;
    setUndoing(true);
    setError(null);
    try {
      const faceIds = [last.cand.face_id];
      if (last.answer === "yes") {
        const changed = await call<Record<string, FaceInstance[]>>("unassign_faces_batch", { faceIds, personName: name });
        lib.setPhotos((prev) => withFaces(prev, changed));
      } else if (last.answer === "no") {
        await call("unreject_face_candidates_batch", { faceIds, personName: name });
      } else {
        if (last.other) {
          const changed = await call<Record<string, FaceInstance[]>>("unassign_faces_batch", { faceIds, personName: last.other });
          lib.setPhotos((prev) => withFaces(prev, changed));
        }
        await call("unreject_face_candidates_batch", { faceIds, personName: name });
      }
      setHistory((h) => h.slice(0, -1));
      setCandidates((prev) => [last.cand, ...(prev ?? []).filter((c) => c.face_id !== last.cand.face_id)]);
      lib.reducePendingCount(name, -1);
    } catch (e) {
      setError(`Couldn't undo: ${String(e)}`);
    } finally {
      setUndoing(false);
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (flying || naming) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = e.timeStamp;
    pointer.current = { x: e.clientX, y: e.clientY, t, lastX: e.clientX, lastY: e.clientY, lastT: t, moved: false };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const p = pointer.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.hypot(dx, dy) > 8) p.moved = true;
    // The speed is taken over the last movement only, so a slow drag that ends in a flick counts as a flick
    if (e.timeStamp - p.lastT > 16) {
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      p.lastT = e.timeStamp;
    }
    if (!p.moved) return;
    setDrag({ dx, dy });
    const rect = area.current?.getBoundingClientRect();
    const now = swipeAnswer(dx, dy, 0, 0, rect?.width ?? 360, rect?.height ?? 520);
    if (now && now !== armed.current) haptic();
    armed.current = now;
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const p = pointer.current;
    pointer.current = null;
    armed.current = null;
    if (!p) return;
    // A tap opens the whole photo, on its click: opened now, the same tap's click would close it again
    tapped.current = !p.moved;
    if (!p.moved) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    const dt = Math.max(1, e.timeStamp - p.lastT);
    const vx = (e.clientX - p.lastX) / dt;
    const vy = (e.clientY - p.lastY) / dt;
    const rect = area.current?.getBoundingClientRect();
    const a = swipeAnswer(dx, dy, vx, vy, rect?.width ?? 360, rect?.height ?? 520);
    // Dragged past the line it buzzed already; a flick short of it buzzes as it goes
    const far = swipeAnswer(dx, dy, 0, 0, rect?.width ?? 360, rect?.height ?? 520);
    if (a) answer(a, far !== a);
    else setDrag(null);
  }

  const counts = { yes: 0, no: 0, else: 0 };
  for (const a of history) counts[a.answer] += 1;

  if (!current) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center">
          <Check className="w-7 h-7 text-emerald-400" />
        </div>
        <div className="text-base font-semibold text-zinc-100">That's all for {name}</div>
        {history.length > 0 && (
          <div className="text-sm text-zinc-400">
            {[
              counts.yes ? `${counts.yes} confirmed` : "",
              counts.no ? `${counts.no} turned down` : "",
              counts.else ? `${counts.else} named as someone else` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
        <div className="flex gap-2 pt-2">
          {history.length > 0 && (
            <button onClick={() => void undo()} disabled={undoing} className="px-4 py-2.5 rounded-xl border border-zinc-700 text-sm text-zinc-200 active:bg-white/5">
              Undo
            </button>
          )}
          <button onClick={onFinished} className="px-6 py-2.5 rounded-xl bg-emerald-600 text-sm font-semibold text-white active:bg-emerald-700">
            Done
          </button>
        </div>
      </div>
    );
  }

  const dx = drag?.dx ?? 0;
  const dy = drag?.dy ?? 0;
  const width = area.current?.clientWidth ?? 360;
  const height = area.current?.clientHeight ?? 520;
  const hint = flying ?? swipeHint(dx, dy);
  const transform = flying
    ? flying === "yes"
      ? `translate(${width * 1.4}px, ${dy}px) rotate(18deg)`
      : flying === "no"
        ? `translate(${-width * 1.4}px, ${dy}px) rotate(-18deg)`
        : `translate(${dx}px, ${-height * 1.4}px)`
    : `translate(${dx}px, ${dy}px) rotate(${swipeTilt(dx, width)}deg)`;
  const hintStyle =
    hint === "yes"
      ? { ring: "border-emerald-400", badge: "bg-emerald-600", text: name }
      : hint === "no"
        ? { ring: "border-red-400", badge: "bg-red-600", text: `Not ${name}` }
        : hint === "else"
          ? { ring: "border-sky-400", badge: "bg-sky-600", text: "Someone else" }
          : null;
  const label = current.current_person ? `Now ${current.current_person}` : current.similarity >= likely ? "Likely" : "Maybe";

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center justify-between px-4 pt-3 text-xs text-zinc-400">
        <span>
          {Math.min(total, history.length + 1)} of {Math.max(total, history.length + candidates.length)}
        </span>
        <span>{label}</span>
      </div>

      <div ref={area} className="relative flex-1 min-h-0 mx-4 my-3">
        {/* The next card waits under this one */}
        {next && (
          <div className="absolute inset-0 rounded-3xl bg-raised border border-zinc-800 overflow-hidden scale-[0.95] opacity-70">
            <div className="w-full h-full bg-zinc-950" />
          </div>
        )}
        <div
          key={current.face_id}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            pointer.current = null;
            armed.current = null;
            setDrag(null);
          }}
          onClick={() => {
            if (!tapped.current) return;
            tapped.current = false;
            setSpotlight(true);
          }}
          style={{
            transform,
            transition: drag && !flying ? "none" : `transform ${FLY_MS}ms ease-out`,
            touchAction: "none",
          }}
          className={`absolute inset-0 rounded-3xl bg-raised border-2 overflow-hidden flex flex-col shadow-2xl select-none ${hintStyle ? hintStyle.ring : "border-zinc-800"}`}
        >
          {/* The whole photo with the face boxed fills the card; a tap opens it full screen */}
          <div className="relative flex-1 min-h-0 p-2 bg-zinc-950 pointer-events-none">
            <SpotlightPhoto cand={current} upcoming={candidates.slice(1, 3)} label={label} />
            {/* The face close up, for a small face in a wide photo */}
            <img
              src={mediaUrl({ kind: "face", path: current.face_thumb })}
              alt=""
              draggable={false}
              className="absolute bottom-3 right-3 w-24 h-24 rounded-full object-cover border-2 border-white/80 shadow-xl bg-zinc-900"
            />
          </div>
          <div className="shrink-0 px-4 py-2 text-[11px] text-zinc-500 truncate pointer-events-none">{current.photo_name}</div>
          {hintStyle && (
            <span className={`absolute top-4 left-4 px-3 py-1 rounded-full text-sm font-semibold text-white shadow ${hintStyle.badge}`}>{hintStyle.text}</span>
          )}
        </div>
      </div>

      {error && <p className="shrink-0 px-4 pb-2 text-xs text-red-300">{error}</p>}

      <div className="shrink-0 flex items-end justify-center gap-6 px-4 pb-2">
        <RoundButton label={`Not ${name}`} onClick={() => answer("no")} className="border-red-500/60 text-red-300">
          <X className="w-7 h-7" />
        </RoundButton>
        <RoundButton label="Someone else" onClick={() => answer("else")} small className="border-sky-500/60 text-sky-300">
          <UserPen className="w-5 h-5" />
        </RoundButton>
        <RoundButton label={name} onClick={() => answer("yes")} className="border-emerald-500/60 text-emerald-300">
          <Check className="w-7 h-7" />
        </RoundButton>
      </div>
      <div className="shrink-0 flex justify-center pb-1">
        <button
          onClick={() => void undo()}
          disabled={history.length === 0 || undoing}
          className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm text-zinc-400 disabled:opacity-30 active:bg-white/5"
        >
          {undoing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
          Undo
        </button>
      </div>

      {naming && (
        <FaceSheet
          faceIds={[naming.face_id]}
          thumb={naming.face_thumb}
          current={name}
          title={`Not ${name}: who is it?`}
          people={lib.people}
          onClose={() => setNaming(null)}
          onDone={(changed) => void namedSomeoneElse(naming, changed)}
        />
      )}
      {spotlight && <Spotlight cand={current} label={label} onClose={() => setSpotlight(false)} />}
    </div>
  );
}

function RoundButton({ label, onClick, small, className, children }: { label: string; onClick: () => void; small?: boolean; className: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        onClick={onClick}
        aria-label={label}
        className={`${small ? "w-12 h-12" : "w-16 h-16"} rounded-full border-2 bg-raised flex items-center justify-center active:scale-95 transition-transform ${className}`}
      >
        {children}
      </button>
      <span className="text-[11px] text-zinc-400 max-w-[6rem] truncate">{label}</span>
    </div>
  );
}

// The photo large, over everything; back or a tap closes it
function Spotlight({ cand, label, onClose }: { cand: SimilarFaceCandidate; label: string; onClose: () => void }) {
  useBackCloses(onClose);
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-black flex p-2" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)", paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)" }}>
      <SpotlightPhoto cand={cand} upcoming={[]} label={label} />
    </div>
  );
}
