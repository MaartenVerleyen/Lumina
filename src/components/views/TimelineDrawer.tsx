import { TimelineBucket } from "../../types/lumina";
import { SlidersHorizontal } from "lucide-react";

interface TimelineDrawerProps {
  timelineBuckets: TimelineBucket[];
  selectedPeriodRange: [string, string] | null;
  setSelectedPeriodRange: React.Dispatch<React.SetStateAction<[string, string] | null>>;
  dragAnchorDay: string | null;
  setDragAnchorDay: React.Dispatch<React.SetStateAction<string | null>>;
  setIsTimelineOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function TimelineDrawer({
  timelineBuckets,
  selectedPeriodRange,
  setSelectedPeriodRange,
  dragAnchorDay,
  setDragAnchorDay,
  setIsTimelineOpen,
}: TimelineDrawerProps) {
  return (
    <div
      onMouseUp={() => setDragAnchorDay(null)}
      onMouseLeave={() => setDragAnchorDay(null)}
      className="bg-[#0b0d14] border-b border-zinc-800/80 px-4 py-3 flex flex-col gap-2.5 shrink-0 z-10 animate-in slide-in-from-top-2 duration-150"
    >
      <div className="flex items-center justify-between text-xs flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <span className="font-semibold text-zinc-200 flex items-center gap-1.5 text-[11px]">
            <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-400" />
            Date Range Slicer (Click & Drag across days)
          </span>

          <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-0.5 text-[11px]">
            <span className="text-zinc-500">From:</span>
            <input
              type="date"
              value={
                selectedPeriodRange
                  ? selectedPeriodRange[0]
                  : timelineBuckets[0]?.period || ""
              }
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
              className="bg-transparent text-zinc-200 font-mono text-[11px] focus:outline-none"
            />
            <span className="text-zinc-600">➔</span>
            <span className="text-zinc-500">To:</span>
            <input
              type="date"
              value={
                selectedPeriodRange
                  ? selectedPeriodRange[1]
                  : timelineBuckets[timelineBuckets.length - 1]?.period || ""
              }
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
              className="bg-transparent text-zinc-200 font-mono text-[11px] focus:outline-none"
            />
            {selectedPeriodRange && (
              <button
                onClick={() => setSelectedPeriodRange(null)}
                className="ml-1 text-red-400 hover:text-red-300 font-bold"
                title="Clear date filter"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Quick Year & Range Presets */}
        <div className="flex items-center gap-1 text-[10px]">
          <button
            onClick={() => setSelectedPeriodRange(null)}
            className={`px-2 py-0.5 rounded ${
              !selectedPeriodRange
                ? "bg-zinc-800 text-zinc-200 font-medium"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            All Dates
          </button>
          {Array.from(new Set(timelineBuckets.map((b) => b.period.slice(0, 4))))
            .slice(-5)
            .map((yr) => (
              <button
                key={yr}
                onClick={() => setSelectedPeriodRange([`${yr}-01-01`, `${yr}-12-31`])}
                className={`px-2 py-0.5 rounded ${
                  selectedPeriodRange &&
                  selectedPeriodRange[0] === `${yr}-01-01` &&
                  selectedPeriodRange[1] === `${yr}-12-31`
                    ? "bg-indigo-600 text-white font-medium"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {yr}
              </button>
            ))}
          <button
            onClick={() => setIsTimelineOpen(false)}
            className="ml-2 px-1.5 py-0.5 text-zinc-500 hover:text-zinc-300"
            title="Hide Timeline Drawer"
          >
            ▲ Hide
          </button>
        </div>
      </div>

      {/* Interactive Click-and-Drag Daily Histogram + Dual Scrub Handles */}
      {timelineBuckets.length > 0 ? (
        <div className="flex flex-col gap-1.5 select-none">
          <div className="h-12 w-full flex items-end gap-[2px] bg-zinc-950/90 px-2 pt-2 pb-1 rounded-lg border border-zinc-800/70 overflow-x-auto">
            {(() => {
              const maxCount = Math.max(...timelineBuckets.map((b) => b.count), 1);
              return timelineBuckets.map((b) => {
                const isSelected =
                  !selectedPeriodRange ||
                  (b.period >= selectedPeriodRange[0] && b.period <= selectedPeriodRange[1]);
                const heightPercent = Math.max(14, Math.round((b.count / maxCount) * 100));

                return (
                  <div
                    key={b.period}
                    onMouseDown={() => {
                      setDragAnchorDay(b.period);
                      setSelectedPeriodRange([b.period, b.period]);
                    }}
                    onMouseEnter={() => {
                      if (dragAnchorDay) {
                        const d1 = dragAnchorDay <= b.period ? dragAnchorDay : b.period;
                        const d2 = dragAnchorDay <= b.period ? b.period : dragAnchorDay;
                        setSelectedPeriodRange([d1, d2]);
                      }
                    }}
                    style={{ height: `${heightPercent}%` }}
                    className={`flex-1 min-w-[6px] rounded-t cursor-ew-resize transition-colors ${
                      selectedPeriodRange && isSelected
                        ? "bg-indigo-500 shadow-[0_0_6px_rgba(99,102,241,0.5)]"
                        : isSelected
                        ? "bg-emerald-500/60 hover:bg-indigo-400"
                        : "bg-zinc-800/60 hover:bg-zinc-700"
                    }`}
                    title={`${b.period}: ${b.count} photo${
                      b.count === 1 ? "" : "s"
                    } (Click & drag to select range)`}
                  />
                );
              });
            })()}
          </div>

          <div className="flex items-center gap-3 px-1 text-[10px] text-zinc-400 font-mono">
            <span>{timelineBuckets[0]?.period}</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, timelineBuckets.length - 1)}
              value={
                selectedPeriodRange
                  ? Math.max(
                      0,
                      timelineBuckets.findIndex((b) => b.period >= selectedPeriodRange[0])
                    )
                  : 0
              }
              onChange={(e) => {
                const idx = Number(e.target.value);
                const day = timelineBuckets[idx]?.period;
                if (!day) return;
                const curEnd = selectedPeriodRange
                  ? selectedPeriodRange[1]
                  : timelineBuckets[timelineBuckets.length - 1]?.period || day;
                setSelectedPeriodRange([
                  day <= curEnd ? day : curEnd,
                  day <= curEnd ? curEnd : day,
                ]);
              }}
              className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              title="Drag Start Day"
            />
            <input
              type="range"
              min={0}
              max={Math.max(0, timelineBuckets.length - 1)}
              value={
                selectedPeriodRange
                  ? (() => {
                      let lastIdx = timelineBuckets.length - 1;
                      for (let i = timelineBuckets.length - 1; i >= 0; i--) {
                        if (timelineBuckets[i].period <= selectedPeriodRange[1]) {
                          lastIdx = i;
                          break;
                        }
                      }
                      return lastIdx;
                    })()
                  : Math.max(0, timelineBuckets.length - 1)
              }
              onChange={(e) => {
                const idx = Number(e.target.value);
                const day = timelineBuckets[idx]?.period;
                if (!day) return;
                const curStart = selectedPeriodRange
                  ? selectedPeriodRange[0]
                  : timelineBuckets[0]?.period || day;
                setSelectedPeriodRange([
                  curStart <= day ? curStart : day,
                  curStart <= day ? day : curStart,
                ]);
              }}
              className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              title="Drag End Day"
            />
            <span>{timelineBuckets[timelineBuckets.length - 1]?.period}</span>
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-zinc-500 py-1">
          No dates indexed yet — click <strong>Rescan</strong> in the top bar to extract dates
          from your files.
        </div>
      )}
    </div>
  );
}
