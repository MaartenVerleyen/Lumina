import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PhotoItem, TimelineBucket } from "../../types/lumina";
import { buildFolderTree } from "../../utils/photoHelpers";
import { diskPathOf, RAW_OR_HEIC_NAME } from "../../utils/rawPairs";
import { matchesTerms } from "../../utils/searchQuery";
import { matchesPeopleExpr } from "../../utils/peopleQuery";
import { NAME_COLLATOR, TEXT_COLLATOR, compareStrings, searchTextOf } from "./shared";
import type { Collections } from "./useCollections";
import type { SmartSearch } from "./useSmartSearch";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";

// What the grid shows, derived from the photos and filters: visible photos, counts, bursts, compare set
export function useLibraryView(core: LibraryCore, filters: FilterState, collections: Collections, smart: SmartSearch) {
  const { photos, setPhotos, activeHash, setActiveHash, selectedHashes, setSelectedHashes, selectionAnchorHashRef, activePhoto, viewMode } = core;
  const {
    smartFilter,
    setSmartFilter,
    orientationFilter,
    setOrientationFilter,
    selectedPeriodRange,
    setSelectedPeriodRange,
    peopleFilter,
    setPeopleFilter,
    activeSubfolder,
    setActiveSubfolder,
    activeEvent,
    setActiveEvent,
    activeTag,
    setActiveTag,
    setSearchQuery,
    parsedSearch,
    activeAlbumId,
    setActiveAlbumId,
    sortBy,
    showAllBurstVersions,
    setShowAllBurstVersions,
    expandedBurstGroups,
    setExpandedBurstGroups,
    expandedFolders,
    setExpandedFolders,
  } = filters;
  const { tripOfHash, albumContext, albumSets } = collections;
  const { semanticScores, setSemanticResult } = smart;
  const [isLoupeOpen, setIsLoupeOpen] = useState<boolean>(false);
  // Synchronized Compare Mode State
  const [compareZoom, setCompareZoom] = useState<number>(1);
  const [comparePan, setComparePan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Photos per day for the timeline, counted from the loaded photos so it always matches the grid
  // (the database can still hold rows for files that were deleted outside Lumina)
  const timelineBuckets = useMemo<TimelineBucket[]>(() => {
    const counts = new Map<string, number>();
    for (const p of photos) {
      const day = (p.captured_at || "").slice(0, 10).replace(/:/g, "-");
      if (day.length === 10) counts.set(day, (counts.get(day) || 0) + 1);
    }
    return Array.from(counts, ([period, count]) => ({ period, count })).sort((a, b) =>
      a.period < b.period ? -1 : a.period > b.period ? 1 : 0
    );
  }, [photos]);

  const folderTree = useMemo(() => buildFolderTree(photos), [photos]);
  useEffect(() => {
    if (folderTree.nodes.length > 0 && expandedFolders.size === 0) {
      setExpandedFolders(new Set(folderTree.nodes.map((n) => n.fullPath)));
    }
  }, [folderTree.nodes]);

  const allLibraryTags = useMemo(() => {
    const s = new Set<string>();
    photos.forEach((p) => p.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [photos]);

  const {
    stagedPhotos,
    gpsPhotosCount,
    screenshotPhotosCount,
    picksCount,
    rejectsCount,
    basketCount,
    sharpestInGroup,
    burstGroupCounts,
    totalBurstGroups,
    duplicatePhotosCount,
  } = useMemo(() => {
    const staged: PhotoItem[] = [];
    let gps = 0;
    let screenshots = 0;
    let picks = 0;
    let rejects = 0;
    let basket = 0;
    let dupCount = 0;
    const best = new Map<number, { hash: string; sharpness: number }>();
    const counts = new Map<number, number>();

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (p.staged_target) staged.push(p);
      if (p.latitude != null && p.longitude != null) gps++;
      if (p.tags.includes("screenshot")) screenshots++;
      if (p.flag === "pick") picks++;
      else if (p.flag === "reject") rejects++;
      if (p.in_basket) basket++;

      if (p.duplicate_group && p.subfolder !== "_Trash") {
        dupCount++;
        counts.set(p.duplicate_group, (counts.get(p.duplicate_group) || 0) + 1);
        const cur = best.get(p.duplicate_group);
        if (!cur || p.sharpness > cur.sharpness) {
          best.set(p.duplicate_group, { hash: p.hash, sharpness: p.sharpness });
        }
      }
    }

    return {
      stagedPhotos: staged,
      gpsPhotosCount: gps,
      screenshotPhotosCount: screenshots,
      picksCount: picks,
      rejectsCount: rejects,
      basketCount: basket,
      sharpestInGroup: best,
      burstGroupCounts: counts,
      totalBurstGroups: counts.size,
      duplicatePhotosCount: dupCount,
    };
  }, [photos]);

  const visiblePhotos = useMemo(() => {
    const q = semanticScores ? "" : parsedSearch.text.toLowerCase();
    const terms = parsedSearch.terms;
    const albumFilter = activeAlbumId !== null ? albumSets.get(activeAlbumId) ?? new Set<string>() : null;
    const filtered = photos.filter((p) => {
      if (smartFilter === "PICKS" && p.flag !== "pick") return false;
      if (smartFilter === "REJECTS" && p.flag !== "reject") return false;
      if (smartFilter === "BASKET" && !p.in_basket) return false;
      if (smartFilter === "FAVORITES" && p.rating < 4) return false;
      if (smartFilter === "UNTAGGED" && (p.tags.length > 0 || p.ai_caption.length > 0)) return false;
      if (smartFilter === "AI_TAGGED" && p.tags.length === 0 && !p.ai_caption) return false;
      if (smartFilter === "SCREENSHOTS" && !p.tags.includes("screenshot")) return false;
      if (smartFilter === "DUPLICATES" && (!p.duplicate_group || p.subfolder === "_Trash"))
        return false;
      if (smartFilter === "HAS_OCR" && !p.ocr_text) return false;
      if (smartFilter === "HAS_GPS" && (p.latitude == null || p.longitude == null)) return false;
      if (smartFilter === "STAGED" && !p.staged_target) return false;

      if (selectedPeriodRange) {
        const [startDay, endDay] = selectedPeriodRange;
        const pDay = p.captured_at ? p.captured_at.slice(0, 10).replace(/:/g, "-") : "";
        if (!pDay || pDay < startDay || pDay > endDay) return false;
      }

      if (orientationFilter !== "ALL") {
        const swapped = p.rotation === 90 || p.rotation === 270;
        const effW = swapped ? p.height : p.width;
        const effH = swapped ? p.width : p.height;
        if (effW > 0 && effH > 0) {
          const isSquare = Math.abs(effW - effH) / Math.max(effW, effH) <= 0.05;
          if (orientationFilter === "SQUARE" && !isSquare) return false;
          if (orientationFilter === "PORTRAIT" && (isSquare || effH <= effW)) return false;
          if (orientationFilter === "LANDSCAPE" && (isSquare || effW <= effH)) return false;
        } else {
          if (orientationFilter === "PORTRAIT" && !swapped) return false;
          if (orientationFilter === "LANDSCAPE" && swapped) return false;
          if (orientationFilter === "SQUARE") return false;
        }
      }

      if (peopleFilter && !matchesPeopleExpr(p.people, peopleFilter)) return false;
      if (activeSubfolder !== "ALL") {
        if (activeSubfolder === "Root") {
          if (p.subfolder !== "Root") return false;
        } else {
          if (
            p.subfolder !== activeSubfolder &&
            !p.subfolder.startsWith(activeSubfolder + " / ")
          ) {
            return false;
          }
        }
      }
      if (activeEvent !== "ALL" && tripOfHash.get(p.hash) !== activeEvent) return false;
      if (activeTag !== "ALL" && !p.tags.includes(activeTag)) return false;

      if (q && !searchTextOf(p).includes(q)) return false;
      if (terms.length > 0 && !matchesTerms(p, terms, albumContext)) return false;
      if (albumFilter && !albumFilter.has(p.hash)) return false;
      if (semanticScores && !semanticScores.has(p.hash)) return false;
      return true;
    });

    // Smart search: best match first, every photo shown (no burst stacking)
    if (semanticScores) {
      return filtered.sort((a, b) => (semanticScores.get(b.hash) ?? 0) - (semanticScores.get(a.hash) ?? 0));
    }

    // `filtered` is already a fresh array: sort it in place
    const sorted = filtered.sort((a, b) => {
      if (smartFilter === "DUPLICATES") {
        return (a.duplicate_group || 0) - (b.duplicate_group || 0) || b.sharpness - a.sharpness;
      }
      switch (sortBy) {
        case "NAME_ASC":
          return NAME_COLLATOR.compare(a.name, b.name);
        case "NAME_DESC":
          return NAME_COLLATOR.compare(b.name, a.name);
        case "DATE_DESC":
          return (
            compareStrings(b.captured_at || "", a.captured_at || "") ||
            TEXT_COLLATOR.compare(a.name, b.name)
          );
        case "DATE_ASC":
          return (
            compareStrings(a.captured_at || "9999", b.captured_at || "9999") ||
            TEXT_COLLATOR.compare(a.name, b.name)
          );
        case "SCORE_DESC":
          return b.sharpness - a.sharpness;
        case "SCORE_ASC":
          return a.sharpness - b.sharpness;
        case "RATING_DESC":
          return b.rating - a.rating || b.sharpness - a.sharpness;
        case "TAG_NAME": {
          const tA = a.tags[0] || "zzzz";
          const tB = b.tags[0] || "zzzz";
          return TEXT_COLLATOR.compare(tA, tB) || TEXT_COLLATOR.compare(a.name, b.name);
        }
        case "TAG_COUNT":
          return b.tags.length - a.tags.length || TEXT_COLLATOR.compare(a.name, b.name);
        case "SIZE_DESC":
          return b.size_kb - a.size_kb;
        default:
          return 0;
      }
    });

    if (viewMode === "map") return sorted;

    const groupMembers = new Map<number, PhotoItem[]>();
    for (const p of sorted) {
      if (p.duplicate_group && p.subfolder !== "_Trash") {
        const list = groupMembers.get(p.duplicate_group) || [];
        list.push(p);
        groupMembers.set(p.duplicate_group, list);
      }
    }

    const emittedGroups = new Set<number>();
    const finalDisplay: PhotoItem[] = [];

    for (const p of sorted) {
      const grp = p.duplicate_group;
      if (!grp || p.subfolder === "_Trash") {
        finalDisplay.push(p);
        continue;
      }
      if (emittedGroups.has(grp)) continue;
      emittedGroups.add(grp);

      const members = groupMembers.get(grp) || [p];
      const orderedMembers = [...members].sort((a, b) => b.sharpness - a.sharpness);

      if (showAllBurstVersions || expandedBurstGroups.has(grp)) {
        finalDisplay.push(...orderedMembers);
      } else {
        finalDisplay.push(orderedMembers[0]);
      }
    }

    return finalDisplay;
  }, [
    photos,
    smartFilter,
    orientationFilter,
    selectedPeriodRange,
    peopleFilter,
    activeSubfolder,
    activeEvent,
    tripOfHash,
    activeTag,
    parsedSearch,
    albumContext,
    albumSets,
    activeAlbumId,
    sortBy,
    showAllBurstVersions,
    expandedBurstGroups,
    viewMode,
    semanticScores,
  ]);

  // Photos that qualify for Compare before the 4-photo cap (Compare shows "+N more")
  const compareCandidateCount = useMemo(() => {
    if (selectedHashes.size >= 2) return visiblePhotos.filter((p) => selectedHashes.has(p.hash)).length;
    if (activePhoto?.duplicate_group) {
      return photos.filter(
        (p) => p.duplicate_group === activePhoto.duplicate_group && p.subfolder !== "_Trash"
      ).length;
    }
    return 0;
  }, [selectedHashes, visiblePhotos, activePhoto, photos]);

  const comparePhotos = useMemo(() => {
    if (selectedHashes.size >= 2) {
      return visiblePhotos.filter((p) => selectedHashes.has(p.hash)).slice(0, 4);
    }
    if (activePhoto?.duplicate_group) {
      return photos
        .filter(
          (p) => p.duplicate_group === activePhoto.duplicate_group && p.subfolder !== "_Trash"
        )
        .sort((a, b) => b.sharpness - a.sharpness)
        .slice(0, 4);
    }
    const idx = activeHash ? visiblePhotos.findIndex((p) => p.hash === activeHash) : 0;
    const start = Math.max(0, idx);
    return visiblePhotos.slice(start, start + 2);
  }, [selectedHashes, visiblePhotos, activePhoto, photos, activeHash]);

  // On-Demand 1920px High-Res Preview Generation for RAW & HEIC when viewing in Loupe or Compare
  useEffect(() => {
    if (!isLoupeOpen && viewMode !== "compare") return;
    const candidates = viewMode === "compare" ? comparePhotos : activePhoto ? [activePhoto] : [];
    for (const item of candidates) {
      const isRawOrHeic = RAW_OR_HEIC_NAME.test(item.name);
      if (!isRawOrHeic || item.path.endsWith("_preview.jpg")) continue;
      const rawDiskPath = diskPathOf(item);
      const targetHash = item.hash;
      invoke<string>("ensure_high_res_preview", {
        hash: targetHash,
        sourcePath: rawDiskPath,
      })
        .then((previewPath) => {
          if (previewPath) {
            setPhotos((prev) =>
              prev.map((p) => (p.hash === targetHash ? { ...p, path: previewPath } : p))
            );
          }
        })
        .catch(() => {});
    }
  }, [activePhoto?.hash, activePhoto?.path, comparePhotos, isLoupeOpen, viewMode]);

  function handlePhotoClick(index: number, hash: string, e: React.MouseEvent) {
    setActiveHash(hash);
    // The anchor is a photo, not an index: after filtering/sorting the old index would point elsewhere
    const anchorIdx = selectionAnchorHashRef.current
      ? visiblePhotos.findIndex((p) => p.hash === selectionAnchorHashRef.current)
      : -1;
    if (e.shiftKey && anchorIdx !== -1) {
      const start = Math.min(anchorIdx, index);
      const end = Math.max(anchorIdx, index);
      const next = new Set(selectedHashes);
      for (let i = start; i <= end; i++) next.add(visiblePhotos[i].hash);
      setSelectedHashes(next);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedHashes);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      setSelectedHashes(next);
      selectionAnchorHashRef.current = hash;
    } else {
      setSelectedHashes(new Set([hash]));
      selectionAnchorHashRef.current = hash;
    }
  }

  // Empty-grid "Clear all filters": back to the whole library
  function clearAllFilters() {
    setSmartFilter("ALL");
    setOrientationFilter("ALL");
    setActiveSubfolder("ALL");
    setActiveEvent("ALL");
    setActiveTag("ALL");
    setSearchQuery("");
    setPeopleFilter(null);
    setSelectedPeriodRange(null);
    setSemanticResult(null);
    setActiveAlbumId(null);
  }

  function toggleBurstGroupExpand(groupNum: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (showAllBurstVersions) {
      setShowAllBurstVersions(false);
      return;
    }
    setExpandedBurstGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupNum)) next.delete(groupNum);
      else next.add(groupNum);
      return next;
    });
  }

  return {
    isLoupeOpen,
    setIsLoupeOpen,
    compareZoom,
    setCompareZoom,
    comparePan,
    setComparePan,
    timelineBuckets,
    folderTree,
    allLibraryTags,
    stagedPhotos,
    gpsPhotosCount,
    screenshotPhotosCount,
    picksCount,
    rejectsCount,
    basketCount,
    sharpestInGroup,
    burstGroupCounts,
    totalBurstGroups,
    duplicatePhotosCount,
    visiblePhotos,
    compareCandidateCount,
    comparePhotos,
    handlePhotoClick,
    clearAllFilters,
    toggleBurstGroupExpand,
  };
}

export type LibraryView = ReturnType<typeof useLibraryView>;
