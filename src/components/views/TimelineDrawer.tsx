import { useMemo, useState } from "react";
import { TimelineBucket } from "../../types/lumina";
import { Calendar, RotateCcw, SlidersHorizontal, ZoomOut } from "lucide-react";

interface TimelineDrawerProps {
  timelineBuckets: TimelineBucket[];
  selectedPeriodRange: [string, string] | null;
  setSelectedPeriodRange: React.Dispatch<React.SetStateAction<[string, string] | null>>;
  dragAnchorDay?: string | null;
  setDragAnchorDay?: React.Dispatch<React.SetStateAction<string | null>>;
  setIsTimelineOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

type ScaleLevel = "YEAR" | "MONTH" | "WEEK" | "DAY";

interface AggregatedBucket {
  key: string;
  label: string;
  subLabel?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  count: number;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parseIsoDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y || 2000, (m || 1) - 1, d || 1);
}

function formatIsoDate(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetween(startStr: string, endStr: string): number {
  const d1 = parseIsoDate(startStr);
  const d2 = parseIsoDate(endStr);
  return Math.max(1, Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1);
}

function lastDayOfMonth(year: number, month1To12: number): string {
  const dt = new Date(year, month1To12, 0);
  return formatIsoDate(dt);
}

function getMondayOfWeek(dt: Date): Date {
  const copy = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const day = copy.getDay();
  const diff = copy.getDate() - day + (day === 0 ? -6 : 1);
  copy.setDate(diff);
  return copy;
}

export default function TimelineDrawer({
  timelineBuckets,
  selectedPeriodRange,
  setSelectedPeriodRange,
  setIsTimelineOpen,
}: TimelineDrawerProps) {
  const [dragAnchorBucket, setDragAnchorBucket] = useState<AggregatedBucket | null>(null);
  const [hoverBucket, setHoverBucket] = useState<AggregatedBucket | null>(null);

  // Determine the active scale automatically from the selected date span
  const activeScale: ScaleLevel = useMemo(() => {
    if (!selectedPeriodRange) {
      if (timelineBuckets.length === 0) return "YEAR";
      const totalSpan = daysBetween(
        timelineBuckets[0].period,
        timelineBuckets[timelineBuckets.length - 1].period
      );
      if (totalSpan > 730) return "YEAR";
      if (totalSpan > 155) return "MONTH";
      if (totalSpan > 35) return "WEEK";
      return "DAY";
    }
    const spanDays = daysBetween(selectedPeriodRange[0], selectedPeriodRange[1]);
    if (spanDays > 735) return "YEAR";   // > 2 years -> Year bars
    if (spanDays > 155) return "MONTH";  // 6..24 months -> Month bars
    if (spanDays > 35) return "WEEK";    // 5 weeks..5 months -> Week bars
    return "DAY";                        // <= 35 days -> Day bars
  }, [selectedPeriodRange, timelineBuckets]);

  // Build continuous buckets for the current scale & date window
  const displayBuckets: AggregatedBucket[] = useMemo(() => {
    if (timelineBuckets.length === 0) return [];

    let minDay = selectedPeriodRange ? selectedPeriodRange[0] : timelineBuckets[0].period;
    let maxDay = selectedPeriodRange
      ? selectedPeriodRange[1]
      : timelineBuckets[timelineBuckets.length - 1].period;

    // When zoomed into the DAY scale on a single day or narrow range (< 14 days),
    // keep the full surrounding month visible so you can click between days freely!
    if (activeScale === "DAY" && selectedPeriodRange) {
      const span = daysBetween(minDay, maxDay);
      if (span < 14) {
        const yr = Number(minDay.slice(0, 4));
        const mo = Number(minDay.slice(5, 7));
        const endYr = Number(maxDay.slice(0, 4));
        const endMo = Number(maxDay.slice(5, 7));
        minDay = `${yr}-${String(mo).padStart(2, "0")}-01`;
        maxDay = lastDayOfMonth(endYr, endMo);
      }
    }

    const scopedDaily = timelineBuckets.filter(
      (b) => b.period >= minDay && b.period <= maxDay
    );

    if (activeScale === "YEAR") {
      const startY = Number(minDay.slice(0, 4));
      const endY = Number(maxDay.slice(0, 4));
      const map = new Map<number, number>();
      for (let y = startY; y <= endY; y++) map.set(y, 0);
      for (const b of scopedDaily) {
        const y = Number(b.period.slice(0, 4));
        map.set(y, (map.get(y) || 0) + b.count);
      }
      return Array.from(map.entries()).map(([yr, count]) => ({
        key: String(yr),
        label: String(yr),
        startDate: `${yr}-01-01`,
        endDate: `${yr}-12-31`,
        count,
      }));
    }

    if (activeScale === "MONTH") {
      const startY = Number(minDay.slice(0, 4));
      const startM = Number(minDay.slice(5, 7));
      const endY = Number(maxDay.slice(0, 4));
      const endM = Number(maxDay.slice(5, 7));

      const map = new Map<string, number>();
      let curY = startY;
      let curM = startM;
      while (curY < endY || (curY === endY && curM <= endM)) {
        const ym = `${curY}-${String(curM).padStart(2, "0")}`;
        map.set(ym, 0);
        curM++;
        if (curM > 12) {
          curM = 1;
          curY++;
        }
      }
      for (const b of scopedDaily) {
        const ym = b.period.slice(0, 7);
        if (map.has(ym)) {
          map.set(ym, (map.get(ym) || 0) + b.count);
        }
      }
      return Array.from(map.entries()).map(([ym, count]) => {
        const yr = Number(ym.slice(0, 4));
        const mo = Number(ym.slice(5, 7));
        return {
          key: ym,
          label: MONTH_NAMES[mo - 1] || ym,
          subLabel: `'${String(yr).slice(2)}`,
          startDate: `${ym}-01`,
          endDate: lastDayOfMonth(yr, mo),
          count,
        };
      });
    }

    if (activeScale === "WEEK") {
      const firstMonday = getMondayOfWeek(parseIsoDate(minDay));
      const lastDate = parseIsoDate(maxDay);
      const buckets: AggregatedBucket[] = [];
      const cur = new Date(firstMonday);

      while (cur <= lastDate) {
        const wStart = new Date(cur);
        const wEnd = new Date(cur);
        wEnd.setDate(wEnd.getDate() + 6);
        const sStr = formatIsoDate(wStart);
        const eStr = formatIsoDate(wEnd);
        buckets.push({
          key: sStr,
          label: `${MONTH_NAMES[wStart.getMonth()]} ${wStart.getDate()}`,
          subLabel: `–${wEnd.getDate()}`,
          startDate: sStr < minDay ? minDay : sStr,
          endDate: eStr > maxDay ? maxDay : eStr,
          count: 0,
        });
        cur.setDate(cur.getDate() + 7);
      }

      for (const b of scopedDaily) {
        for (const wb of buckets) {
          if (b.period >= wb.startDate && b.period <= wb.endDate) {
            wb.count += b.count;
            break;
          }
        }
      }
      return buckets;
    }

    // DAY level (<= 35 days)
    const buckets: AggregatedBucket[] = [];
    const cur = parseIsoDate(minDay);
    const end = parseIsoDate(maxDay);
    const dailyMap = new Map(scopedDaily.map((b) => [b.period, b.count]));

    while (cur <= end) {
      const dStr = formatIsoDate(cur);
      buckets.push({
        key: dStr,
        label: String(cur.getDate()),
        subLabel: MONTH_NAMES[cur.getMonth()],
        startDate: dStr,
        endDate: dStr,
        count: dailyMap.get(dStr) || 0,
      });
      cur.setDate(cur.getDate() + 1);
    }
    return buckets;
  }, [timelineBuckets, selectedPeriodRange, activeScale]);

  function handleZoomOutOneLevel() {
    if (!selectedPeriodRange || timelineBuckets.length === 0) return;
    const [start, end] = selectedPeriodRange;
    if (activeScale === "DAY") {
      const span = daysBetween(start, end);
      if (span < 14) {
        // First step out from a single day/narrow range: select the whole month
        const yr = Number(start.slice(0, 4));
        const mo = Number(start.slice(5, 7));
        setSelectedPeriodRange([
          `${yr}-${String(mo).padStart(2, "0")}-01`,
          lastDayOfMonth(yr, mo),
        ]);
        return;
      }
      // Zoom out from Month Day-view -> 3-Month Week View around current selection
      const dt = parseIsoDate(start);
      const mStart = new Date(dt.getFullYear(), dt.getMonth() - 1, 1);
      const mEnd = new Date(dt.getFullYear(), dt.getMonth() + 2, 0);
      setSelectedPeriodRange([formatIsoDate(mStart), formatIsoDate(mEnd)]);
    } else if (activeScale === "WEEK") {
      // Zoom out from Week -> Full Year Month View
      const yr = start.slice(0, 4);
      const endYr = end.slice(0, 4);
      setSelectedPeriodRange([`${yr}-01-01`, `${endYr}-12-31`]);
    } else {
      // Zoom out to All Years
      setSelectedPeriodRange(null);
    }
  }

  const maxCount = useMemo(
    () => Math.max(...displayBuckets.map((b) => b.count), 1),
    [displayBuckets]
  );

  const totalPhotosInView = useMemo(
    () => displayBuckets.reduce((acc, b) => acc + b.count, 0),
    [displayBuckets]
  );

  return (
    <div
      onMouseUp={() => setDragAnchorBucket(null)}
      onMouseLeave={() => {
        setDragAnchorBucket(null);
        setHoverBucket(null);
      }}
      className="bg-[#0b0d14] border-b border-zinc-800/80 px-5 py-3.5 flex flex-col gap-3 shrink-0 z-10 animate-in slide-in-from-top-2 duration-150 select-none"
    >
      {/* Top Header: Scale Breadcrumbs, Date Inputs & Quick Year Pills */}
      <div className="flex items-center justify-between text-xs flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <SlidersHorizontal className="w-4 h-4 text-emerald-400" />
            <span className="font-bold text-zinc-100 text-xs">Dynamic Timeline</span>
          </div>

          {/* Scale Level Indicator Pills */}
          <div className="flex items-center bg-zinc-900/90 border border-zinc-800 rounded-lg p-0.5 text-[10px] font-semibold">
            {(["YEAR", "MONTH", "WEEK", "DAY"] as ScaleLevel[]).map((lvl, idx) => {
              const active = activeScale === lvl;
              return (
                <div key={lvl} className="flex items-center">
                  {idx > 0 && <span className="text-zinc-700 px-1">›</span>}
                  <span
                    className={`px-2 py-0.5 rounded transition ${
                      active
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                        : "text-zinc-500"
                    }`}
                  >
                    {lvl === "YEAR"
                      ? "Years"
                      : lvl === "MONTH"
                      ? "Months"
                      : lvl === "WEEK"
                      ? "Weeks"
                      : "Days"}
                  </span>
                </div>
              );
            })}
          </div>

          {selectedPeriodRange && (
            <div className="flex items-center gap-1">
              <button
                onClick={handleZoomOutOneLevel}
                className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 flex items-center gap-1 text-[11px] font-medium transition"
                title="Zoom out one time level"
              >
                <ZoomOut className="w-3.5 h-3.5 text-indigo-400" />
                <span>Zoom Out</span>
              </button>
              <button
                onClick={() => setSelectedPeriodRange(null)}
                className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-white flex items-center gap-1 text-[11px] transition"
                title="Reset to all years"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset</span>
              </button>
            </div>
          )}

          {/* Explicit Date Pickers */}
          <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-[11px]">
            <Calendar className="w-3 h-3 text-zinc-500" />
            <input
              type="date"
              value={
                selectedPeriodRange
                  ? selectedPeriodRange[0]
                  : timelineBuckets[0]?.period || ""
              }
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const start = e.target.value;
                if (!start) return;
                const end = selectedPeriodRange
                  ? selectedPeriodRange[1]
                  : timelineBuckets[timelineBuckets.length - 1]?.period || start;
                setSelectedPeriodRange([
                  start <= end ? start : end,
                  start <= end ? end : start,
                ]);
              }}
              className="bg-transparent text-zinc-200 font-mono text-[11px] select-text focus:outline-none"
            />
            <span className="text-zinc-600">➔</span>
            <input
              type="date"
              value={
                selectedPeriodRange
                  ? selectedPeriodRange[1]
                  : timelineBuckets[timelineBuckets.length - 1]?.period || ""
              }
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const end = e.target.value;
                if (!end) return;
                const start = selectedPeriodRange
                  ? selectedPeriodRange[0]
                  : timelineBuckets[0]?.period || end;
                setSelectedPeriodRange([
                  start <= end ? start : end,
                  start <= end ? end : start,
                ]);
              }}
              className="bg-transparent text-zinc-200 font-mono text-[11px] select-text focus:outline-none"
            />
          </div>
        </div>

        {/* Right Side Info & Hide Button */}
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-zinc-400 font-mono">
            {hoverBucket ? (
              <span className="text-emerald-300 font-semibold">
                {hoverBucket.label} {hoverBucket.subLabel || ""}: {hoverBucket.count} photos
              </span>
            ) : (
              <span>
                {totalPhotosInView} photos in range • Click or drag bars to drill down
              </span>
            )}
          </span>
          <button
            onClick={() => setIsTimelineOpen(false)}
            className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800"
          >
            ▲ Hide
          </button>
        </div>
      </div>

      {/* Large Multi-Scale Interactive Histogram */}
      {displayBuckets.length > 0 ? (
        <div className="h-32 w-full flex items-end gap-1.5 bg-zinc-950/95 px-3 pt-5 pb-2 rounded-xl border border-zinc-800/80 overflow-x-auto">
          {displayBuckets.map((b) => {
            const heightPercent =
              b.count === 0 ? 4 : Math.max(14, Math.round((b.count / maxCount) * 100));

            const isDragHighlighted =
              dragAnchorBucket &&
              b.startDate >=
                (dragAnchorBucket.startDate <= (hoverBucket?.startDate || dragAnchorBucket.startDate)
                  ? dragAnchorBucket.startDate
                  : hoverBucket?.startDate || dragAnchorBucket.startDate) &&
              b.endDate <=
                (dragAnchorBucket.endDate >= (hoverBucket?.endDate || dragAnchorBucket.endDate)
                  ? dragAnchorBucket.endDate
                  : hoverBucket?.endDate || dragAnchorBucket.endDate);

            const isDaySelected =
              activeScale === "DAY" &&
              selectedPeriodRange &&
              b.startDate >= selectedPeriodRange[0] &&
              b.endDate <= selectedPeriodRange[1];

            return (
              <div
                key={b.key}
                onMouseDown={() => setDragAnchorBucket(b)}
                onMouseEnter={() => setHoverBucket(b)}
                onMouseUp={() => {
                  const anchor = dragAnchorBucket || b;
                  const s = anchor.startDate <= b.startDate ? anchor.startDate : b.startDate;
                  const e = anchor.endDate >= b.endDate ? anchor.endDate : b.endDate;
                  // If clicking the exact same single day that is already selected, expand back to the full month
                  if (
                    activeScale === "DAY" &&
                    selectedPeriodRange &&
                    selectedPeriodRange[0] === s &&
                    selectedPeriodRange[1] === e &&
                    s === e
                  ) {
                    const yr = Number(s.slice(0, 4));
                    const mo = Number(s.slice(5, 7));
                    setSelectedPeriodRange([
                      `${yr}-${String(mo).padStart(2, "0")}-01`,
                      lastDayOfMonth(yr, mo),
                    ]);
                  } else {
                    setSelectedPeriodRange([s, e]);
                  }
                  setDragAnchorBucket(null);
                }}
                className="flex-1 min-w-[28px] h-full flex flex-col justify-end items-center group cursor-pointer"
                title={`${b.startDate} to ${b.endDate}: ${b.count} photo(s) — Click or drag across bars to filter`}
              >
                {/* Count badge above bar */}
                <span
                  className={`text-[9px] font-mono mb-1 transition-opacity ${
                    b.count > 0
                      ? isDaySelected
                        ? "text-indigo-300 font-bold opacity-100"
                        : "text-zinc-400 group-hover:text-emerald-300 opacity-90"
                      : "opacity-0"
                  }`}
                >
                  {b.count > 0 ? b.count : ""}
                </span>

                {/* Bar */}
                <div className="w-full flex-1 flex items-end">
                  <div
                    style={{ height: `${heightPercent}%` }}
                    className={`w-full rounded-t-md transition-all duration-150 ${
                      isDragHighlighted || isDaySelected
                        ? "bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.6)]"
                        : b.count > 0
                        ? "bg-emerald-500/75 group-hover:bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.2)]"
                        : "bg-zinc-800/40 group-hover:bg-zinc-700/60"
                    }`}
                  />
                </div>

                {/* X-Axis Label */}
                <div className="mt-1.5 flex flex-col items-center leading-tight">
                  <span
                    className={`text-[10px] font-semibold whitespace-nowrap ${
                      isDaySelected
                        ? "text-indigo-300"
                        : "text-zinc-300 group-hover:text-white"
                    }`}
                  >
                    {b.label}
                  </span>
                  {b.subLabel && (
                    <span className="text-[9px] font-mono text-zinc-500 whitespace-nowrap">
                      {b.subLabel}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-xs text-zinc-500 py-2">
          No dates indexed yet — click <strong>Rescan</strong> in the top bar to extract EXIF dates.
        </div>
      )}
    </div>
  );
}
