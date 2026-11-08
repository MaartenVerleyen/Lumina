import { useState, useMemo, useDeferredValue } from "react";
import { SmartFilter, OrientationFilter, SortOption, MediaFilter } from "../../types/lumina";
import { parseSearchQuery } from "../../utils/searchQuery";
import { PeopleExpr } from "../../utils/peopleQuery";

// What the grid shows: quick filters, search box, sorting, timeline range, bursts, people filter, album
export function useFilterState() {
  // People filter: "Anna", "(Anna or Bob) and not Carl" ... (null = everyone). Set from the People tab.
  const [peopleFilter, setPeopleFilter] = useState<PeopleExpr | null>(null);
  const [smartFilter, setSmartFilter] = useState<SmartFilter>("ALL");
  const [orientationFilter, setOrientationFilter] = useState<OrientationFilter>("ALL");
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("ALL");
  const [activeSubfolder, setActiveSubfolder] = useState<string>("ALL");
  const [activeEvent, setActiveEvent] = useState<string>("ALL");
  const [activeTag, setActiveTag] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeAlbumId, setActiveAlbumId] = useState<number | null>(null);
  // A named set of photos ("Just imported", "Highlights · Paris"), shown as a chip; null when not filtering on it
  const [hashFilter, setHashFilter] = useState<{ label: string; hashes: Set<string> } | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>("DATE_DESC");

  // Slide-Out Timeline Slicer State
  const [isTimelineOpen, setIsTimelineOpen] = useState<boolean>(false);
  const [selectedPeriodRange, setSelectedPeriodRange] = useState<[string, string] | null>(null);
  const [dragAnchorDay, setDragAnchorDay] = useState<string | null>(null);
  // Burst Stacking State
  const [showAllBurstVersions, setShowAllBurstVersions] = useState<boolean>(false);
  const [expandedBurstGroups, setExpandedBurstGroups] = useState<Set<number>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  // Typing stays responsive: the (expensive) grid filter catches up with the search box when idle
  const deferredSearchQuery = useDeferredValue(searchQuery);
  // Smart results apply to the current query (or a "similar to" request); while a new query is being
  // embedded, the previous matches stay visible instead of flickering back to the full grid
  // The search box: `key:value` terms (rating:>=4 person:anna ...) plus free text for plain or smart search
  const parsedSearch = useMemo(() => parseSearchQuery(deferredSearchQuery), [deferredSearchQuery]);
  // The grid follows sorting, quick filters and the people filter the same way: the menu or sidebar answers
  // at once, the grid catches up, and `isGridUpdating` shows it is working (a large library takes a moment)
  const gridSortBy = useDeferredValue(sortBy);
  const gridSmartFilter = useDeferredValue(smartFilter);
  const gridPeopleFilter = useDeferredValue(peopleFilter);
  const gridMediaFilter = useDeferredValue(mediaFilter);
  const isGridUpdating =
    gridSortBy !== sortBy || gridSmartFilter !== smartFilter || gridPeopleFilter !== peopleFilter || gridMediaFilter !== mediaFilter;

  return {
    peopleFilter,
    setPeopleFilter,
    smartFilter,
    setSmartFilter,
    orientationFilter,
    setOrientationFilter,
    mediaFilter,
    setMediaFilter,
    activeSubfolder,
    setActiveSubfolder,
    activeEvent,
    setActiveEvent,
    activeTag,
    setActiveTag,
    searchQuery,
    setSearchQuery,
    activeAlbumId,
    setActiveAlbumId,
    hashFilter,
    setHashFilter,
    sortBy,
    setSortBy,
    isTimelineOpen,
    setIsTimelineOpen,
    selectedPeriodRange,
    setSelectedPeriodRange,
    dragAnchorDay,
    setDragAnchorDay,
    showAllBurstVersions,
    setShowAllBurstVersions,
    expandedBurstGroups,
    setExpandedBurstGroups,
    expandedFolders,
    setExpandedFolders,
    parsedSearch,
    gridSortBy,
    gridSmartFilter,
    gridPeopleFilter,
    gridMediaFilter,
    isGridUpdating,
  };
}

export type FilterState = ReturnType<typeof useFilterState>;
