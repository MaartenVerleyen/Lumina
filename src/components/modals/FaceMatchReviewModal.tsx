import { useState, useEffect, useCallback, useRef } from "react";
import UnknownFaceClusters from "./UnknownFaceClusters";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import {
  FaceInstance,
  PersonItem,
  PhotoItem,
  SimilarFaceCandidate,
} from "../../types/lumina";
import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Loader2,
  RefreshCw,
  RotateCcw,
  ScanFace,
  ShieldCheck,
  Sparkles,
  User,
  UserMinus,
  Users,
  X,
} from "lucide-react";

interface FaceMatchReviewModalProps {
  isOpen: boolean;
  initialPerson: string | null;
  onClose: () => void;
  people: PersonItem[];
  pendingCounts: Record<string, number>;
  setPhotos: React.Dispatch<React.SetStateAction<PhotoItem[]>>;
  refreshPeople: (currentFolder?: string, skipPendingScan?: boolean) => Promise<void>;
  folder: string;
}

type StatusTab = "pending" | "confirmed" | "denied";

// Accepting this many faces in one click asks first (a stray "Select All" shouldn't name a crowd)
const CONFIRM_ACCEPT_COUNT = 50;

// Pass as the initial person to open the modal on "Who is this?" (groups of unnamed faces)
export const UNKNOWN_FACES = "__unknown_faces__";

interface HistoryStep {
  action: "accept" | "deny";
  person: string;
  candidates: SimilarFaceCandidate[];
}

export default function FaceMatchReviewModal({
  isOpen,
  initialPerson,
  onClose,
  people,
  pendingCounts,
  setPhotos,
  refreshPeople,
  folder,
}: FaceMatchReviewModalProps) {
  const [activePerson, setActivePerson] = useState<string>("");
  // The person the currently displayed lists were loaded for. Accept/Deny always act on THIS person,
  // so a slow response for a previously selected person can never be assigned to the new one.
  const [listPerson, setListPerson] = useState<string>("");
  const loadRequestRef = useRef(0);
  const [actionError, setActionError] = useState<string>("");
  // Loading the list itself failed (shown instead of the "nothing left to review" message)
  const [loadFailed, setLoadFailed] = useState<boolean>(false);
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  const [strongMatchPercent, setStrongMatchPercent] = useState<number>(62);
  const [statusTab, setStatusTab] = useState<StatusTab>("pending");
  // "person": one person's suggestions / confirmed / denied faces; "unknown": groups of unnamed faces
  const [view, setView] = useState<"person" | "unknown">("person");
  const [candidates, setCandidates] = useState<SimilarFaceCandidate[]>([]);
  const [confirmedFaces, setConfirmedFaces] = useState<SimilarFaceCandidate[]>([]);
  const [deniedFaces, setDeniedFaces] = useState<SimilarFaceCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [reviewMode, setReviewMode] = useState<"grid" | "spotlight">("grid");
  const [spotlightIndex, setSpotlightIndex] = useState<number>(0);
  const [historyStack, setHistoryStack] = useState<HistoryStep[]>([]);

  const syncUpdatedFacesToPhotos = useCallback(
    (updatedMap: Record<string, FaceInstance[]>) => {
      const hashes = Object.keys(updatedMap);
      if (hashes.length === 0) return;
      setPhotos((prev) =>
        prev.map((p) => {
          const nextFaces = updatedMap[p.hash];
          if (!nextFaces) return p;
          const activeFaceNames = Array.from(
            new Set(
              nextFaces
                .map((f) => f.person_name?.trim())
                .filter((n): n is string => Boolean(n))
            )
          );
          const mergedPeople = Array.from(
            new Set([
              ...p.people.filter(
                (pe) => pe.toLowerCase() !== activePerson.toLowerCase()
              ),
              ...activeFaceNames,
            ])
          ).sort();
          return {
            ...p,
            faces: nextFaces,
            people: mergedPeople,
          };
        })
      );
    },
    [activePerson, setPhotos]
  );

  const loadDataForPerson = useCallback(
    async (
      personName: string,
      tab: StatusTab = statusTab,
      forceRefresh = false
    ) => {
      const clean = personName.trim();
      if (!clean) return;
      const requestId = ++loadRequestRef.current;
      const isStale = () => requestId !== loadRequestRef.current;
      setActivePerson(clean);
      setIsLoading(true);
      setActionError("");
      setLoadFailed(false);
      try {
        if (tab === "pending") {
          const res = await invoke<SimilarFaceCandidate[]>("find_similar_faces", {
            personName: clean,
            rootFolder: folder || null,
            forceRefresh,
          });
          if (isStale()) return;
          setCandidates(res);
          // "Likely" matches (>= the strong threshold: every one was correct in face_eval) start selected,
          // so one click on "Accept Selected" confirms them; "maybe" matches need an explicit choice
          setSelectedIds(new Set(res.filter((c) => c.similarity >= strongMatchPercent).map((c) => c.face_id)));
          setSpotlightIndex(0);
        } else if (tab === "confirmed") {
          const res = await invoke<SimilarFaceCandidate[]>(
            "get_confirmed_faces_for_person",
            { personName: clean }
          );
          if (isStale()) return;
          setConfirmedFaces(res);
          setSelectedIds(new Set());
        } else if (tab === "denied") {
          const res = await invoke<SimilarFaceCandidate[]>(
            "get_rejected_faces_for_person",
            { personName: clean }
          );
          if (isStale()) return;
          setDeniedFaces(res);
          setSelectedIds(new Set());
        }
        setListPerson(clean);
      } catch (err) {
        if (isStale()) return;
        setCandidates([]);
        setConfirmedFaces([]);
        setDeniedFaces([]);
        setSelectedIds(new Set());
        setListPerson(clean);
        setLoadFailed(true);
        setActionError(`Could not load faces for "${clean}": ${String(err)}`);
      } finally {
        if (!isStale()) setIsLoading(false);
      }
    },
    [statusTab, folder, strongMatchPercent]
  );

  useEffect(() => {
    if (!isOpen) return;
    invoke<{ min_similarity_percent: number; strong_similarity_percent: number }>(
      "get_face_match_config"
    )
      .then((cfg) => setStrongMatchPercent(cfg.strong_similarity_percent))
      .catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setStatusTab("pending");
    setHistoryStack([]);
    if (initialPerson === UNKNOWN_FACES || people.length === 0) {
      setView("unknown");
      return;
    }
    setView("person");
    const target =
      initialPerson ||
      people.find((p) => (pendingCounts[p.name] || 0) > 0)?.name ||
      people[0]?.name ||
      "";
    if (target) {
      loadDataForPerson(target, "pending");
    }
  }, [isOpen, initialPerson]);

  const handleSwitchTab = async (nextTab: StatusTab) => {
    setStatusTab(nextTab);
    if (nextTab !== "pending") {
      setReviewMode("grid");
    }
    if (activePerson) {
      await loadDataForPerson(activePerson, nextTab);
    }
  };

  // Accept 1 or more pending candidates WITHOUT triggering a full re-scan on every click!
  const handleAcceptBatch = useCallback(
    async (faceIds: string[], recordHistory = true) => {
      const person = listPerson;
      if (!person || isLoading || faceIds.length === 0) return;
      const idSet = new Set(faceIds);
      const affectedItems = candidates.filter((c) => idSet.has(c.face_id));

      // Optimistically remove from UI list immediately so rapid clicking feels 0ms!
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

      try {
        const updatedFacesMap = await invoke<Record<string, FaceInstance[]>>(
          "assign_faces_to_person_batch",
          {
            faceIds,
            personName: person,
          }
        );
        if (recordHistory && affectedItems.length > 0) {
          setHistoryStack((prev) => [
            ...prev.slice(-29),
            { action: "accept", person, candidates: affectedItems },
          ]);
        }
        syncUpdatedFacesToPhotos(updatedFacesMap);
        await refreshPeople(undefined, true);
      } catch (err) {
        restoreCandidates(affectedItems);
        setActionError(`Could not confirm ${faceIds.length} face(s) as "${person}": ${String(err)}`);
      }
    },
    [listPerson, isLoading, candidates, syncUpdatedFacesToPhotos, refreshPeople]
  );

  // Deny 1 or more pending candidates WITHOUT triggering a full re-scan on every click!
  const handleDenyBatch = useCallback(
    async (faceIds: string[], recordHistory = true) => {
      const person = listPerson;
      if (!person || isLoading || faceIds.length === 0) return;
      const idSet = new Set(faceIds);
      const affectedItems = candidates.filter((c) => idSet.has(c.face_id));

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

      try {
        await invoke<number>("reject_face_candidates_batch", {
          faceIds,
          personName: person,
        });
        if (recordHistory && affectedItems.length > 0) {
          setHistoryStack((prev) => [
            ...prev.slice(-29),
            { action: "deny", person, candidates: affectedItems },
          ]);
        }
        await refreshPeople(undefined, true);
      } catch (err) {
        restoreCandidates(affectedItems);
        setActionError(`Could not deny ${faceIds.length} face(s) for "${person}": ${String(err)}`);
      }
    },
    [listPerson, isLoading, candidates, refreshPeople]
  );

  function toggleSelected(faceId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(faceId)) next.delete(faceId);
      else next.add(faceId);
      return next;
    });
  }

  // Puts optimistically removed candidates back after a failed backend call
  function restoreCandidates(items: SimilarFaceCandidate[]) {
    setCandidates((prev) => {
      const existingIds = new Set(prev.map((x) => x.face_id));
      return [...items.filter((x) => !existingIds.has(x.face_id)), ...prev].sort(
        (a, b) => b.similarity - a.similarity
      );
    });
  }

  // Undo the last Accept or Deny action inside the modal!
  const handleUndoLastDecision = useCallback(async () => {
    if (historyStack.length === 0) return;
    const last = historyStack[historyStack.length - 1];
    const faceIds = last.candidates.map((c) => c.face_id);

    try {
      if (last.action === "accept") {
        const updatedMap = await invoke<Record<string, FaceInstance[]>>(
          "unassign_faces_batch",
          {
            faceIds,
            personName: last.person,
          }
        );
        syncUpdatedFacesToPhotos(updatedMap);
      } else {
        await invoke<number>("unreject_face_candidates_batch", {
          faceIds,
          personName: last.person,
        });
      }
    } catch (err) {
      setActionError(`Could not undo the last decision: ${String(err)}`);
      return;
    }
    // Pop only after the backend succeeded, so a failed undo can simply be retried
    setHistoryStack((prev) => prev.slice(0, -1));

    if (last.person.toLowerCase() === activePerson.toLowerCase() && statusTab === "pending") {
      setCandidates((prev) => {
        const existingIds = new Set(prev.map((x) => x.face_id));
        const restored = last.candidates.filter((x) => !existingIds.has(x.face_id));
        return [...restored, ...prev];
      });
    }
    await refreshPeople();
  }, [historyStack, activePerson, statusTab, syncUpdatedFacesToPhotos, refreshPeople]);

  // Unassign a face from the "Confirmed Faces" tab (if you accidentally confirmed someone)
  const handleUnassignConfirmed = useCallback(
    async (faceIds: string[]) => {
      const person = listPerson;
      if (!person || isLoading || faceIds.length === 0) return;
      const idSet = new Set(faceIds);
      const removed = confirmedFaces.filter((c) => idSet.has(c.face_id));
      setConfirmedFaces((prev) => prev.filter((c) => !idSet.has(c.face_id)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of faceIds) next.delete(id);
        return next;
      });
      try {
        const updatedMap = await invoke<Record<string, FaceInstance[]>>(
          "unassign_faces_batch",
          {
            faceIds,
            personName: person,
          }
        );
        syncUpdatedFacesToPhotos(updatedMap);
        await refreshPeople();
      } catch (err) {
        setConfirmedFaces((prev) => [...removed, ...prev]);
        setActionError(`Could not unassign ${faceIds.length} face(s) from "${person}": ${String(err)}`);
      }
    },
    [listPerson, isLoading, confirmedFaces, syncUpdatedFacesToPhotos, refreshPeople]
  );

  // Restore a face from the "Denied / Ignored" tab (if you accidentally denied someone)
  const handleRestoreDenied = useCallback(
    async (faceIds: string[], alsoAccept = false) => {
      const person = listPerson;
      if (!person || isLoading || faceIds.length === 0) return;
      const idSet = new Set(faceIds);
      const removed = deniedFaces.filter((c) => idSet.has(c.face_id));
      setDeniedFaces((prev) => prev.filter((c) => !idSet.has(c.face_id)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of faceIds) next.delete(id);
        return next;
      });
      try {
        await invoke<number>("unreject_face_candidates_batch", {
          faceIds,
          personName: person,
        });
        if (alsoAccept) {
          const updatedMap = await invoke<Record<string, FaceInstance[]>>(
            "assign_faces_to_person_batch",
            {
              faceIds,
              personName: person,
            }
          );
          syncUpdatedFacesToPhotos(updatedMap);
        }
        await refreshPeople();
      } catch (err) {
        setDeniedFaces((prev) => [...removed, ...prev]);
        setActionError(`Could not restore ${faceIds.length} face(s) for "${person}": ${String(err)}`);
      }
    },
    [listPerson, isLoading, deniedFaces, syncUpdatedFacesToPhotos, refreshPeople]
  );

  // Keyboard shortcuts inside the modal (Spotlight, Ctrl+Z Undo & Escape)
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (view === "unknown" && e.key !== "Escape") return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && e.key !== "Escape") return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        handleUndoLastDecision();
        return;
      }
      if (statusTab === "pending" && reviewMode === "spotlight" && candidates.length > 0) {
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
  }, [
    isOpen,
    view,
    statusTab,
    reviewMode,
    candidates,
    spotlightIndex,
    handleAcceptBatch,
    handleDenyBatch,
    handleUndoLastDecision,
    onClose,
  ]);

  if (!isOpen) return null;

  const activeList =
    statusTab === "pending"
      ? candidates
      : statusTab === "confirmed"
      ? confirmedFaces
      : deniedFaces;

  const currentSpotlight = candidates[spotlightIndex] || null;
  const nextSpotlight = reviewMode === "spotlight" ? candidates[spotlightIndex + 1] : undefined;
  const activePersonObj = people.find(
    (p) => p.name.toLowerCase() === activePerson.toLowerCase()
  );

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9998] bg-black/85 backdrop-blur-md flex items-center justify-center p-6 select-none animate-in fade-in"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Face match review"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-[#0e1017] border border-zinc-800 rounded-2xl w-full max-w-6xl h-[86vh] shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Top Modal Header */}
        <div className="px-6 py-4 bg-[#12141d] border-b border-zinc-800 flex items-center justify-between shrink-0 gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
              <ScanFace className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <span>Face Match Review & Confirmation Studio</span>
              </h2>
              <p className="text-xs text-zinc-400">
                Review potential matches, manage confirmed faces, or restore accidentally denied faces.
              </p>
            </div>
          </div>

          {/* 3-Tab Status Switcher: Pending Suggestions | Confirmed Faces | Denied / Ignored */}
          <div className={`flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded-xl p-1 text-xs ${view === "unknown" ? "invisible" : ""}`}>
            <button
              onClick={() => handleSwitchTab("pending")}
              className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition ${
                statusTab === "pending"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Pending Matches ({pendingCounts[activePerson] ?? candidates.length})</span>
            </button>
            <button
              onClick={() => handleSwitchTab("confirmed")}
              className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition ${
                statusTab === "confirmed"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Confirmed ({activePersonObj?.photo_count ?? confirmedFaces.length})</span>
            </button>
            <button
              onClick={() => handleSwitchTab("denied")}
              className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition ${
                statusTab === "denied"
                  ? "bg-red-500/20 text-red-300 border border-red-500/40"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <X className="w-3.5 h-3.5" />
              <span>Denied / Ignored</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            {/* Undo Last Accept/Deny Button */}
            {historyStack.length > 0 && (
              <button
                onClick={handleUndoLastDecision}
                className="px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-semibold flex items-center gap-1.5 transition"
                title="Undo last Accept or Deny action (Ctrl+Z)"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>
                  Undo {historyStack[historyStack.length - 1].action === "accept" ? "Accept" : "Deny"}
                </span>
              </button>
            )}

            {/* Mode Switcher: Large Grid vs 1-by-1 Spotlight (for Pending tab) */}
            {statusTab === "pending" && (
              <div className="flex bg-zinc-900 border border-zinc-800 rounded-xl p-0.5 text-xs">
                <button
                  onClick={() => setReviewMode("grid")}
                  className={`px-2.5 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition ${
                    reviewMode === "grid"
                      ? "bg-indigo-600 text-white shadow"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span>3-Col Grid</span>
                </button>
                <button
                  onClick={() => setReviewMode("spotlight")}
                  className={`px-2.5 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition ${
                    reviewMode === "spotlight"
                      ? "bg-indigo-600 text-white shadow"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Spotlight (Y/N)</span>
                </button>
              </div>
            )}

            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800"
              aria-label="Close Face Review"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body: Left People Sidebar + Main Candidate Workspace */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left Sidebar: People List & Pending Counts */}
          <aside className="w-64 bg-[#0b0c12] border-r border-zinc-800/80 flex flex-col overflow-y-auto p-3 gap-1.5 shrink-0">
            <button
              onClick={() => setView("unknown")}
              className={`w-full flex items-center gap-2.5 p-2 rounded-xl text-xs transition mb-1 ${
                view === "unknown"
                  ? "bg-indigo-600/20 text-indigo-200 border border-indigo-500/40 shadow-sm"
                  : "hover:bg-zinc-900 text-zinc-300 border border-zinc-800"
              }`}
              title="Groups of unnamed faces that look like the same person"
            >
              <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4 text-indigo-300" />
              </div>
              <div className="text-left">
                <div className="font-semibold">Who is this?</div>
                <div className="text-[10px] text-zinc-500">Name unknown faces in groups</div>
              </div>
            </button>
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider px-2 py-1">
              Confirmed People ({people.length})
            </span>

            {people.map((p) => {
              const isSelected = view === "person" && p.name.toLowerCase() === activePerson.toLowerCase();
              const pending = pendingCounts[p.name] || 0;
              return (
                <button
                  key={p.name}
                  onClick={() => {
                    setView("person");
                    loadDataForPerson(p.name, statusTab);
                  }}
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

          {view === "unknown" && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#090a0f]">
              <UnknownFaceClusters
                folder={folder}
                peopleNames={people.map((p) => p.name)}
                setPhotos={setPhotos}
                refreshPeople={refreshPeople}
              />
            </div>
          )}

          {/* Main Workspace */}
          <div className={`flex-1 flex flex-col min-h-0 overflow-hidden bg-[#090a0f] ${view === "unknown" ? "hidden" : ""}`}>
            {/* Action Sub-Toolbar */}
            <div className="px-6 py-3 bg-[#0e1017] border-b border-zinc-800/80 flex items-center justify-between text-xs shrink-0 gap-2 flex-wrap">
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
                  {statusTab === "pending" && (
                    <>
                      — <strong>{candidates.length}</strong> pending suggestion
                      {candidates.length === 1 ? "" : "s"}
                    </>
                  )}
                  {statusTab === "confirmed" && (
                    <>
                      — <strong>{confirmedFaces.length}</strong> confirmed face box
                      {confirmedFaces.length === 1 ? "" : "es"}
                    </>
                  )}
                  {statusTab === "denied" && (
                    <>
                      — <strong>{deniedFaces.length}</strong> denied / ignored face box
                      {deniedFaces.length === 1 ? "" : "es"}
                    </>
                  )}
                </span>

                {statusTab === "pending" && (
                  <button
                    onClick={async () => {
                    await refreshPeople();
                    await loadDataForPerson(activePerson, "pending", true);
                  }}
                    className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-indigo-300 flex items-center gap-1 text-[11px] font-medium"
                    title="Re-scan unassigned faces using your newly confirmed faces"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Refresh Suggestions</span>
                  </button>
                )}
              </div>

              {reviewMode === "grid" && activeList.length > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      setSelectedIds(new Set(activeList.map((c) => c.face_id)))
                    }
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300"
                  >
                    Select All ({activeList.length})
                  </button>
                  {selectedIds.size > 0 && (
                    <button
                      onClick={() => setSelectedIds(new Set())}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400"
                    >
                      Clear ({selectedIds.size})
                    </button>
                  )}

                  {statusTab === "pending" && (
                    <>
                      <button
                        onClick={() => handleDenyBatch(Array.from(selectedIds))}
                        disabled={selectedIds.size === 0}
                        className="px-3 py-1.5 rounded-lg bg-red-950/60 hover:bg-red-900/80 disabled:opacity-40 border border-red-800/50 text-red-200 font-semibold flex items-center gap-1.5 transition"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Deny Selected ({selectedIds.size})</span>
                      </button>
                      <button
                        onClick={async () => {
                          const ids = Array.from(selectedIds);
                          if (
                            ids.length >= CONFIRM_ACCEPT_COUNT &&
                            !(await ask(`Confirm all ${ids.length} selected faces as "${activePerson}"?`, {
                              title: "Accept faces",
                              kind: "warning",
                              okLabel: `Accept ${ids.length}`,
                              cancelLabel: "Cancel",
                            }))
                          ) {
                            return;
                          }
                          handleAcceptBatch(ids);
                        }}
                        disabled={selectedIds.size === 0}
                        className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold flex items-center gap-1.5 shadow transition"
                      >
                        <CheckCheck className="w-4 h-4" />
                        <span>Accept Selected ({selectedIds.size})</span>
                      </button>
                    </>
                  )}

                  {statusTab === "confirmed" && (
                    <button
                      onClick={() => handleUnassignConfirmed(Array.from(selectedIds))}
                      disabled={selectedIds.size === 0}
                      className="px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-semibold flex items-center gap-1.5 shadow transition"
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                      <span>Remove Selected from "{activePerson}" ({selectedIds.size})</span>
                    </button>
                  )}

                  {statusTab === "denied" && (
                    <>
                      <button
                        onClick={() => handleRestoreDenied(Array.from(selectedIds), false)}
                        disabled={selectedIds.size === 0}
                        className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 font-semibold flex items-center gap-1.5 transition"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Move Back to Pending ({selectedIds.size})</span>
                      </button>
                      <button
                        onClick={() => handleRestoreDenied(Array.from(selectedIds), true)}
                        disabled={selectedIds.size === 0}
                        className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold flex items-center gap-1.5 shadow transition"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Accept as "{activePerson}" ({selectedIds.size})</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {actionError && (
              <div
                role="alert"
                className="mx-6 mt-3 px-3 py-2 rounded-lg bg-red-950/70 border border-red-500/40 text-red-200 text-xs flex items-start gap-2"
              >
                <span className="flex-1">{actionError}</span>
                <button
                  onClick={() => setActionError("")}
                  className="text-red-300 hover:text-white"
                  aria-label="Dismiss error"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Content Area */}
            {isLoading ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                <span className="text-xs font-mono">
                  Loading faces for "{activePerson}"...
                </span>
              </div>
            ) : loadFailed ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center p-8">
                <h3 className="text-sm font-bold text-red-200">Faces for "{activePerson}" could not be loaded</h3>
                <p className="text-xs text-zinc-500 max-w-sm">The error is shown above. This is not the same as having no matches.</p>
                <button
                  onClick={() => loadDataForPerson(activePerson, statusTab)}
                  className="mt-2 px-3.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-semibold flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Try Again</span>
                </button>
              </div>
            ) : activeList.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center p-8">
                <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-1">
                  <Check className="w-6 h-6 text-emerald-400" />
                </div>
                <h3 className="text-sm font-bold text-zinc-200">
                  {statusTab === "pending" &&
                    `No Pending Suggestions Remaining for "${activePerson}"`}
                  {statusTab === "confirmed" &&
                    `No Confirmed Faces Recorded for "${activePerson}"`}
                  {statusTab === "denied" &&
                    `No Denied Faces for "${activePerson}"`}
                </h3>
                {statusTab === "pending" && (
                  <button
                    onClick={async () => {
                    await refreshPeople();
                    await loadDataForPerson(activePerson, "pending", true);
                  }}
                    className="mt-2 px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Scan for More Matches Using Newly Confirmed Faces</span>
                  </button>
                )}
              </div>
            ) : reviewMode === "grid" || statusTab !== "pending" ? (
              /* 3-COLUMN FIXED 250PX CARD GRID MODE */
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
                  {activeList.map((cand) => {
                    const isSelected = selectedIds.has(cand.face_id);
                    return (
                      <div
                        key={cand.face_id}
                        role="checkbox"
                        aria-checked={isSelected}
                        aria-label={`${cand.photo_name}${statusTab === "pending" ? `, ${cand.similarity}%` : ""}`}
                        tabIndex={0}
                        onClick={() => toggleSelected(cand.face_id)}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === " " || e.key === "Enter") {
                            e.preventDefault();
                            toggleSelected(cand.face_id);
                          }
                        }}
                        // Long lists: cards outside the viewport skip layout and paint until scrolled to
                        style={{ height: "250px", contentVisibility: "auto", containIntrinsicSize: "auto 250px" }}
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
                            decoding="async"
                            loading="lazy"
                            className="w-full h-full object-cover group-hover:scale-105 transition duration-200"
                          />

                          {/* Status / Similarity Pill */}
                          {statusTab === "pending" && (
                            <span
                              className={`absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold backdrop-blur-md shadow ${
                                cand.similarity >= strongMatchPercent
                                  ? "bg-emerald-950/90 text-emerald-300 border border-emerald-500/40"
                                  : "bg-amber-950/90 text-amber-300 border border-amber-500/40"
                              }`}
                            >
                              {cand.similarity >= strongMatchPercent ? "Likely" : "Maybe"} · {cand.similarity}%
                            </span>
                          )}
                          {statusTab === "confirmed" && (
                            <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-emerald-950/90 text-emerald-300 border border-emerald-500/40 backdrop-blur-md">
                              ✓ Confirmed {activePerson}
                            </span>
                          )}
                          {statusTab === "denied" && (
                            <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-red-950/90 text-red-300 border border-red-500/40 backdrop-blur-md">
                              ✕ Denied
                            </span>
                          )}

                          {/* Inspect in Spotlight Button */}
                          {statusTab === "pending" && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                const idx = candidates.findIndex(
                                  (x) => x.face_id === cand.face_id
                                );
                                if (idx >= 0) setSpotlightIndex(idx);
                                setReviewMode("spotlight");
                              }}
                              className="absolute top-2.5 right-2.5 px-2.5 py-1 rounded-md bg-black/80 hover:bg-indigo-600 text-zinc-200 hover:text-white text-[10px] font-semibold opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition backdrop-blur shadow"
                              title="Inspect full photo context"
                            >
                              Full Photo
                            </button>
                          )}
                        </div>

                        {/* Card Footer (78px high: Filename + Action Buttons) */}
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

                          {statusTab === "pending" && (
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
                                title="Not this person (Move to Denied tab)"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}

                          {statusTab === "confirmed" && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUnassignConfirmed([cand.face_id]);
                              }}
                              className="w-full py-1.5 rounded-lg bg-zinc-800 hover:bg-amber-600 text-zinc-200 hover:text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                              title="Unassign this face from this person and return it to unassigned"
                            >
                              <UserMinus className="w-3.5 h-3.5" />
                              <span>Unassign from {activePerson}</span>
                            </button>
                          )}

                          {statusTab === "denied" && (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRestoreDenied([cand.face_id], false);
                                }}
                                className="flex-1 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold flex items-center justify-center gap-1 transition"
                                title="Remove from Denied list so it appears in Pending again"
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>Restore</span>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRestoreDenied([cand.face_id], true);
                                }}
                                className="flex-1 py-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1 transition"
                                title="Directly confirm as this person"
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>Accept</span>
                              </button>
                            </div>
                          )}
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
                      {nextSpotlight && (
                        // Loads the next candidate's photo in the background so Y/N feels instant
                        <img src={convertFileSrc(nextSpotlight.photo_path)} alt="" aria-hidden className="hidden" />
                      )}
                      <img
                        src={convertFileSrc(currentSpotlight.photo_path)}
                        alt={currentSpotlight.photo_name}
                        decoding="async"
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
