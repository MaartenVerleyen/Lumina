import { useState, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { PersonItem, PhotoItem, SimilarFaceCandidate } from "../../types/lumina";
import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Loader2,
  ScanFace,
  Sparkles,
  User,
  X,
} from "lucide-react";

interface FaceMatchReviewModalProps {
  isOpen: boolean;
  initialPerson: string | null;
  onClose: () => void;
  people: PersonItem[];
  pendingCounts: Record<string, number>;
  setPhotos: React.Dispatch<React.SetStateAction<PhotoItem[]>>;
  refreshPeople: () => Promise<void>;
}

export default function FaceMatchReviewModal({
  isOpen,
  initialPerson,
  onClose,
  people,
  pendingCounts,
  setPhotos,
  refreshPeople,
}: FaceMatchReviewModalProps) {
  const [activePerson, setActivePerson] = useState<string>("");
  const [candidates, setCandidates] = useState<SimilarFaceCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [reviewMode, setReviewMode] = useState<"grid" | "spotlight">("grid");
  const [spotlightIndex, setSpotlightIndex] = useState<number>(0);

  const loadCandidatesForPerson = useCallback(async (personName: string) => {
    const clean = personName.trim();
    if (!clean) return;
    setActivePerson(clean);
    setIsLoading(true);
    try {
      const res = await invoke<SimilarFaceCandidate[]>("find_similar_faces", {
        personName: clean,
        minSimilarity: 0.44,
      });
      setCandidates(res);
      setSelectedIds(
        new Set(res.filter((c) => c.similarity >= 56).map((c) => c.face_id))
      );
      setSpotlightIndex(0);
    } catch {
      setCandidates([]);
      setSelectedIds(new Set());
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const target =
      initialPerson ||
      people.find((p) => (pendingCounts[p.name] || 0) > 0)?.name ||
      people[0]?.name ||
      "";
    if (target) {
      loadCandidatesForPerson(target);
    }
  }, [isOpen, initialPerson]);

  const handleAcceptBatch = useCallback(
    async (faceIds: string[]) => {
      if (!activePerson || faceIds.length === 0) return;
      const idSet = new Set(faceIds);
      const updatedHashes = await invoke<string[]>("assign_faces_to_person_batch", {
        faceIds,
        personName: activePerson,
      });
      const hashSet = new Set(updatedHashes);

      setPhotos((prev) =>
        prev.map((p) => {
          if (!hashSet.has(p.hash)) return p;
          const nextFaces = p.faces.map((f) =>
            idSet.has(f.face_id) ? { ...f, person_name: activePerson } : f
          );
          const nextPeople = p.people.includes(activePerson)
            ? p.people
            : [...p.people, activePerson].sort();
          return {
            ...p,
            faces: nextFaces,
            people: nextPeople,
          };
        })
      );

      setCandidates((prev) => {
        const next = prev.filter((c) => !idSet.has(c.face_id));
        setSpotlightIndex((idx) => Math.min(idx, Math.max(0, next.length - 1)));
        return next;
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of faceIds) next.delete(id);
        return next;
      });
      await refreshPeople();
      // Re-run find_similar_faces so the updated multi-prototype centroid immediately surfaces any new matches!
      const refreshed = await invoke<SimilarFaceCandidate[]>("find_similar_faces", {
        personName: activePerson,
        minSimilarity: 0.44,
      });
      setCandidates(refreshed);
    },
    [activePerson, setPhotos, refreshPeople]
  );

  const handleDenyBatch = useCallback(
    async (faceIds: string[]) => {
      if (!activePerson || faceIds.length === 0) return;
      const idSet = new Set(faceIds);
      await invoke<number>("reject_face_candidates_batch", {
        faceIds,
        personName: activePerson,
      });
      setCandidates((prev) => {
        const next = prev.filter((c) => !idSet.has(c.face_id));
        setSpotlightIndex((idx) => Math.min(idx, Math.max(0, next.length - 1)));
        return next;
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of faceIds) next.delete(id);
        return next;
      });
      await refreshPeople();
    },
    [activePerson, refreshPeople]
  );

  // Keyboard shortcuts inside the modal (Spotlight & Escape)
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (reviewMode === "spotlight" && candidates.length > 0) {
        const cur = candidates[spotlightIndex];
        if (!cur) return;
        if (e.key.toLowerCase() === "y" || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          handleAcceptBatch([cur.face_id]);
        } else if (
          e.key.toLowerCase() === "n" ||
          e.key === "Backspace" ||
          e.key === "Delete"
        ) {
          e.preventDefault();
          e.stopPropagation();
          handleDenyBatch([cur.face_id]);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          setSpotlightIndex((i) => Math.min(candidates.length - 1, i + 1));
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          setSpotlightIndex((i) => Math.max(0, i - 1));
        }
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, reviewMode, candidates, spotlightIndex, handleAcceptBatch, handleDenyBatch, onClose]);

  if (!isOpen) return null;

  const currentSpotlight = candidates[spotlightIndex] || null;
  const activePersonObj = people.find(
    (p) => p.name.toLowerCase() === activePerson.toLowerCase()
  );

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9998] bg-black/85 backdrop-blur-md flex items-center justify-center p-6 select-none animate-in fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#0e1017] border border-zinc-800 rounded-2xl w-full max-w-6xl h-[86vh] shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Top Modal Header */}
        <div className="px-6 py-4 bg-[#12141d] border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
              <ScanFace className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <span>Face Match Review & Confirmation Studio</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-mono">
                  Multi-Prototype Centroid AI
                </span>
              </h2>
              <p className="text-xs text-zinc-400">
                Every confirmed face strengthens {activePerson || "the person"}'s biometric profile across angles and lighting.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Mode Switcher: Large Grid vs 1-by-1 Spotlight */}
            <div className="flex bg-zinc-900 border border-zinc-800 rounded-xl p-0.5 text-xs">
              <button
                onClick={() => setReviewMode("grid")}
                className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition ${
                  reviewMode === "grid"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>Large Grid ({candidates.length})</span>
              </button>
              <button
                onClick={() => setReviewMode("spotlight")}
                className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition ${
                  reviewMode === "spotlight"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>1-by-1 Spotlight (Y / N)</span>
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body: Left People Sidebar + Main Candidate Workspace */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left Sidebar: People List & Pending Counts */}
          <aside className="w-64 bg-[#0b0c12] border-r border-zinc-800/80 flex flex-col overflow-y-auto p-3 gap-1.5 shrink-0">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider px-2 py-1">
              Confirmed People ({people.length})
            </span>

            {people.map((p) => {
              const isSelected = p.name.toLowerCase() === activePerson.toLowerCase();
              const pending = pendingCounts[p.name] || 0;
              return (
                <button
                  key={p.name}
                  onClick={() => loadCandidatesForPerson(p.name)}
                  className={`w-full flex items-center justify-between p-2 rounded-xl text-xs transition ${
                    isSelected
                      ? "bg-indigo-600/20 text-indigo-200 border border-indigo-500/40 shadow-sm"
                      : "hover:bg-zinc-900 text-zinc-300 border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2.5 truncate">
                    {p.cover_thumb ? (
                      <img
                        src={convertFileSrc(p.cover_thumb)}
                        alt={p.name}
                        className="w-8 h-8 rounded-full object-cover border border-zinc-700 shrink-0"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center shrink-0">
                        <User className="w-4 h-4 text-zinc-400" />
                      </div>
                    )}
                    <div className="text-left truncate">
                      <div className="font-semibold capitalize truncate">{p.name}</div>
                      <div className="text-[10px] text-zinc-500 font-mono">
                        {p.photo_count} confirmed
                      </div>
                    </div>
                  </div>

                  {pending > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 font-mono text-[10px] font-bold shrink-0">
                      +{pending}?
                    </span>
                  )}
                </button>
              );
            })}
          </aside>

          {/* Main Workspace */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#090a0f]">
            {/* Action Sub-Toolbar */}
            <div className="px-6 py-3 bg-[#0e1017] border-b border-zinc-800/80 flex items-center justify-between text-xs shrink-0">
              <div className="flex items-center gap-3">
                {activePersonObj?.cover_thumb && (
                  <img
                    src={convertFileSrc(activePersonObj.cover_thumb)}
                    alt={activePerson}
                    className="w-7 h-7 rounded-full object-cover border border-emerald-500/50"
                  />
                )}
                <span className="font-bold text-sm text-zinc-100 capitalize">
                  {activePerson}
                </span>
                <span className="text-zinc-400">
                  — <strong>{candidates.length}</strong> potential unassigned face match
                  {candidates.length === 1 ? "" : "es"}
                </span>
              </div>

              {reviewMode === "grid" && candidates.length > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      setSelectedIds(new Set(candidates.map((c) => c.face_id)))
                    }
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300"
                  >
                    Select All
                  </button>
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400"
                  >
                    Clear Selection
                  </button>
                  <button
                    onClick={() => handleDenyBatch(Array.from(selectedIds))}
                    disabled={selectedIds.size === 0}
                    className="px-3 py-1.5 rounded-lg bg-red-950/60 hover:bg-red-900/80 disabled:opacity-40 border border-red-800/50 text-red-200 font-semibold flex items-center gap-1.5 transition"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Deny Selected ({selectedIds.size})</span>
                  </button>
                  <button
                    onClick={() => handleAcceptBatch(Array.from(selectedIds))}
                    disabled={selectedIds.size === 0}
                    className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold flex items-center gap-1.5 shadow transition"
                  >
                    <CheckCheck className="w-4 h-4" />
                    <span>Accept & Confirm Selected ({selectedIds.size})</span>
                  </button>
                </div>
              )}
            </div>

            {/* Content Area */}
            {isLoading ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                <span className="text-xs font-mono">
                  Comparing library faces against all confirmed "{activePerson}" embeddings...
                </span>
              </div>
            ) : candidates.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center p-8">
                <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-1">
                  <Check className="w-6 h-6 text-emerald-400" />
                </div>
                <h3 className="text-sm font-bold text-zinc-200">
                  No Unassigned Matches Remaining for "{activePerson}"
                </h3>
                <p className="text-xs text-zinc-500 max-w-md">
                  All matching detected faces have been reviewed. Tip: Click "Scan Faces" in the AI menu if you have added new photos that haven't been scanned for faces yet.
                </p>
              </div>
            ) : reviewMode === "grid" ? (
              /* 3-COLUMN FIXED 250PX CARD GRID MODE (Inline CSS Grid guarantees 3 columns & 250px card height!) */
              <div
                style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
                className="p-6"
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                    gridAutoRows: "250px",
                    gap: "16px",
                  }}
                >
                  {candidates.map((cand) => {
                    const isSelected = selectedIds.has(cand.face_id);
                    return (
                      <div
                        key={cand.face_id}
                        onClick={() => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(cand.face_id)) next.delete(cand.face_id);
                            else next.add(cand.face_id);
                            return next;
                          });
                        }}
                        style={{ height: "250px" }}
                        className={`group relative flex flex-col rounded-2xl overflow-hidden bg-[#12141d] border-2 transition cursor-pointer ${
                          isSelected
                            ? "border-emerald-500 ring-2 ring-emerald-500/30 shadow-lg"
                            : "border-zinc-800/90 hover:border-zinc-600"
                        }`}
                      >
                        {/* Face Image Area (172px high inside the 250px card) */}
                        <div
                          style={{ height: "172px" }}
                          className="relative w-full shrink-0 bg-zinc-950 overflow-hidden"
                        >
                          <img
                            src={convertFileSrc(cand.face_thumb)}
                            alt={cand.photo_name}
                            className="w-full h-full object-cover group-hover:scale-105 transition duration-200"
                          />

                          {/* Similarity Pill */}
                          <span
                            className={`absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold backdrop-blur-md shadow ${
                              cand.similarity >= 62
                                ? "bg-emerald-950/90 text-emerald-300 border border-emerald-500/40"
                                : "bg-amber-950/90 text-amber-300 border border-amber-500/40"
                            }`}
                          >
                            {cand.similarity}% match
                          </span>

                          {/* Inspect in Spotlight Button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const idx = candidates.findIndex(
                                (x) => x.face_id === cand.face_id
                              );
                              if (idx >= 0) setSpotlightIndex(idx);
                              setReviewMode("spotlight");
                            }}
                            className="absolute top-2.5 right-2.5 px-2.5 py-1 rounded-md bg-black/80 hover:bg-indigo-600 text-zinc-200 hover:text-white text-[10px] font-semibold opacity-0 group-hover:opacity-100 transition backdrop-blur shadow"
                            title="Inspect full photo context"
                          >
                            Full Photo
                          </button>
                        </div>

                        {/* Card Footer (78px high: Filename + Accept / Deny Buttons) */}
                        <div
                          style={{ height: "78px" }}
                          className="px-3 py-2 flex flex-col justify-between bg-[#12141d] shrink-0"
                        >
                          <span
                            className="text-xs text-zinc-200 font-medium truncate"
                            title={cand.photo_name}
                          >
                            {cand.photo_name}
                          </span>

                          <div className="flex items-center gap-2">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAcceptBatch([cand.face_id]);
                              }}
                              className="flex-1 py-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1 transition"
                              title="Confirm this is the person"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Accept</span>
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDenyBatch([cand.face_id]);
                              }}
                              className="py-1.5 px-3 rounded-lg bg-zinc-800 hover:bg-red-950/80 text-zinc-400 hover:text-red-300 text-xs font-semibold flex items-center justify-center transition"
                              title="Not this person (Hide permanently for this person)"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              /* 1-BY-1 RAPID SPOTLIGHT REVIEW MODE */
              currentSpotlight && (
                <div className="flex-1 flex overflow-hidden p-6 gap-6">
                  {/* Left: Full Photo Context with Highlighted Face Box */}
                  <div className="flex-1 bg-zinc-950 border border-zinc-800 rounded-2xl flex items-center justify-center p-4 relative overflow-hidden">
                    <div className="relative inline-block max-w-full max-h-full">
                      <img
                        src={convertFileSrc(currentSpotlight.photo_path)}
                        alt={currentSpotlight.photo_name}
                        className="block max-w-full max-h-[62vh] w-auto h-auto object-contain rounded-lg select-none"
                      />
                      <div
                        style={{
                          left: `${currentSpotlight.bbox_x * 100}%`,
                          top: `${currentSpotlight.bbox_y * 100}%`,
                          width: `${currentSpotlight.bbox_w * 100}%`,
                          height: `${currentSpotlight.bbox_h * 100}%`,
                        }}
                        className="absolute rounded-md border-2 border-emerald-400 bg-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.75)] pointer-events-none"
                      >
                        <span className="absolute -top-6 left-0 px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-bold whitespace-nowrap shadow">
                          {activePerson}? ({currentSpotlight.similarity}%)
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Right: Close-up Face Crop & Keyboard Decision Controls */}
                  <div className="w-80 bg-[#12141d] border border-zinc-800 rounded-2xl p-5 flex flex-col justify-between shrink-0">
                    <div className="flex flex-col items-center text-center gap-3">
                      <div className="flex items-center justify-between w-full text-xs text-zinc-400 font-mono">
                        <span>
                          Candidate {spotlightIndex + 1} of {candidates.length}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() =>
                              setSpotlightIndex((i) => Math.max(0, i - 1))
                            }
                            disabled={spotlightIndex === 0}
                            className="p-1 rounded bg-zinc-900 hover:bg-zinc-800 disabled:opacity-30"
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() =>
                              setSpotlightIndex((i) =>
                                Math.min(candidates.length - 1, i + 1)
                              )
                            }
                            disabled={spotlightIndex >= candidates.length - 1}
                            className="p-1 rounded bg-zinc-900 hover:bg-zinc-800 disabled:opacity-30"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      <img
                        src={convertFileSrc(currentSpotlight.face_thumb)}
                        alt="Candidate face"
                        className="w-44 h-44 rounded-2xl object-cover border-2 border-indigo-500/50 shadow-xl mt-2"
                      />

                      <div>
                        <div className="text-base font-bold text-zinc-100">
                          Is this <span className="text-emerald-400 capitalize">{activePerson}</span>?
                        </div>
                        <div className="text-xs font-mono text-indigo-300 mt-0.5">
                          Biometric Similarity: {currentSpotlight.similarity}%
                        </div>
                        <div
                          className="text-[11px] text-zinc-500 mt-1 truncate max-w-[240px]"
                          title={currentSpotlight.photo_name}
                        >
                          Photo: {currentSpotlight.photo_name}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2.5">
                      <button
                        onClick={() => handleAcceptBatch([currentSpotlight.face_id])}
                        className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg transition"
                      >
                        <Check className="w-4 h-4" />
                        <span>Accept Match (Y / Enter)</span>
                      </button>
                      <button
                        onClick={() => handleDenyBatch([currentSpotlight.face_id])}
                        className="w-full py-2.5 rounded-xl bg-red-950/70 hover:bg-red-900 border border-red-800/60 text-red-200 font-semibold text-xs flex items-center justify-center gap-2 transition"
                      >
                        <X className="w-4 h-4" />
                        <span>Deny & Ignore (N / Backspace)</span>
                      </button>
                    </div>
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}