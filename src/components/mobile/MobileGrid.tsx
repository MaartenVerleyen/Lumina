import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Play } from "lucide-react";
import type { PhotoItem } from "../../types/lumina";
import { thumbSrc } from "../../utils/photoHelpers";
import { monthKeyOf, monthLabel } from "../../utils/gridLayout";
import { formatDuration, isVideo } from "../../utils/media";

const GAP = 2;
const MONTH_HEIGHT = 40;

type Row = { kind: "month"; label: string } | { kind: "photos"; items: number[] };

// The phone layout's photo grid: square thumbnails, under a heading per month when sorted by date
export default function MobileGrid({
  photos,
  byMonth,
  onOpen,
}: {
  photos: PhotoItem[];
  byMonth: boolean;
  onOpen: (index: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const columns = width >= 900 ? 7 : width >= 700 ? 6 : width >= 520 ? 5 : width >= 420 ? 4 : 3;
  const cell = width > 0 ? (width - GAP * (columns - 1)) / columns : 0;

  const rows = useMemo(() => {
    const out: Row[] = [];
    let month: string | null = null;
    let row: number[] = [];
    photos.forEach((p, i) => {
      if (byMonth) {
        const key = monthKeyOf(p.captured_at);
        if (key !== month) {
          if (row.length) out.push({ kind: "photos", items: row });
          row = [];
          out.push({ kind: "month", label: monthLabel(key) });
          month = key;
        }
      }
      row.push(i);
      if (row.length === columns) {
        out.push({ kind: "photos", items: row });
        row = [];
      }
    });
    if (row.length) out.push({ kind: "photos", items: row });
    return out;
  }, [photos, byMonth, columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === "month" ? MONTH_HEIGHT : cell + GAP),
    overscan: 6,
  });
  // Row heights change with the width (turning the phone)
  useLayoutEffect(() => virtualizer.measure(), [cell, rows]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {width > 0 &&
          virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            return (
              <div
                key={v.key}
                style={{ position: "absolute", top: v.start, left: 0, right: 0, height: v.size }}
              >
                {row.kind === "month" ? (
                  <div className="h-full px-3 flex items-end pb-2 text-sm font-semibold text-zinc-200">{row.label}</div>
                ) : (
                  <div className="flex" style={{ gap: GAP }}>
                    {row.items.map((i) => (
                      <Thumb key={photos[i].hash} photo={photos[i]} size={cell} onOpen={() => onOpen(i)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

function Thumb({ photo, size, onOpen }: { photo: PhotoItem; size: number; onOpen: () => void }) {
  const video = isVideo(photo);
  return (
    <button
      onClick={onOpen}
      className="relative shrink-0 bg-zinc-900 overflow-hidden active:opacity-70"
      style={{ width: size, height: size }}
      aria-label={photo.name}
    >
      {photo.thumb_ready && (
        <img
          src={thumbSrc(photo)}
          alt=""
          loading="lazy"
          draggable={false}
          className="w-full h-full object-cover"
          style={photo.rotation ? { transform: `rotate(${photo.rotation}deg)` } : undefined}
        />
      )}
      {video && (
        <span className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded bg-black/60 px-1 text-[10px] font-semibold text-white">
          <Play className="w-2.5 h-2.5 fill-white" />
          {formatDuration(photo.duration_ms)}
        </span>
      )}
    </button>
  );
}
