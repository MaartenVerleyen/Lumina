import { useMemo, useState } from "react";
import { CalendarHeart, X } from "lucide-react";
import type { PhotoItem } from "../../types/lumina";
import type { CullingSettings } from "../../utils/culling";
import { onThisDay } from "../../utils/highlights";
import { thumbSrc } from "../../utils/photoHelpers";

const DISMISS_KEY = "lumina_on_this_day_dismissed";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

function dismissedToday(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === today();
  } catch {
    return false;
  }
}

// A slim strip above the grid: the best photos taken on this date in earlier years. Click a day to see it;
// hidden for the rest of the day with ✕, and off in Settings.
export default function OnThisDay({
  photos,
  culling,
  onOpenDay,
}: {
  photos: PhotoItem[];
  culling: CullingSettings;
  onOpenDay: (date: string, hashes: string[]) => void;
}) {
  const [dismissed, setDismissed] = useState(dismissedToday);
  // Recomputed when the date changes too (Lumina left open past midnight)
  const day = today();
  // Every photo of each day shown (for "Show the N photos"), in one pass: this component re-renders on every
  // scroll step of the grid, and filtering the whole library per day there froze a 175k-photo library
  const { groups, hashesOfDay } = useMemo(() => {
    const groups = onThisDay(photos, new Date(), culling, 5);
    const hashesOfDay = new Map<string, string[]>(groups.map((g) => [g.date, []]));
    if (hashesOfDay.size > 0) {
      for (const p of photos) {
        const list = hashesOfDay.get((p.captured_at || "").slice(0, 10).replace(/:/g, "-"));
        if (list) list.push(p.hash);
      }
    }
    return { groups, hashesOfDay };
  }, [photos, culling, day]);
  if (dismissed || groups.length === 0) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, today());
    } catch {}
  };

  return (
    <div className="shrink-0 border-b border-zinc-800/60 bg-gradient-to-r from-rose-950/25 via-panel to-panel px-4 py-2.5 flex items-center gap-4 overflow-x-auto">
      <div className="flex items-center gap-2 shrink-0">
        <CalendarHeart className="w-4 h-4 text-rose-300" />
        <span className="text-[12px] font-semibold text-zinc-100">On this day</span>
      </div>
      {groups.map((g) => {
        const all = hashesOfDay.get(g.date) ?? [];
        return (
          <button
            key={g.date}
            onClick={() => onOpenDay(g.date, all)}
            className="flex items-center gap-2 shrink-0 rounded-xl p-1 pr-3 hover:bg-zinc-800/60 transition"
            title={`Show the ${all.length} photo(s) of ${g.date}`}
          >
            <span className="flex -space-x-3">
              {g.photos.slice(0, 4).map((p) => (
                <img
                  key={p.hash}
                  src={p.thumb_ready ? thumbSrc(p) : undefined}
                  alt=""
                  className="w-10 h-10 rounded-lg object-cover border-2 border-panel bg-zinc-900"
                  draggable={false}
                />
              ))}
            </span>
            <span className="text-left leading-tight">
              <span className="block text-[12px] text-zinc-200">
                {g.yearsAgo} year{g.yearsAgo === 1 ? "" : "s"} ago
              </span>
              <span className="block text-[11px] text-zinc-500">
                {new Date(`${g.date}T12:00:00`).getFullYear()} · {all.length} photo{all.length === 1 ? "" : "s"}
              </span>
            </span>
          </button>
        );
      })}
      <button onClick={dismiss} className="ml-auto shrink-0 p-1 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800" aria-label="Hide for today">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
