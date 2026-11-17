import { useState, useEffect, useRef } from "react";
import { timedAsync } from "../../api/timings";
import { useAccess } from "../../components/auth/ServerGate";
import { ALL_PHOTOS, ALL_PHOTOS_LOADED, allPhotosSources, call, callLocal, isOwnChange, localJobRoots, openLibraryIsAll, RECONNECTED, subscribe } from "../../api";
import { PhotoItem, PersonItem, FaceScanProgress, FaceMatchEvent, FaceInstance, FaceModelDownloadProgress, FaceQualityProgress } from "../../types/lumina";
import { diskPathOf } from "../../utils/rawPairs";
import { isLiveClip, isVideo } from "../../utils/media";

export type FaceScanScope = "all" | "photos" | "videos" | "visible";
import { removeFromExpr, renameInExpr } from "../../utils/peopleQuery";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";
import { plural } from "../../utils/plural";

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
  const access = useAccess();
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
    const unlisten = subscribe<FaceModelDownloadProgress>("face-model-download", (event) => {
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

  const pendingAskRef = useRef(0);
  async function refreshPeople(currentFolder = folder, skipPendingScan = false) {
    try {
      // 1. Immediately load & render the Top People Carousel (<2ms) without waiting on biometric matching!
      const res = await timedAsync("people: list", () => call<PersonItem[]>("get_people", { rootFolder: currentFolder || null }));
      // The same list again keeps its identity, so what is drawn from it (centroids, counts) isn't asked again
      setPeople((prev) => (JSON.stringify(prev) === JSON.stringify(res) ? prev : res));

      // 2. Asynchronously compute & cache pending face match counts in the background (suggestions are for
      // those who may accept them). All photos tells itself whether anything may be changed: right after it
      // loads, the window hasn't drawn the new rights yet.
      const mayEdit = openLibraryIsAll() ? [...allPhotosSources().values()].some((s) => s.editable) : access.edit;
      if (!skipPendingScan && mayEdit) {
        // Only the latest ask may set the badges: an older one can answer later, from before changes made since
        const asked = ++pendingAskRef.current;
        timedAsync("people: faces to check", () => call<Record<string, number>>("get_pending_face_match_counts", { rootFolder: currentFolder || null }))
          .then((pending) => {
            if (asked === pendingAskRef.current) setPendingFaceCounts(pending || {});
          })
          .catch(() => {});
      }
    } catch {}
  }

  // Another user named, renamed, hid or merged people on the server
  const refreshPeopleRef = useRef(refreshPeople);
  refreshPeopleRef.current = refreshPeople;
  useEffect(() => {
    const off = subscribe<{ origin?: string }>("people-changed", (e) => {
      if (!isOwnChange(e.payload)) refreshPeopleRef.current();
    });
    // Or did while the event socket was down
    const offReconnected = subscribe(RECONNECTED, () => refreshPeopleRef.current());
    // All photos listed its libraries again (an account changed on one of its servers, say)
    const allLoaded = () => {
      if (openLibraryIsAll()) refreshPeopleRef.current();
    };
    window.addEventListener(ALL_PHOTOS_LOADED, allLoaded);
    return () => {
      off.then((f) => f());
      offReconnected.then((f) => f());
      window.removeEventListener(ALL_PHOTOS_LOADED, allLoaded);
    };
  }, []);

  // After accepting or denying suggestions: the badge counts follow at once, without recomputing every match
  function reducePendingCount(person: string, by: number) {
    setPendingFaceCounts((prev) => {
      const key = Object.keys(prev).find((k) => k.toLowerCase() === person.toLowerCase());
      return key ? { ...prev, [key]: Math.max(0, prev[key] - by) } : prev;
    });
  }

  // Debounced: opening a folder changes `folder` and then `photos.length`, which used to run the
  // (expensive) face-match count twice back to back. All photos asks again when it has loaded (ALL_PHOTOS_LOADED),
  // not at every change in its count while a server indexes.
  const countTrigger = folder === ALL_PHOTOS ? 0 : photos.length;
  useEffect(() => {
    const timer = setTimeout(() => {
      refreshPeople(folder);
    }, 400);
    return () => clearTimeout(timer);
  }, [countTrigger, folder]);

  useEffect(() => {
    const unlisten = subscribe<FaceMatchEvent>("face-automatch-complete", (event) => {
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
        addLog("FACE", `Auto-matched "${person_name}" across ${plural(total_matched, "photo")}`);
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
    const unlisten = subscribe<FaceScanProgress>("face-scan-progress", (event) => {
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
        // A server's own scan (after an upload, say) isn't one this window started: no notice for it
        const ours = !event.server && localJobRoots().length > 0;
        refreshPeople(folder, false).then(() => {
          if (!ours) return;
          setAutoMatchNotice(
            `Face scan done: ${plural(prog.faces_found, "face")} found`
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
    if (!activePhoto || isVideo(activePhoto) || isDetectingSingleFace) return;
    try {
      setIsDetectingSingleFace(true);
      const detected = await call<FaceInstance[]>("detect_faces_in_photo", {
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
      addLog("FACE", `Detected ${plural(detected.length, "face")} in ${activePhoto.name}`);
      setAutoMatchNotice(
        detected.length > 0
          ? `Found ${plural(detected.length, "face")} in ${activePhoto.name}`
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
  // `onThisPc`: photos of this PC's libraries by their ids here (All photos' background upgrade), for this PC's engine
  async function startFaceScan(hashes: string[], logMessage: string, onThisPc = false) {
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
      await (onThisPc ? callLocal : call)<number>("scan_library_faces_batch", { hashes });
    } catch (err) {
      setFaceScanProgress(null);
      setFaceModelDownload(null);
      setError(String(err));
    }
  }

  // Scan Faces over everything, only photos, only videos, or what the grid shows (`visible`). Videos are
  // scanned on their stored frames, each person once; a Live Photo's clip is left to its photo.
  async function handleBatchScanFacesOnnx(scope: FaceScanScope = "all", visible: PhotoItem[] = []) {
    const pool = (scope === "visible" ? visible : photos).filter((p) => !isLiveClip(p));
    const targets = scope === "photos" ? pool.filter((p) => !isVideo(p)) : scope === "videos" ? pool.filter(isVideo) : pool;
    if (targets.length === 0) {
      setAutoMatchNotice(scope === "videos" ? "There are no videos to scan." : "There is nothing to scan.");
      return;
    }
    const videos = targets.filter(isVideo).length;
    const stills = targets.length - videos;
    const what = [stills ? `${stills} photos` : "", videos ? `${videos} videos` : ""].filter(Boolean).join(" and ");
    await startFaceScan(
      targets.map((p) => p.hash),
      `Started face scan on ${what}${scope === "visible" ? " (visible)" : ""}`
    );
  }

  // Face engine upgrade: photos whose faces came from the previous engine are re-scanned automatically once
  // per opened folder (confirmed names and rejections carry over; the old embeddings can't be matched). In
  // All photos that is every folder on this PC in the view; a server upgrades its own.
  const faceScanProgressRef = useRef(faceScanProgress);
  faceScanProgressRef.current = faceScanProgress;
  const hasPhotos = photos.length > 0;
  const faceUpgradeCheckedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!folder || !hasPhotos) return;
    const timer = setTimeout(async () => {
      if (faceScanProgressRef.current) return;
      const roots = localJobRoots().filter((r) => !faceUpgradeCheckedRef.current.has(r));
      if (roots.length === 0) return;
      for (const r of roots) faceUpgradeCheckedRef.current.add(r);
      try {
        const lists = await Promise.all(roots.map((rootFolder) => callLocal<string[]>("get_outdated_face_photos", { rootFolder })));
        const outdated = [...new Set(lists.flat())];
        if (outdated.length > 0) {
          await startFaceScan(
            outdated,
            `Upgrading faces in ${plural(outdated.length, "photo")} to the new face engine (names and rejections are kept)`,
            true
          );
        }
      } catch {}
    }, 1500);
    return () => clearTimeout(timer);
  }, [folder, hasPhotos]);

  // Eyes and focus: faces found before Lumina measured them are measured in the background, once per opened
  // folder (also picks up closed eyes once the smart search models that judge them are installed). The engine
  // measures one library at a time, so All photos' folders on this PC wait in a queue.
  const qualityQueueRef = useRef<string[]>([]);
  // A measuring pass is running: the engine would turn the next library down, so it waits its turn
  const qualityRunningRef = useRef(false);
  const [faceQualityProgress, setFaceQualityProgress] = useState<{ completed: number; total: number } | null>(null);
  useEffect(() => {
    const unlisten = subscribe<FaceQualityProgress>("face-quality-progress", (event) => {
      const { batch, done, completed, total } = event.payload;
      setPhotos((prev) => prev.map((p) => (p.hash in batch ? { ...p, faces: batch[p.hash] } : p)));
      setFaceQualityProgress(done ? null : { completed, total });
      if (done) {
        addLog("FACE", `Checked eyes and focus in ${plural(total, "photo")}`);
        qualityRunningRef.current = false;
        void measureNextQuality();
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog]);

  // The next library in the queue with faces to measure (one with none is passed over)
  async function measureNextQuality() {
    for (let root = qualityQueueRef.current.shift(); root; root = qualityQueueRef.current.shift()) {
      try {
        const total = await callLocal<number>("measure_face_quality", { rootFolder: root });
        if (total > 0) {
          qualityRunningRef.current = true;
          setFaceQualityProgress({ completed: 0, total });
          return;
        }
      } catch {}
    }
  }

  async function measureFaceQuality(roots = localJobRoots()) {
    const queued = new Set(qualityQueueRef.current);
    qualityQueueRef.current.push(...roots.filter((r) => !queued.has(r)));
    if (!qualityRunningRef.current) await measureNextQuality();
  }

  const qualityCheckedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!folder || !hasPhotos) return;
    const timer = setTimeout(() => {
      if (faceScanProgressRef.current) return;
      const roots = localJobRoots().filter((r) => !qualityCheckedRef.current.has(r));
      if (roots.length === 0) return;
      for (const r of roots) qualityCheckedRef.current.add(r);
      void measureFaceQuality(roots);
    }, 4000);
    return () => clearTimeout(timer);
  }, [folder, hasPhotos]);

  async function handleCancelFaceScan() {
    try {
      await call("cancel_face_scan");
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
      const updatedFaces = await call<FaceInstance[]>("assign_face_region_and_automatch", {
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

  // A named face on the shown photo loses its name and stays a face; an unnamed one isn't a face: its box goes.
  // Used by the side panel's face chips and the Loupe's face boxes.
  async function handleClearFace(faceId: string) {
    const photo = activePhoto;
    const face = photo?.faces.find((f) => f.face_id === faceId);
    if (!photo || !face) return;
    try {
      const removedPerson = face.person_name;
      const rem = removedPerson
        ? (
            await call<Record<string, FaceInstance[]>>("unassign_faces_batch", {
              faceIds: [faceId],
              personName: removedPerson,
            })
          )[photo.hash] ?? photo.faces.map((x) => (x.face_id === faceId ? { ...x, person_name: null } : x))
        : await call<FaceInstance[]>("remove_face_box", { faceId, hash: photo.hash });
      const remainingNames = new Set(rem.map((x) => x.person_name?.trim().toLowerCase()).filter(Boolean));
      setPhotos((prev) =>
        prev.map((p) => {
          if (p.hash !== photo.hash) return p;
          const nextPeople = removedPerson
            ? p.people.filter((pe) => pe.toLowerCase() !== removedPerson.toLowerCase() || remainingNames.has(pe.toLowerCase()))
            : p.people;
          return { ...p, faces: rem, people: nextPeople };
        })
      );
      if (selectedFaceId === faceId) {
        // An unnamed face stays chosen, ready for another name
        setSelectedFaceId(removedPerson ? faceId : rem[0]?.face_id ?? null);
        setFaceNameInput(removedPerson ? "" : rem[0]?.person_name || "");
      }
      addLog("FACE", removedPerson ? `Removed the name "${removedPerson}" from a face on ${photo.name}` : `Removed a face box on ${photo.name}`);
      await refreshPeople();
    } catch (err) {
      setError(String(err));
    }
  }

  // Returns whether the person was added
  async function handleBatchAssignPerson(personName: string, targetHashes?: string[]): Promise<boolean> {
    const clean = personName.trim();
    const hashes = resolveTargets(targetHashes);
    if (!clean || hashes.length === 0) return false;
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
      await call<number>("add_person_to_photos", { hashes, name: clean });
      applyPerson(true);
      if (added.length > 0) {
        pushCustomUndo(
          `Person "${clean}" on ${plural(added.length, "photo")}`,
          hashes,
          async () => {
            await call("remove_person_from_photos", { hashes: added, name: clean });
            applyPerson(false);
            refreshPeople();
          },
          async () => {
            await call<number>("add_person_to_photos", { hashes: added, name: clean });
            applyPerson(true);
            refreshPeople();
          }
        );
      }
      addLog("FACE", `Assigned person "${clean}" to ${plural(hashes.length, "selected photo", "selected photos")}`);
      setBulkInput("");
      setActiveBulkPopover(null);
      refreshPeople();
      return true;
    } catch (err) {
      setError(String(err));
      return false;
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
        "Merge",
        { title: "Merge people" }
      );
      if (!ok) return null;
    }
    try {
      const finalName = await call<string>("rename_person", { oldName, newName: target });
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
      await call("set_person_hidden", { name, hidden });
      if (hidden) setPeopleFilter((prev) => removeFromExpr(prev, name));
      addLog("FACE", `${hidden ? "Hid" : "Unhid"} "${name}"`);
      await refreshPeople();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSetPersonStarred(name: string, starred: boolean) {
    try {
      await call("set_person_starred", { name, starred });
      setPeople((prev) => prev.map((p) => (p.name === name ? { ...p, starred } : p)));
      addLog("FACE", `${starred ? "Starred" : "Unstarred"} "${name}"`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSetPersonCover(name: string, faceId: string) {
    try {
      await call("set_person_cover", { name, faceId });
      addLog("FACE", `New profile picture for "${name}"`);
      await refreshPeople(undefined, true);
    } catch (err) {
      setError(String(err));
    }
  }

  return {
    people,
    pendingFaceCounts,
    reducePendingCount,
    faceReviewPerson,
    setFaceReviewPerson,
    faceScanProgress,
    faceQualityProgress,
    measureFaceQuality,
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
    handleClearFace,
    handleBatchAssignPerson,
    handleRenamePerson,
    handleSetPersonHidden,
    handleSetPersonStarred,
    handleSetPersonCover,
  };
}
