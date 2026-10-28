import { useEffect, useMemo, useRef, useState } from "react";
import type { LayoutRow } from "../../utils/gridLayout";

interface DateScrubberProps {
  // The grid's rows; the month headers are the stops
  rows: LayoutRow[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  scrollTop: number;
}

interface Stop {
  key: string; // the header row's id
  month: string; // "2024-06" or "undated"
  label: string;
  year: string;
  top: number; // header position in the grid
  y: number; // position on the scrubber, 0..1
}

// Year labels closer together than this (px) are skipped, so a busy decade stays readable
const MIN_LABEL_GAP = 16;
const PAD = 14;

// The whole timeline along the grid's right edge (when sorted by date): it slides out when the mouse reaches
// the edge. Click or drag to jump to a month; click a year to jump to it. Months sit where they are in the grid,
// so busy months take more room, as on the scrollbar.
export default function DateScrubber({ rows, scrollRef, scrollTop }: DateScrubberProps) {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const [trackHeight, setTrackHeight] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);

  const total = useMemo(() => {
    const last = rows[rows.length - 1];
    return last ? last.top + last.height : 0;
  }, [rows]);

  const stops = useMemo<Stop[]>(
    () =>
      rows.flatMap((r) =>
        r.kind === "header"
          ? [
              {
                key: r.key,
                month: r.group,
                label: r.label,
                year: /^\d{4}-/.test(r.group) ? r.group.slice(0, 4) : "",
                top: r.top,
                y: total ? r.top / total : 0,
              },
            ]
          : []
      ),
    [rows, total]
  );

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackHeight(el.clientHeight - 2 * PAD));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // Years: the first month shown of each, labelled when there is room
  const years = useMemo(() => {
    const out: { stop: Stop; px: number }[] = [];
    let lastPx = -Infinity;
    for (const s of stops) {
      if (!s.year || out.some((o) => o.stop.year === s.year)) continue;
      const px = s.y * trackHeight;
      if (px - lastPx < MIN_LABEL_GAP) continue;
      out.push({ stop: s, px });
      lastPx = px;
    }
    return out;
  }, [stops, trackHeight]);

  if (stops.length < 2) return null;

  // The month at a height on the scrubber: the last one starting at or above it
  const stopAt = (clientY: number): Stop => {
    const rect = trackRef.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientY - rect.top - PAD) / Math.max(1, trackHeight)));
    let found = stops[0];
    for (const s of stops) {
      if (s.y <= frac + 1e-6) found = s;
      else break;
    }
    return found;
  };
  const jumpTo = (s: Stop) => {
    if (scrollRef.current) scrollRef.current.scrollTop = s.top;
  };

  const hovered = hoverY !== null ? stopAt(hoverY) : null;
  let currentIndex = 0;
  stops.forEach((s, i) => {
    if (s.top <= scrollTop + 1) currentIndex = i;
  });
  const viewport = scrollRef.current?.clientHeight ?? 0;
  const thumbTop = total ? (scrollTop / total) * trackHeight : 0;
  const thumbHeight = total ? Math.max(4, (viewport / total) * trackHeight) : 0;
  const shown = open || dragging;

  return (
    <>
      {/* Hot zone along the edge, left of the scrollbar */}
      {!shown && <div className="absolute top-0 bottom-0 right-[7px] w-4 z-30" onMouseEnter={() => setOpen(true)} aria-hidden />}
      {shown && (
        <div
          ref={trackRef}
          role="slider"
          aria-label="Jump to a date"
          aria-valuetext={stops[currentIndex].label}
          aria-valuemin={0}
          aria-valuemax={stops.length - 1}
          aria-valuenow={currentIndex}
          onMouseLeave={() => {
            if (!dragging) {
              setOpen(false);
              setHoverY(null);
            }
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            jumpTo(stopAt(e.clientY));
          }}
          onPointerMove={(e) => {
            setHoverY(e.clientY);
            if (dragging) jumpTo(stopAt(e.clientY));
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setDragging(false);
            const rect = e.currentTarget.getBoundingClientRect();
            const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
            if (!inside) {
              setOpen(false);
              setHoverY(null);
            }
          }}
          className="absolute top-0 bottom-0 right-[7px] w-24 z-30 select-none cursor-pointer bg-gradient-to-l from-zinc-950/95 via-zinc-950/85 to-transparent"
        >
          <div className="absolute right-3 w-px bg-zinc-700/80" style={{ top: PAD, bottom: PAD }} />
          {/* Where the grid is now */}
          <div
            className="absolute right-2 w-[3px] rounded-full bg-emerald-400/70"
            style={{ top: PAD + thumbTop, height: thumbHeight }}
          />
          {/* A tick per month */}
          {stops.map((s) => (
            <div
              key={s.key}
              className={`absolute h-px ${s.month.endsWith("-01") ? "right-3 w-3 bg-zinc-400" : "right-3 w-1.5 bg-zinc-600"}`}
              style={{ top: PAD + s.y * trackHeight }}
            />
          ))}
          {/* Years: a click jumps to the year's first month in the grid */}
          {years.map(({ stop, px }) => (
            <button
              key={stop.year}
              onPointerDown={(e) => {
                e.stopPropagation();
                jumpTo(stop);
              }}
              className="absolute right-7 -translate-y-1/2 text-[11px] font-semibold text-zinc-400 hover:text-white tabular-nums"
              style={{ top: PAD + px }}
            >
              {stop.year}
            </button>
          ))}
          {hovered && hoverY !== null && trackRef.current && (
            <div
              className="absolute right-6 -translate-y-1/2 px-2 py-0.5 rounded-md bg-emerald-500 text-zinc-950 text-[11px] font-bold whitespace-nowrap shadow-lg pointer-events-none"
              style={{ top: hoverY - trackRef.current.getBoundingClientRect().top }}
            >
              {hovered.label}
            </div>
          )}
        </div>
      )}
    </>
  );
}
