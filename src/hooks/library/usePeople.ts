import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PersonItem, FaceScanProgress, FaceMatchEvent, FaceInstance, FaceModelDownloadProgress } from "../../types/lumina";
import { diskPathOf } from "../../utils/rawPairs";
import { removeFromExpr, renameInExpr } from "../../utils/peopleQuery";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";

// People: face scans, naming faces, matches to review, rename / merge / hide, profile pictures
export function usePeople(core: LibraryCore, filters: FilterState) {
  const {
    folder,
    photos,
    setPhotos,
    photoByHash,
    activePhoto,
    activeHash,
    resolveTargets,
    pushCustomUndo,
    confirmAction,
    addLog,
    setError,
    setAutoMatchNotice,
    setBulkInput,
    setActiveBulkPopover,
  } = core;
  const { setPeopleFilter } = filters;
  const [people, setPeople] = useState<PersonItem[]>([]);
  const [pendingFaceCounts, setPendingFaceCounts] = useState<Record<string, number>>({});
  // Face Review dialog: the person it is open for (or UNKNOWN_FACES for "Who is this?"), null when closed
  const [faceReviewPerson, setFaceReviewPerson] = useState<string | null>(null);
  const [faceScanProgress, setFaceScanProgress] = useState<FaceScanProgress | null>(null);
  const [isDetectingSingleFace, setIsDetectingSingleFace] = useState<boolean>(false);
  // Interactive Face Box State
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(null);
  const [isDrawingFace, setIsDrawingFace] = useState<boolean>(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawnBox, setDrawnBox] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null
  );
  const [faceNameInput, setFaceNameInput] = useState<string>("");

  // A newly opened photo starts with its first face selected
  useEffect(() => {
    const firstFace = activePhoto?.faces?.[0];
    setSelectedFaceId(firstFace ? firstFace.face_id : null);
    setDrawnBox(null);
    setIsDrawingFace(false);
    setFaceNameInput(firstFace?.person_name || "");
  }, [activeHash]);

  // One-time face model download progress (shown in the header while a face scan waits for it)
  const [faceModelDownload, setFaceModelDownload] = useState<FaceModelDownloadProgress | null>(null);
  useEffect(() => {
    const unlisten = listen<FaceModelDownloadProgress>("face-model-download", (event) => {
      const prog = event.payload;
      if (prog.done) {
        setFaceModelDownload(null);
        addLog("FACE", prog.stage);
      } else {
        setFaceModelDownload(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog]);

  async function refreshPeople(currentFolder = folder, skipPendingScan = false) {
    try {
      // 1. Immediately load & render the Top People Carousel (<2ms) without waiting on biometric matching!
      const res = await invoke<PersonItem[]>("get_people", {
        rootFolder: currentFolder || null,
      });
      setPeople(res);

      // 2. Asynchronously compute & cache pending face match counts in the background
      if (!skipPendingScan) {
        invoke<Record<string, number>>("get_pending_face_match_counts", {
          rootFolder: currentFolder || null,
        })
          .then((pending) => {
            setPendingFaceCounts(pending || {});
          })
          .catch(() => {});
      }
    } catch {}
  }

  // Debounced: opening a folder changes `folder` and then `photos.length`, which used to run the
  // (expensive) face-match count twice back to back
  useEffect(() => {
    const timer = setTimeout(() => {
      refreshPeople(folder);
    }, 400);
    return () => clearTimeout(timer);
  }, [photos.length, folder]);

  useEffect(() => {
    const unlisten = listen<FaceMatchEvent>("face-automatch-complete", (event) => {
      const { person_name, matched_hashes, total_matched } = event.payload;
      if (total_matched > 0) {
        const matchedSet = new Set(matched_hashes);
        setPhotos((prev) =>
          prev.map((p) =>
            matchedSet.has(p.hash) && !p.people.includes(person_name)
              ? { ...p, people: [...p.people, person_name].sort() }
              : p
          )
        );
        setAutoMatchNotice(
          `Auto-matched "${person_name}" across ${total_matched} other verified face${
            total_matched === 1 ? "" : "s"
          }!`
        );
        addLog("FACE", `Auto-matched "${person_name}" across ${total_matched} photo(s)`);
      } else {
        setAutoMatchNotice(`Saved "${person_name}"!`);
      }
      refreshPeople();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog]);

  useEffect(() => {
    const unlisten = listen<FaceScanProgress>("face-scan-progress", (event) => {
      const prog = event.payload;

      if (prog.batch_faces && Object.keys(prog.batch_faces).length > 0) {
        const facesMap = prog.batch_faces;
        const peopleMap = prog.batch_people || {};
        setPhotos((prev) =>
          prev.map((p) => {
            if (!(p.hash in facesMap)) return p;
            const updatedFaces = facesMap[p.hash] || [];
            const extraPeople = peopleMap[p.hash] || [];
            const confirmedNames = new Set(
              updatedFaces
                .map((f) => f.person_name?.trim())
                .filter((n): n is string => Boolean(n))
            );
            const mergedPeople = Array.from(
              new Set([...confirmedNames, ...extraPeople])
            ).sort();
            return {
              ...p,
              faces: updatedFaces,
              people: mergedPeople,
            };
          })
        );
      }

      if (prog.done) {
        setFaceScanProgress(null);
        if (prog.cancelled) {
          addLog(
            "FACE",
            `Cancelled ONNX Face Scan after ${prog.completed} of ${prog.total} photos`,
            `${prog.faces_found} faces found; photos not reached keep their previous faces`
          );
        } else {
          addLog(
            "FACE",
            `Completed ONNX Face Scan on ${prog.total} photos`,
            `${prog.faces_found} faces found — analyzing potential matches in background...`
          );
        }
        refreshPeople(folder, false).then(() => {
          setAutoMatchNotice(
            `Face Scan complete: detected ${prog.faces_found} face(s) & updated potential match badges!`
          );
        });
      } else {
        setFaceScanProgress(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [folder, addLog]);

  async function handleDetectFacesSingleOnnx() {
    if (!activePhoto || isDetectingSingleFace) return;
    try {
      setIsDetectingSingleFace(true);
      const detected = await invoke<FaceInstance[]>("detect_faces_in_photo", {
        hash: activePhoto.hash,
        imagePath: diskPathOf(activePhoto),
        forceOnnx: true,
      });
      setPhotos((prev) =>
        prev.map((p) => (p.hash === activePhoto.hash ? { ...p, faces: detected } : p))
      );
      if (detected.length > 0) {
        setSelectedFaceId(detected[0].face_id);
        setFaceNameInput(detected[0].person_name || "");
      }
      addLog("FACE", `Detected ${detected.length} face(s) in ${activePhoto.name}`);
      setAutoMatchNotice(
        detected.length > 0
          ? `ONNX Neural Detector found ${detected.length} human face(s) in ${activePhoto.name}!`
          : `ONNX Neural Detector confirmed 0 human faces in ${activePhoto.name}.`
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setIsDetectingSingleFace(false);
    }
  }

  // Starts a background face scan (detect, align, embed) for these photos. Unconfirmed faces are replaced
  // photo by photo as results arrive (face-scan-progress), so a cancelled scan leaves unreached photos untouched.
  async function startFaceScan(hashes: string[], logMessage: string) {
    if (faceScanProgressRef.current || hashes.length === 0) return;
    try {
      setPendingFaceCounts({});
      setFaceScanProgress({
        completed: 0,
        total: hashes.length,
        faces_found: 0,
        auto_matched: 0,
        done: false,
        cancelled: false,
      });
      addLog("FACE", logMessage);
      // The first call downloads (288 MB, once) and loads the face models before the scan starts
      await invoke<number>("scan_library_faces_batch", { hashes });
    } catch (err) {
      setFaceScanProgress(null);
      setFaceModelDownload(null);
      setError(String(err));
    }
  }

  async function handleBatchScanFacesOnnx() {
    if (photos.length === 0) return;
    await startFaceScan(
      photos.map((p) => p.hash),
      `Started face scan on ${photos.length} photos`
    );
  }

  // Face engine upgrade: photos whose faces came from the previous engine are re-scanned automatically once
  // per opened folder (confirmed names and rejections carry over; the old embeddings can't be matched)
  const faceScanProgressRef = useRef(faceScanProgress);
  faceScanProgressRef.current = faceScanProgress;
  const hasPhotos = photos.length > 0;
  const faceUpgradeCheckedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
    if (!folder || !hasPhotos || faceUpgradeCheckedRef.current.has(folder)) return;
    const timer = setTimeout(async () => {
      if (faceScanProgressRef.current) return;
      faceUpgradeCheckedRef.current.add(folder);
      try {
        const outdated = await invoke<string[]>("get_outdated_face_photos", { rootFolder: folder });
        if (outdated.length > 0) {
          await startFaceScan(
            outdated,
            `Upgrading faces in ${outdated.length} photo(s) to the new face engine (names and rejections are kept)`
          );
        }
      } catch {}
    }, 1500);
    return () => clearTimeout(timer);
  }, [folder, hasPhotos]);

  async function handleCancelFaceScan() {
    try {
      await invoke("cancel_face_scan");
      addLog("FACE", "Stopping face scan after the current batch...");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaveFaceAndAutomatch(e: React.FormEvent) {
    e.preventDefault();
    if (!activePhoto || !faceNameInput.trim()) return;
    const cleanName = faceNameInput.trim();

    let targetBbox: { x: number; y: number; w: number; h: number } | null = null;
    let previousFacePerson: string | null = null;

    if (drawnBox) {
      targetBbox = drawnBox;
    } else if (selectedFaceId) {
      const found = activePhoto.faces.find((f) => f.face_id === selectedFaceId);
      if (found) {
        previousFacePerson = found.person_name || null;
        targetBbox = {
          x: found.bbox_x,
          y: found.bbox_y,
          w: found.bbox_w,
          h: found.bbox_h,
        };
      }
    } else if (activePhoto.faces.length === 1) {
      // Exactly one face on the photo: unambiguous
      const found = activePhoto.faces[0];
      previousFacePerson = found.person_name || null;
      targetBbox = {
        x: found.bbox_x,
        y: found.bbox_y,
        w: found.bbox_w,
        h: found.bbox_h,
      };
    }

    if (!targetBbox) {
      // Never invent a face region: a made-up box would be saved as a reference face and skew matching
      setError(
        activePhoto.faces.length > 1
          ? `This photo has ${activePhoto.faces.length} faces: click the face that is "${cleanName}" first.`
          : `No face selected: draw a box around ${cleanName}'s face first (or tag the photo via the bulk "Person" action).`
      );
      return;
    }

    try {
      setAutoMatchNotice(`Saving "${cleanName}" & matching against verified faces...`);
      const updatedFaces = await invoke<FaceInstance[]>("assign_face_region_and_automatch", {
        hash: activePhoto.hash,
        imagePath: diskPathOf(activePhoto),
        bboxX: targetBbox.x,
        bboxY: targetBbox.y,
        bboxW: targetBbox.w,
        bboxH: targetBbox.h,
        personName: cleanName,
      });

      const activeFaceNames = Array.from(
        new Set(
          updatedFaces
            .map((f) => f.person_name?.trim())
            .filter((n): n is string => Boolean(n))
        )
      );

      setPhotos((prev) =>
        prev.map((p) => {
          if (p.hash !== activePhoto.hash) return p;
          const remainingManual = p.people.filter(
            (pe) => !previousFacePerson || pe.toLowerCase() !== previousFacePerson.toLowerCase()
          );
          const mergedPeople = Array.from(
            new Set([...remainingManual, ...activeFaceNames, cleanName])
          ).sort();
          return {
            ...p,
            faces: updatedFaces,
            people: mergedPeople,
          };
        })
      );
      addLog("FACE", `Assigned face "${cleanName}" on ${activePhoto.name}`);
      setFaceNameInput("");
      setDrawnBox(null);
      setSelectedFaceId(null);
      refreshPeople();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleBatchAssignPerson(personName: string, targetHashes?: string[]) {
    const clean = personName.trim();
    const hashes = resolveTargets(targetHashes);
    if (!clean || hashes.length === 0) return;
    try {
      // Undo removes the person only from photos that didn't have them before
      const added = hashes.filter((h) => !photoByHash.get(h)?.people.includes(clean));
      const addedSet = new Set(added);
      const applyPerson = (on: boolean) =>
        setPhotos((prev) =>
          prev.map((p) => {
            if (!addedSet.has(p.hash)) return p;
            if (!on) return { ...p, people: p.people.filter((n) => n !== clean) };
            return p.people.includes(clean) ? p : { ...p, people: [...p.people, clean].sort() };
          })
        );
      await invoke<number>("add_person_to_photos", { hashes, name: clean });
      applyPerson(true);
      if (added.length > 0) {
        pushCustomUndo(
          `Person "${clean}" on ${added.length} photo(s)`,
          hashes,
          async () => {
            await invoke("remove_person_from_photos", { hashes: added, name: clean });
            applyPerson(false);
            refreshPeople();
          },
          async () => {
            await invoke<number>("add_person_to_photos", { hashes: added, name: clean });
            applyPerson(true);
            refreshPeople();
          }
        );
      }
      addLog("FACE", `Assigned person "${clean}" to ${hashes.length} selected photo(s)`);
      setBulkInput("");
      setActiveBulkPopover(null);
      refreshPeople();
    } catch (err) {
      setError(String(err));
    }
  }

  // ---------- People: rename / merge / hide ----------
  async function handleRenamePerson(oldName: string, newName: string) {
    const target = newName.trim();
    if (!target || target === oldName) return null;
    const merging = people.some(
      (p) => p.name.toLowerCase() === target.toLowerCase() && p.name.toLowerCase() !== oldName.toLowerCase()
    );
    if (merging) {
      const ok = await confirmAction(
        `"${target}" already exists. Merge "${oldName}" into "${target}"?\n\nAll photos, named faces and rejections of "${oldName}" move to "${target}".`,
        "Merge"
      );
      if (!ok) return null;
    }
    try {
      const finalName = await invoke<string>("rename_person", { oldName, newName: target });
      const old = oldName.toLowerCase();
      setPhotos((prev) =>
        prev.map((p) => {
          const hasOld = p.people.some((n) => n.toLowerCase() === old) || p.faces.some((f) => f.person_name?.toLowerCase() === old);
          if (!hasOld) return p;
          return {
            ...p,
            people: Array.from(new Set(p.people.map((n) => (n.toLowerCase() === old ? finalName : n)))).sort(),
            faces: p.faces.map((f) => (f.person_name?.toLowerCase() === old ? { ...f, person_name: finalName } : f)),
          };
        })
      );
      setPeopleFilter((prev) => renameInExpr(prev, oldName, finalName));
      addLog("FACE", merging ? `Merged "${oldName}" into "${finalName}"` : `Renamed "${oldName}" to "${finalName}"`);
      await refreshPeople();
      return finalName;
    } catch (err) {
      setError(String(err));
      return null;
    }
  }

  async function handleSetPersonHidden(name: string, hidden: boolean) {
    try {
      await invoke("set_person_hidden", { name, hidden });
      if (hidden) setPeopleFilter((prev) => removeFromExpr(prev, name));
      addLog("FACE", `${hidden ? "Hid" : "Unhid"} "${name}"`);
      await refreshPeople();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSetPersonCover(name: string, faceId: string) {
    try {
      await invoke("set_person_cover", { name, faceId });
      addLog("FACE", `New profile picture for "${name}"`);
      await refreshPeople(undefined, true);
    } catch (err) {
      setError(String(err));
    }
  }

  return {
    people,
    pendingFaceCounts,
    faceReviewPerson,
    setFaceReviewPerson,
    faceScanProgress,
    isDetectingSingleFace,
    faceModelDownload,
    selectedFaceId,
    setSelectedFaceId,
    isDrawingFace,
    setIsDrawingFace,
    drawStart,
    setDrawStart,
    drawnBox,
    setDrawnBox,
    faceNameInput,
    setFaceNameInput,
    refreshPeople,
    handleDetectFacesSingleOnnx,
    handleBatchScanFacesOnnx,
    handleCancelFaceScan,
    handleSaveFaceAndAutomatch,
    handleBatchAssignPerson,
    handleRenamePerson,
    handleSetPersonHidden,
    handleSetPersonCover,
  };
}
