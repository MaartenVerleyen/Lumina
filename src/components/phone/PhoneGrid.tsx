import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Cloud, CloudOff, Eye, Loader2, Play, RefreshCw } from "lucide-react";
import type { PhotoItem } from "../../types/lumina";
import { allPhotosCanBackUp, allPhotosHasLocal, allPhotosSources } from "../../api";
import { whereabouts } from "../../api/allPhotos";
import { thumbSrc } from "../../utils/photoHelpers";
import { monthKeyOf, monthLabel } from "../../utils/gridLayout";
import { formatDuration, isVideo } from "../../utils/media";

// The phone app's timeline (docs/plans/android-app-ui.md, Photos): square thumbnails under a heading per day, or
// per month when zoomed out; pinch to change the size, a fast scroller to jump through the years, long-press and
// drag to select, pull down to refresh. Marks say where a photo is (All photos): amber only on this phone, a cloud
// only on the server.

const GAP = 2;
const HEAD = 44;
// Pinching steps through these; up to 5 columns a heading per day, beyond that per month
export const COLUMN_STEPS = [3, 4, 5, 7, 9];
const LONG_PRESS_MS = 380;
const PULL_TO_REFRESH = 64;

type Row = { kind: "head"; label: string; start: number; end: number } | { kind: "photos"; items: number[] };

type Mark = "phone" | "server" | "shared" | null;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayKeyOf(capturedAt: string | undefined): string {
  const s = capturedAt || "";
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "undated";
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "Today", "Yesterday", "Sat 1 Nov", "Sat 1 Nov 2025"
function dayLabel(key: string): string {
  if (key === "undated") return "No date";
  const now = new Date();
  if (key === localDayKey(now)) return "Today";
  if (key === localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const label = `${DAYS[date.getDay()]} ${d} ${MONTHS_SHORT[m - 1]}`;
  return y === now.getFullYear() ? label : `${label} ${y}`;
}

export default function PhoneGrid({
  photos,
  byDate,
  columns,
  onColumns,
  selected,
  onSelect,
  onOpen,
  uploading,
  marks,
  refreshing,
  onRefresh,
  onLongPress,
}: {
  photos: PhotoItem[];
  // Headings by day or month (the photos are in date order)
  byDate: boolean;
  columns: number;
  onColumns: (columns: number) => void;
  selected: Set<string>;
  onSelect: (next: Set<string>) => void;
  onOpen: (index: number) => void;
  // Content ids of photos being backed up now
  uploading: Set<string>;
  // All photos: show where each photo is
  marks: boolean;
  refreshing: boolean;
  onRefresh?: () => void;
  onLongPress?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const cell = width > 0 ? (width - GAP * (columns - 1)) / columns : 0;
  const byMonth = columns > 5;

  const rows = useMemo(() => {
    const out: Row[] = [];
    let row: number[] = [];
    let group: string | null = null;
    let head: (Row & { kind: "head" }) | null = null;
    photos.forEach((p, i) => {
      if (byDate) {
        const key = byMonth ? monthKeyOf(p.captured_at) : dayKeyOf(p.captured_at);
        if (key !== group) {
          if (row.length) out.push({ kind: "photos", items: row });
          row = [];
          if (head) head.end = i;
          head = { kind: "head", label: byMonth ? monthLabel(key) : dayLabel(key), start: i, end: i };
          out.push(head);
          group = key;
        }
      }
      row.push(i);
      if (row.length === columns) {
        out.push({ kind: "photos", items: row });
        row = [];
      }
    });
    if (row.length) out.push({ kind: "photos", items: row });
    if (head) (head as Row & { kind: "head" }).end = photos.length;
    return out;
  }, [photos, byDate, byMonth, columns]);

  // Where each row starts (the sizes are known: no measuring), for pinching around a photo and the scroller
  const offsets = useMemo(() => {
    const out = new Array<number>(rows.length);
    let y = 0;
    rows.forEach((r, i) => {
      out[i] = y;
      y += r.kind === "head" ? HEAD : cell + GAP;
    });
    return out;
  }, [rows, cell]);
  const rowOfPhoto = useMemo(() => {
    const out = new Int32Array(photos.length);
    rows.forEach((r, ri) => {
      if (r.kind === "photos") for (const i of r.items) out[i] = ri;
    });
    return out;
  }, [rows, photos.length]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === "head" ? HEAD : cell + GAP),
    overscan: 4,
  });
  useLayoutEffect(() => virtualizer.measure(), [cell, rows]);

  // A pinch keeps the photo under the fingers where it was
  const anchor = useRef<{ index: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    anchor.current = null;
    el.scrollTop = Math.max(0, offsets[rowOfPhoto[a.index]] - a.y);
  }, [offsets, rowOfPhoto]);

  const selecting = selected.size > 0;
  const state = useRef({ selected, selecting, onSelect, onOpen, onColumns, onRefresh, onLongPress, columns, refreshing });
  state.current = { selected, selecting, onSelect, onOpen, onColumns, onRefresh, onLongPress, columns, refreshing };
  const [pull, setPull] = useState(0);
  const [scrolling, setScrolling] = useState(false);

  // Touch: tap, long-press and drag to select, pinch, pull to refresh. Native listeners: React's are passive, and
  // a pinch or a drag-select must keep the page from scrolling or zooming.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let start = { x: 0, y: 0, top: 0 };
    let moved = false;
    let pressTimer: number | null = null;
    let target: { index?: number; head?: number } = {};
    let drag: { anchor: number; base: Set<string>; add: boolean; last: number; y: number } | null = null;
    let autoScroll: number | null = null;
    let pinch: { d0: number; scale: number } | null = null;
    let pulling = 0;

    const targetAt = (x: number, y: number): { index?: number; head?: number } => {
      const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-i],[data-head]");
      if (!hit) return {};
      if (hit.dataset.i !== undefined) return { index: Number(hit.dataset.i) };
      return { head: Number(hit.dataset.head) };
    };
    const clearPress = () => {
      if (pressTimer !== null) window.clearTimeout(pressTimer);
      pressTimer = null;
    };
    const dragTo = (i: number) => {
      if (!drag || i === drag.last) return;
      drag.last = i;
      const next = new Set(drag.base);
      const [a, b] = drag.anchor < i ? [drag.anchor, i] : [i, drag.anchor];
      for (let k = a; k <= b; k++) {
        const hash = photosRef.current[k]?.hash;
        if (!hash) continue;
        if (drag.add) next.add(hash);
        else next.delete(hash);
      }
      state.current.onSelect(next);
    };
    const stopAutoScroll = () => {
      if (autoScroll !== null) window.cancelAnimationFrame(autoScroll);
      autoScroll = null;
    };
    // Dragging a selection near the top or bottom edge scrolls on
    const runAutoScroll = (x: number) => {
      const step = () => {
        if (!drag) return stopAutoScroll();
        const rect = el.getBoundingClientRect();
        const edge = 72;
        const dy = drag.y < rect.top + edge ? -(rect.top + edge - drag.y) / 4 : drag.y > rect.bottom - edge ? (drag.y - (rect.bottom - edge)) / 4 : 0;
        if (dy === 0) return stopAutoScroll();
        el.scrollTop += dy;
        const t = targetAt(x, drag.y);
        if (t.index !== undefined) dragTo(t.index);
        autoScroll = window.requestAnimationFrame(step);
      };
      if (autoScroll === null) autoScroll = window.requestAnimationFrame(step);
    };

    const onStart = (e: TouchEvent) => {
      if ((e.target as HTMLElement).closest("[data-scroller]")) return;
      if (e.touches.length === 2) {
        clearPress();
        drag = null;
        const [a, b] = [e.touches[0], e.touches[1]];
        const cx = (a.clientX + b.clientX) / 2;
        const cy = (a.clientY + b.clientY) / 2;
        const t = targetAt(cx, cy);
        const rect = el.getBoundingClientRect();
        pinch ={ d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale: 1 };
        pinchAnchor = t.index !== undefined ? { index: t.index, y: cy - rect.top } : null;
        content.style.transformOrigin = `${cx - rect.left}px ${cy - rect.top + el.scrollTop}px`;
        return;
      }
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      start = { x: touch.clientX, y: touch.clientY, top: el.scrollTop };
      moved = false;
      pulling = 0;
      target = targetAt(touch.clientX, touch.clientY);
      clearPress();
      if (target.index !== undefined) {
        const index = target.index;
        pressTimer = window.setTimeout(() => {
          pressTimer = null;
          const hash = photosRef.current[index]?.hash;
          if (!hash) return;
          const { selected } = state.current;
          // Long-press on a selected photo drags to take photos off again
          const add = !selected.has(hash) || !state.current.selecting;
          drag = { anchor: index, base: new Set(selected), add, last: -1, y: start.y };
          dragTo(index);
          state.current.onLongPress?.();
        }, LONG_PRESS_MS);
      }
    };

    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = [e.touches[0], e.touches[1]];
        pinch.scale = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d0;
        content.style.transform = `scale(${Math.min(1.6, Math.max(0.6, pinch.scale))})`;
        return;
      }
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (drag) {
        e.preventDefault();
        drag.y = touch.clientY;
        const t = targetAt(touch.clientX, touch.clientY);
        if (t.index !== undefined) dragTo(t.index);
        runAutoScroll(touch.clientX);
        return;
      }
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) > 8) {
        moved = true;
        clearPress();
      }
      // Pull down at the top: refresh
      if (state.current.onRefresh && start.top <= 0 && el.scrollTop <= 0 && dy > 0 && Math.abs(dy) > Math.abs(dx)) {
        e.preventDefault();
        pulling = Math.min(110, dy * 0.5);
        setPull(pulling);
      }
    };

    const onEnd = (e: TouchEvent) => {
      // The browser follows a touch with a click: the click handler leaves it to this one (a long-press lifted
      // without moving would otherwise take the photo off again)
      lastTouch = Date.now();
      if (pinch) {
        if (e.touches.length > 0) return;
        const s = pinch.scale;
        pinch = null;
        content.style.transform = "";
        const { columns, onColumns } = state.current;
        const step = COLUMN_STEPS.indexOf(columns);
        const next = s > 1.18 ? COLUMN_STEPS[Math.max(0, step - 1)] : s < 0.85 ? COLUMN_STEPS[Math.min(COLUMN_STEPS.length - 1, step + 1)] : columns;
        if (next !== columns) {
          anchor.current = pinchAnchor;
          onColumns(next);
        }
        return;
      }
      clearPress();
      stopAutoScroll();
      if (drag) {
        drag = null;
        return;
      }
      if (pulling > 0) {
        if (pulling >= PULL_TO_REFRESH && !state.current.refreshing) state.current.onRefresh?.();
        pulling = 0;
        setPull(0);
        return;
      }
      if (moved || e.changedTouches.length !== 1) return;
      const { selecting, selected, onSelect, onOpen } = state.current;
      if (target.index !== undefined) {
        const hash = photosRef.current[target.index]?.hash;
        if (selecting && hash) {
          const next = new Set(selected);
          if (next.has(hash)) next.delete(hash);
          else next.add(hash);
          onSelect(next);
        } else {
          onOpen(target.index);
        }
      } else if (target.head !== undefined && selecting) {
        toggleGroup(target.head);
      }
    };

    // A mouse (the web client in a narrow window): clicks, no long-press
    const onClick = (e: MouseEvent) => {
      if (Date.now() - lastTouch < 800) return;
      const t = targetAt(e.clientX, e.clientY);
      const { selecting, selected, onSelect, onOpen } = state.current;
      if (t.index !== undefined) {
        const hash = photosRef.current[t.index]?.hash;
        if ((selecting || e.ctrlKey || e.metaKey) && hash) {
          const next = new Set(selected);
          if (next.has(hash)) next.delete(hash);
          else next.add(hash);
          onSelect(next);
        } else {
          onOpen(t.index);
        }
      } else if (t.head !== undefined && selecting) {
        toggleGroup(t.head);
      }
    };

    let pinchAnchor: { index: number; y: number } | null = null;
    let lastTouch = 0;
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("click", onClick);
    return () => {
      clearPress();
      stopAutoScroll();
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("click", onClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const photosRef = useRef(photos);
  photosRef.current = photos;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // A heading in selection mode: the whole day (or month) in or out
  const toggleGroup = (rowIndex: number) => {
    const head = rowsRef.current[rowIndex];
    if (!head || head.kind !== "head") return;
    const { selected, onSelect } = state.current;
    const hashes = photosRef.current.slice(head.start, head.end).map((p) => p.hash);
    const all = hashes.every((h) => selected.has(h));
    const next = new Set(selected);
    for (const h of hashes) {
      if (all) next.delete(h);
      else next.add(h);
    }
    onSelect(next);
  };

  // The fast scroller shows while scrolling, and a little after
  const idle = useRef<number | null>(null);
  const onScroll = () => {
    if (!scrolling) setScrolling(true);
    if (idle.current !== null) window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setScrolling(false), 1500);
  };

  const sources = marks ? allPhotosSources() : null;
  const canBackUp = marks && allPhotosCanBackUp();
  const hasLocal = marks && allPhotosHasLocal();
  const markOf = (p: PhotoItem): Mark => {
    if (!sources || !p.copies) return null;
    const where = whereabouts(p, sources, canBackUp);
    if (where === "not-backed-up") return "phone";
    if (where !== "server-only") return null;
    if (!p.home) return "shared";
    return hasLocal ? "server" : null;
  };

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {(pull > 0 || refreshing) && (
        <div
          className="absolute left-1/2 z-20 -translate-x-1/2 w-9 h-9 rounded-full bg-raised border border-zinc-700 shadow-lg flex items-center justify-center"
          style={{ top: refreshing ? 12 : pull - 28 }}
        >
          {refreshing ? (
            <Loader2 className="w-4 h-4 text-emerald-400 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4 text-emerald-400" style={{ transform: `rotate(${pull * 3}deg)`, opacity: Math.min(1, pull / PULL_TO_REFRESH) }} />
          )}
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain select-none" style={{ WebkitTouchCallout: "none" }}>
        <div ref={contentRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {width > 0 &&
            virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index];
              return (
                <div key={v.key} style={{ position: "absolute", top: v.start, left: 0, right: 0, height: v.size }}>
                  {row.kind === "head" ? (
                    <Heading
                      label={row.label}
                      rowIndex={v.index}
                      selecting={selecting}
                      allSelected={selecting && photos.slice(row.start, row.end).every((p) => selected.has(p.hash))}
                    />
                  ) : (
                    <div className="flex" style={{ gap: GAP }}>
                      {row.items.map((i) => {
                        const p = photos[i];
                        return (
                          <Thumb
                            key={p.hash}
                            index={i}
                            photo={p}
                            size={cell}
                            small={columns > 5}
                            mark={markOf(p)}
                            uploading={uploading.has(p.hash)}
                            selecting={selecting}
                            selected={selected.has(p.hash)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>
      {byDate && photos.length > 60 && (
        <FastScroller scrollRef={scrollRef} visible={scrolling} labelAt={(top) => scrollLabel(top, offsets, rows, photos)} />
      )}
    </div>
  );
}

// The month at a scroll position, for the fast scroller's bubble
function scrollLabel(top: number, offsets: number[], rows: Row[], photos: PhotoItem[]): string {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= top) lo = mid;
    else hi = mid - 1;
  }
  for (let r = lo; r < rows.length; r++) {
    const row = rows[r];
    const i = row.kind === "photos" ? row.items[0] : row.start;
    if (photos[i]) return monthLabel(monthKeyOf(photos[i].captured_at));
  }
  return "";
}

function Heading({ label, rowIndex, selecting, allSelected }: { label: string; rowIndex: number; selecting: boolean; allSelected: boolean }) {
  return (
    <div data-head={rowIndex} className="h-full px-3 flex items-end justify-between pb-2">
      <span className="text-sm font-semibold text-zinc-100">{label}</span>
      {selecting && (
        <span
          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${allSelected ? "bg-emerald-500 border-emerald-500" : "border-zinc-400"}`}
        >
          {allSelected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
        </span>
      )}
    </div>
  );
}

const Thumb = memo(function Thumb({
  index,
  photo,
  size,
  small,
  mark,
  uploading,
  selecting,
  selected,
}: {
  index: number;
  photo: PhotoItem;
  size: number;
  small: boolean;
  mark: Mark;
  uploading: boolean;
  selecting: boolean;
  selected: boolean;
}) {
  const video = isVideo(photo);
  return (
    <div data-i={index} className="relative shrink-0 bg-zinc-900 overflow-hidden" style={{ width: size, height: size }} aria-label={photo.name}>
      {photo.thumb_ready && (
        <img
          src={thumbSrc(photo)}
          alt=""
          loading="lazy"
          draggable={false}
          className={`w-full h-full object-cover transition-transform duration-150 ${selected ? "scale-[0.86] rounded-lg" : ""}`}
          style={photo.rotation ? { transform: `rotate(${photo.rotation}deg)${selected ? " scale(0.86)" : ""}` } : undefined}
        />
      )}
      {uploading ? (
        <Badge className="text-emerald-300 border-emerald-400/50" small={small}>
          <Loader2 className="w-full h-full animate-spin" />
        </Badge>
      ) : mark === "phone" ? (
        <Badge className="text-amber-300 border-amber-400/60" small={small}>
          <CloudOff className="w-full h-full" />
        </Badge>
      ) : mark === "server" ? (
        <Badge className="text-sky-300 border-sky-400/50" small={small}>
          <Cloud className="w-full h-full" />
        </Badge>
      ) : mark === "shared" ? (
        <Badge className="text-violet-300 border-violet-400/50" small={small}>
          <Eye className="w-full h-full" />
        </Badge>
      ) : null}
      {video && !small && (
        <span className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded bg-black/60 px-1 text-[11px] font-semibold text-white">
          <Play className="w-2.5 h-2.5 fill-white" />
          {formatDuration(photo.duration_ms)}
        </span>
      )}
      {selecting && (
        <span
          className={`absolute top-1.5 left-1.5 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
            selected ? "bg-emerald-500 border-emerald-500" : "border-white/90 bg-black/20"
          }`}
        >
          {selected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
        </span>
      )}
    </div>
  );
});

function Badge({ className, small, children }: { className: string; small: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`absolute top-1 right-1 rounded-full bg-zinc-950/80 border flex items-center justify-center ${small ? "w-3.5 h-3.5 p-0.5" : "w-5 h-5 p-1"} ${className}`}
    >
      {children}
    </span>
  );
}

// Drag the handle on the right edge to jump through the years; a bubble shows the month
function FastScroller({
  scrollRef,
  visible,
  labelAt,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  labelAt: (top: number) => string;
}) {
  const [, redraw] = useState(0);
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const HANDLE = 44;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => redraw((n) => n + 1);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef]);
  const el = scrollRef.current;
  const track = trackRef.current?.clientHeight ?? 0;
  const range = el ? el.scrollHeight - el.clientHeight : 0;
  const ratio = el && range > 0 ? el.scrollTop / range : 0;
  const top = ratio * Math.max(0, track - HANDLE);

  const scrollTo = (clientY: number) => {
    const t = trackRef.current;
    if (!t || !el) return;
    const rect = t.getBoundingClientRect();
    const r = Math.min(1, Math.max(0, (clientY - rect.top - HANDLE / 2) / (rect.height - HANDLE)));
    el.scrollTop = r * (el.scrollHeight - el.clientHeight);
  };
  const show = visible || dragging;
  return (
    <div ref={trackRef} data-scroller className="absolute right-0 top-2 bottom-2 w-10 pointer-events-none">
      <div
        className={`absolute right-1 pointer-events-auto transition-opacity duration-200 ${show ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        style={{ top, height: HANDLE, touchAction: "none" }}
        onPointerDown={(e) => {
          if (e.pointerType !== "mouse") return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => e.pointerType === "mouse" && dragging && scrollTo(e.clientY)}
        onPointerUp={() => setDragging(false)}
        onTouchStart={() => setDragging(true)}
        onTouchMove={(e) => scrollTo(e.touches[0].clientY)}
        onTouchEnd={() => setDragging(false)}
        onTouchCancel={() => setDragging(false)}
      >
        <div className="w-8 h-full rounded-l-full bg-raised border border-zinc-600 shadow-lg flex items-center justify-center">
          <div className="w-1 h-4 rounded-full bg-zinc-400" />
        </div>
        {dragging && el && (
          <div className="absolute right-10 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white shadow-lg">
            {labelAt(el.scrollTop)}
          </div>
        )}
      </div>
    </div>
  );
}
