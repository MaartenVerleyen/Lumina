import { useEffect, useRef, useState } from "react";
import { ArrowUpDown, Calendar, Check, ChevronDown, Columns, FilterX, Folder, FolderSync, Layers, SlidersHorizontal, Trophy, X } from "lucide-react";
import type { LibraryState } from "../../hooks/useLibraryState";
import { AutoStagePreset, OrientationFilter, SortOption } from "../../types/lumina";

const SORTS: { value: SortOption; label: string; pro?: boolean }[] = [
  { value: "DATE_DESC", label: "Date captured (newest)" },
  { value: "DATE_ASC", label: "Date captured (oldest)" },
  { value: "NAME_ASC", label: "Name (A → Z)" },
  { value: "NAME_DESC", label: "Name (Z → A)" },
  { value: "RATING_DESC", label: "Rating (high → low)" },
  { value: "SCORE_DESC", label: "Focus (sharpest)", pro: true },
  { value: "SCORE_ASC", label: "Focus (blurriest)", pro: true },
  { value: "TAG_NAME", label: "First tag (A → Z)" },
  { value: "SIZE_DESC", label: "File size (largest)" },
];

const ORIENTATIONS: { value: OrientationFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "LANDSCAPE", label: "Wide" },
  { value: "PORTRAIT", label: "Tall" },
  { value: "SQUARE", label: "Square" },
];

const RULES: { value: AutoStagePreset; simple: string; pro: string }[] = [
  { value: "YEAR_MONTH_CITY", simple: "By year / month & city", pro: "{Year}/{YYYY-MM}_{City}" },
  { value: "YEAR_MONTH", simple: "By year / month", pro: "{Year}/{YYYY-MM}" },
  { value: "PERSON_YEAR", simple: "By person / year", pro: "People/{Person}/{Year}" },
  { value: "SCREENSHOTS_BY_MONTH", simple: "Screenshots by month", pro: "_Screenshots/{YYYY-MM}" },
  { value: "FAVORITES_YEAR", simple: "Favorites by year", pro: "Favorites/{Year}" },
];

// Small dropdown that closes on an outside click or Escape
function Menu({ label, icon, active, children }: { label: string; icon: React.ReactNode; active?: boolean; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
          active ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" : "bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-800"
        }`}
      >
        {icon}
        <span>{label}</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-64 bg-raised border border-zinc-700/80 rounded-xl shadow-2xl p-1.5 z-50 text-xs flex flex-col gap-0.5">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const sectionLabel = "px-2 pt-1.5 pb-1 text-[11px] font-bold text-zinc-500 uppercase tracking-wider";
const itemClass = (selected: boolean) =>
  `w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left ${selected ? "bg-emerald-500/15 text-emerald-200" : "text-zinc-300 hover:bg-zinc-800"}`;

// A name for what the grid shows, for titles like "Highlights · Paris"
export function scopeTitle(lib: LibraryState): string {
  if (lib.hashFilter) return lib.hashFilter.label;
  if (lib.activeAlbumId !== null) return lib.albums.find((a) => a.id === lib.activeAlbumId)?.name ?? "Album";
  if (lib.activeEvent !== "ALL") return lib.autoEvents.find((e) => e.id === lib.activeEvent)?.label ?? "Trip";
  if (lib.activeSubfolder !== "ALL") return lib.activeSubfolder.split(" / ").pop() || lib.activeSubfolder;
  if (lib.searchQuery.trim()) return `"${lib.searchQuery.trim()}"`;
  return lib.folder.split(/[\\/]/).filter(Boolean).pop() || "All photos";
}

// The bar above the photo grid: Timeline, bursts, Compare, Highlights and two menus (View, Organize)
export default function PhotoToolbar({ lib }: { lib: LibraryState }) {
  const viewChanged = lib.orientationFilter !== "ALL" || !lib.autoAdvance;
  // The filters clearAllFilters resets
  const activeFilterCount = [
    lib.smartFilter !== "ALL",
    lib.orientationFilter !== "ALL",
    lib.searchQuery.trim() !== "" || lib.semanticScores !== null,
    lib.activeSubfolder !== "ALL",
    lib.activeEvent !== "ALL",
    lib.activeTag !== "ALL",
    lib.activeAlbumId !== null,
    lib.peopleFilter !== null,
    lib.hashFilter !== null,
    lib.selectedPeriodRange !== null,
  ].filter(Boolean).length;
  return (
    <div className="bg-panel border-b border-zinc-800/60 px-4 py-1.5 flex items-center justify-between text-xs gap-3 flex-wrap shrink-0">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => lib.setIsTimelineOpen((p) => !p)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
            lib.isTimelineOpen || lib.selectedPeriodRange
              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
              : "bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-800"
          }`}
          title="Day-by-day timeline: drag to pick a date range"
        >
          <Calendar className="w-3.5 h-3.5 text-emerald-400" />
          <span>
            {lib.selectedPeriodRange
              ? `${lib.selectedPeriodRange[0]} ➔ ${lib.selectedPeriodRange[1]}`
              : lib.simpleMode
              ? "Filter by Date"
              : "Timeline"}
          </span>
          {lib.selectedPeriodRange && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                lib.setSelectedPeriodRange(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  lib.setSelectedPeriodRange(null);
                }
              }}
              className="-mr-1 p-0.5 rounded hover:bg-emerald-500/25 hover:text-white"
              aria-label="Clear the date filter"
              title="Clear the date filter"
            >
              <X className="w-3 h-3" />
            </span>
          )}
        </button>

        {lib.totalBurstGroups > 0 && (
          <button
            onClick={() => lib.setShowAllBurstVersions((prev) => !prev)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
              lib.showAllBurstVersions
                ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                : "bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border-zinc-800"
            }`}
            title="Expand or collapse all burst / duplicate stacks"
          >
            <Layers className="w-3.5 h-3.5 text-amber-400" />
            <span>{lib.showAllBurstVersions ? "Collapse Bursts" : lib.simpleMode ? "Show Similar Shots" : "Show All Bursts"}</span>
          </button>
        )}

        <button
          onClick={() => {
            lib.setCompareZoom(1);
            lib.setComparePan({ x: 0, y: 0 });
            lib.setViewMode((v) => (v === "compare" ? "grid" : "compare"));
          }}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
            lib.viewMode === "compare"
              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
              : "bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-800"
          }`}
          title="Compare the selected photos side by side (C)"
        >
          <Columns className="w-3.5 h-3.5" />
          <span>{lib.viewMode === "compare" ? "Exit Compare" : "Compare"}</span>
        </button>

        <button
          onClick={() => lib.openHighlights(scopeTitle(lib), lib.visiblePhotos)}
          disabled={lib.visiblePhotos.length < 2}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-800 disabled:opacity-40"
          title="The best photos of what is shown: sharp, eyes open, your favourites, and varied"
        >
          <Trophy className="w-3.5 h-3.5 text-amber-400" />
          <span>Highlights</span>
        </button>

        {lib.activeSubfolder !== "ALL" && (
          <span className="bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 px-2.5 py-0.5 rounded-full flex items-center gap-1.5 text-[11px]">
            <Folder className="w-3 h-3 text-emerald-400" />
            <span>{lib.activeSubfolder}</span>
            <button onClick={() => lib.setActiveSubfolder("ALL")} className="hover:text-white ml-0.5" aria-label="Show all folders">
              <X className="w-3 h-3" />
            </button>
          </span>
        )}

        {activeFilterCount > 0 && (
          <button
            onClick={lib.clearAllFilters}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition bg-zinc-900 hover:bg-red-950/50 text-zinc-300 hover:text-red-200 border-zinc-800 hover:border-red-500/40"
            title="Show all photos again: clears the date, folder, people, search, album and other filters"
          >
            <FilterX className="w-3.5 h-3.5" />
            <span>Clear all filters ({activeFilterCount})</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Menu label="View" icon={<SlidersHorizontal className="w-3.5 h-3.5 text-emerald-400" />} active={viewChanged}>
          {(close) => (
            <>
              <span className={sectionLabel}>Sort by</span>
              {SORTS.filter((o) => !o.pro || !lib.simpleMode).map((o) => (
                <button
                  key={o.value}
                  onClick={() => {
                    lib.setSortBy(o.value);
                    close();
                  }}
                  className={itemClass(lib.sortBy === o.value)}
                >
                  <span className="flex items-center gap-2">
                    <ArrowUpDown className="w-3 h-3 text-zinc-500" />
                    {o.label}
                  </span>
                  {lib.sortBy === o.value && <Check className="w-3.5 h-3.5" />}
                </button>
              ))}
              <span className={sectionLabel}>Shape</span>
              <div className="flex gap-1 px-1.5 pb-1">
                {ORIENTATIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => lib.setOrientationFilter(o.value)}
                    className={`flex-1 px-2 py-1 rounded-md border text-[11px] ${
                      lib.orientationFilter === o.value
                        ? "bg-emerald-500/15 text-emerald-200 border-emerald-500/40"
                        : "text-zinc-400 border-zinc-800 hover:bg-zinc-800"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <label className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-300 cursor-pointer">
                <span>
                  Auto-advance
                  <span className="block text-[11px] text-zinc-500">Move to the next photo after P, X or a rating</span>
                </span>
                <input
                  type="checkbox"
                  checked={lib.autoAdvance}
                  onChange={(e) => lib.setAutoAdvance(e.target.checked)}
                  className="accent-emerald-500"
                />
              </label>
            </>
          )}
        </Menu>

        <Menu label="Organize" icon={<FolderSync className="w-3.5 h-3.5 text-indigo-400" />}>
          {(close) => (
            <>
              <span className={sectionLabel}>Folder rule for Auto-Stage</span>
              {RULES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => lib.setAutoStagePreset(r.value)}
                  className={itemClass(lib.autoStagePreset === r.value)}
                >
                  <span className={lib.simpleMode ? "" : "font-mono text-[11px]"}>{lib.simpleMode ? r.simple : r.pro}</span>
                  {lib.autoStagePreset === r.value && <Check className="w-3.5 h-3.5" />}
                </button>
              ))}
              <button
                onClick={() => {
                  close();
                  lib.handleAutoOrganizeByPreset();
                }}
                className="mt-1 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium"
              >
                <FolderSync className="w-3.5 h-3.5" />
                {lib.simpleMode ? "Auto-sort visible photos" : "Auto-stage visible photos"}
              </button>
              {lib.totalBurstGroups > 0 && (
                <button
                  onClick={() => {
                    close();
                    lib.handleKeepSharpestInAllGroups();
                  }}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                >
                  <Trophy className="w-3.5 h-3.5 text-amber-400" />
                  Keep the best of each burst
                </button>
              )}
            </>
          )}
        </Menu>
      </div>
    </div>
  );
}
