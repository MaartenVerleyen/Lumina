import { useEffect, useMemo, useState } from "react";
import { BookImage, Calendar, Check, MoreHorizontal, Plane, Plus, Search, Sparkles, Trophy } from "lucide-react";
import { Album, PhotoItem, SavedSearch } from "../../types/lumina";
import { Trip } from "../../utils/trips";
import { thumbSrc } from "../../utils/photoHelpers";
import type { HighlightFocus } from "../../utils/highlights";

interface TripEntry {
  id: string;
  label: string;
  count: number;
  kind: "event" | "trip";
}

interface CollectionsViewProps {
  albums: Album[];
  // Photos of each album in the open folder
  albumCounts: Map<number, number>;
  savedSearches: SavedSearch[];
  trips: Trip[];
  tripEntries: TripEntry[];
  photoByHash: Map<string, PhotoItem>;
  onOpenAlbum: (id: number) => void;
  onOpenSavedSearch: (saved: SavedSearch) => void;
  onOpenTrip: (id: string) => void;
  onCreateAlbum: (name: string) => Promise<number | null>;
  onRenameAlbum: (id: number, name: string) => Promise<void>;
  onDeleteAlbum: (id: number) => Promise<void>;
  onDeleteSavedSearch: (id: number) => Promise<void>;
  onRenameTrip: (id: string, name: string) => Promise<void>;
  onHighlights: (title: string, hashes: string[], count?: number, focus?: HighlightFocus) => void;
  // The best `count` photos of a set, as Highlights would choose them
  pickHighlights: (source: PhotoItem[], count: number, focus?: HighlightFocus) => Promise<string[]>;
  // What Best of focuses on (the starred people)
  bestOfFocus: HighlightFocus;
  onShareGallery: (title: string, hashes: string[]) => void;
}

// Up to four thumbnails of photos in the open folder, as a 2x2 (or single) cover
function Cover({ hashes, photoByHash, icon }: { hashes: string[]; photoByHash: Map<string, PhotoItem>; icon: React.ReactNode }) {
  const covers: PhotoItem[] = [];
  for (const h of hashes) {
    const p = photoByHash.get(h);
    if (p?.thumb_ready) covers.push(p);
    if (covers.length === 4) break;
  }
  if (covers.length === 0) {
    return <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-600">{icon}</div>;
  }
  if (covers.length < 4) {
    return <img src={thumbSrc(covers[0])} alt="" loading="lazy" className="w-full h-full object-cover" />;
  }
  return (
    <div className="w-full h-full grid grid-cols-2 grid-rows-2 gap-0.5">
      {covers.map((p) => (
        <img key={p.hash} src={thumbSrc(p)} alt="" loading="lazy" className="w-full h-full object-cover" />
      ))}
    </div>
  );
}

interface CardProps {
  title: string;
  subtitle: string;
  cover: React.ReactNode;
  onOpen: () => void;
  menu?: { label: string; danger?: boolean; run: () => void }[];
  renaming?: boolean;
  renameValue?: string;
  onRenameChange?: (v: string) => void;
  onRenameDone?: (save: boolean) => void;
}

function Card({ title, subtitle, cover, onOpen, menu, renaming, renameValue, onRenameChange, onRenameDone }: CardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="group relative rounded-xl overflow-hidden bg-card border border-zinc-800 hover:border-zinc-600 transition flex flex-col">
      <button onClick={onOpen} className="aspect-[4/3] w-full overflow-hidden bg-zinc-950" aria-label={`Open ${title}`}>
        {cover}
      </button>
      <div className="px-3 py-2 flex flex-col gap-0.5 min-w-0">
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onRenameDone?.(true);
            }}
            className="flex items-center gap-1"
          >
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => onRenameChange?.(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") onRenameDone?.(false);
              }}
              onBlur={() => onRenameDone?.(false)}
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-100 select-text focus:outline-none focus:border-emerald-500"
            />
          </form>
        ) : (
          <button onClick={onOpen} className="text-left text-sm font-semibold text-zinc-100 truncate" title={title}>
            {title}
          </button>
        )}
        <span className="text-[11px] text-zinc-500 truncate" title={subtitle}>
          {subtitle}
        </span>
      </div>
      {menu && menu.length > 0 && (
        <div className="absolute top-1.5 right-1.5">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
            className="p-1 rounded-lg bg-black/60 text-zinc-200 hover:bg-black/80 opacity-0 group-hover:opacity-100 focus:opacity-100"
            aria-label={`Options for ${title}`}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-1 w-36 bg-raised border border-zinc-700 rounded-lg shadow-2xl p-1 text-xs z-10">
              {menu.map((m) => (
                <button
                  key={m.label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setMenuOpen(false);
                    m.run();
                  }}
                  className={`w-full text-left px-2 py-1.5 rounded hover:bg-zinc-800 ${m.danger ? "text-red-300" : "text-zinc-200"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const sectionGrid = "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]";

// The Collections tab: albums, smart albums and automatic trips & events, as cards.
// Clicking a card opens the Photos tab filtered to it.
export default function CollectionsView({
  albums,
  albumCounts,
  savedSearches,
  trips,
  tripEntries,
  photoByHash,
  onOpenAlbum,
  onOpenSavedSearch,
  onOpenTrip,
  onCreateAlbum,
  onRenameAlbum,
  onDeleteAlbum,
  onDeleteSavedSearch,
  onRenameTrip,
  onHighlights,
  pickHighlights,
  bestOfFocus,
  onShareGallery,
}: CollectionsViewProps) {
  const [filter, setFilter] = useState("");
  const [newAlbumName, setNewAlbumName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ kind: "album" | "trip"; id: string; value: string } | null>(null);

  const q = filter.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);

  const tripsById = useMemo(() => new Map(trips.map((t) => [t.id, t])), [trips]);
  // Trips & events grouped by year, newest first
  const tripsByYear = useMemo(() => {
    const groups = new Map<number, TripEntry[]>();
    for (const e of tripEntries) {
      if (!matches(e.label)) continue;
      const trip = tripsById.get(e.id);
      const year = trip ? new Date(trip.start).getUTCFullYear() : 0;
      groups.set(year, [...(groups.get(year) ?? []), e]);
    }
    return Array.from(groups.entries()).sort((a, b) => b[0] - a[0]);
  }, [tripEntries, tripsById, q]);

  const finishRename = async (save: boolean) => {
    const r = renaming;
    setRenaming(null);
    if (!r || !save) return;
    if (r.kind === "album" && r.value.trim()) await onRenameAlbum(Number(r.id), r.value);
    if (r.kind === "trip") await onRenameTrip(r.id, r.value);
  };

  const visibleAlbums = albums.filter((a) => matches(a.name));
  // Best of each year in the open folder, newest first
  const allYears = useMemo(() => {
    const byYear = new Map<number, PhotoItem[]>();
    for (const p of photoByHash.values()) {
      const y = Number((p.captured_at || "").slice(0, 4));
      if (y >= 1971) byYear.set(y, [...(byYear.get(y) ?? []), p]);
    }
    const starredKey = [...bestOfFocus.starred].sort().join("|");
    return Array.from(byYear, ([year, photos]) => ({
      year,
      photos,
      hashes: photos.map((p) => p.hash),
      // Changes when photos come or go, their stars, flags or people change, or other people are starred:
      // what moves the picks
      signature: `${photos.length}:${photos.reduce(
        (s, p) => s + p.rating * 3 + (p.flag === "pick" ? 1 : p.flag === "reject" ? 2 : 0) + p.people.length * 7,
        0
      )}:${starredKey}`,
    }))
      .filter((y) => y.hashes.length >= 5)
      .sort((a, b) => b.year - a.year);
  }, [photoByHash, bestOfFocus]);
  const years = allYears.filter((y) => matches(`best of ${y.year}`));
  // Each year's cover: its top highlights, so the cover shows photos that are in "Best of" when opened
  const [covers, setCovers] = useState<Record<number, { signature: string; hashes: string[] }>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const y of allYears) {
        if (cancelled) return;
        if (covers[y.year]?.signature === y.signature) continue;
        try {
          const hashes = await pickHighlights(y.photos, 4, bestOfFocus);
          if (!cancelled) setCovers((prev) => ({ ...prev, [y.year]: { signature: y.signature, hashes } }));
        } catch {
          // The card keeps its placeholder
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allYears]);
  const visibleSmart = savedSearches.filter((s) => matches(s.name) || matches(s.query));

  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-7">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold text-zinc-100">Collections</h1>
        <div className="relative w-64">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-zinc-500" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Find an album or trip…"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-2 py-1.5 text-xs text-zinc-200 select-text focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <BookImage className="w-4 h-4 text-indigo-400" /> Albums ({albums.length})
        </h2>
        <div className={sectionGrid}>
          {visibleAlbums.map((a) => (
            <Card
              key={a.id}
              title={a.name}
              subtitle={`${albumCounts.get(a.id) ?? 0} in this folder · ${a.hashes.length} in total`}
              cover={<Cover hashes={a.hashes} photoByHash={photoByHash} icon={<BookImage className="w-8 h-8" />} />}
              onOpen={() => onOpenAlbum(a.id)}
              menu={[
                { label: "Highlights", run: () => onHighlights(a.name, a.hashes.filter((h) => photoByHash.has(h))) },
                { label: "Share as web gallery", run: () => onShareGallery(a.name, a.hashes.filter((h) => photoByHash.has(h))) },
                { label: "Rename", run: () => setRenaming({ kind: "album", id: String(a.id), value: a.name }) },
                { label: "Delete album", danger: true, run: () => onDeleteAlbum(a.id) },
              ]}
              renaming={renaming?.kind === "album" && renaming.id === String(a.id)}
              renameValue={renaming?.value}
              onRenameChange={(v) => setRenaming((r) => (r ? { ...r, value: v } : r))}
              onRenameDone={finishRename}
            />
          ))}
          {newAlbumName === null ? (
            <button
              onClick={() => setNewAlbumName("")}
              className="aspect-[4/3] rounded-xl border-2 border-dashed border-zinc-800 hover:border-indigo-500/50 text-zinc-500 hover:text-indigo-200 flex flex-col items-center justify-center gap-1.5 text-xs"
            >
              <Plus className="w-6 h-6" />
              New album
            </button>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (newAlbumName.trim()) await onCreateAlbum(newAlbumName);
                setNewAlbumName(null);
              }}
              className="aspect-[4/3] rounded-xl border border-indigo-500/50 bg-card p-3 flex flex-col justify-center gap-2"
            >
              <input
                autoFocus
                value={newAlbumName}
                onChange={(e) => setNewAlbumName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") setNewAlbumName(null);
                }}
                placeholder="Album name"
                className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 select-text focus:outline-none focus:border-indigo-500"
              />
              <button type="submit" className="self-end px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs flex items-center gap-1">
                <Check className="w-3 h-3" /> Create
              </button>
              <span className="text-[11px] text-zinc-500">Add photos by right-clicking them → Add to album.</span>
            </form>
          )}
        </div>
      </section>

      {(savedSearches.length > 0 || q === "") && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-300" /> Smart albums ({savedSearches.length})
          </h2>
          {savedSearches.length === 0 ? (
            <span className="text-xs text-zinc-500">
              Search in Photos (for example <code className="text-emerald-300">rating:&gt;=4 person:anna</code>) and click
              "Save as smart album". It stays up to date by itself.
            </span>
          ) : (
            <div className={sectionGrid}>
              {visibleSmart.map((s) => (
                <Card
                  key={s.id}
                  title={s.name}
                  subtitle={s.query}
                  cover={
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-amber-950/40 to-zinc-950 text-amber-300/70">
                      <Sparkles className="w-8 h-8" />
                    </div>
                  }
                  onOpen={() => onOpenSavedSearch(s)}
                  menu={[{ label: "Delete smart album", danger: true, run: () => onDeleteSavedSearch(s.id) }]}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {years.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-300" /> Best of
          </h2>
          <span className="text-xs text-zinc-500 -mt-1">
            {bestOfFocus.starred.size > 0
              ? "Focused on your starred people. Photos of others and photos received through WhatsApp count for less."
              : "Tip: star the people who matter most (People → ⋯ → Star) and Best of focuses on photos of them."}
          </span>
          <div className={sectionGrid}>
            {years.map((y) => (
              <Card
                key={y.year}
                title={`Best of ${y.year}`}
                subtitle={`Highlights from ${y.hashes.length} photos`}
                cover={<Cover hashes={covers[y.year]?.hashes ?? []} photoByHash={photoByHash} icon={<Trophy className="w-8 h-8" />} />}
                onOpen={() => onHighlights(`Best of ${y.year}`, y.hashes, 25, bestOfFocus)}
              />
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <Plane className="w-4 h-4 text-sky-400" /> Trips & events ({tripEntries.length})
        </h2>
        {tripEntries.length === 0 && (
          <span className="text-xs text-zinc-500">Trips and events appear automatically from capture dates and GPS.</span>
        )}
        {tripsByYear.map(([year, entries]) => (
          <div key={year} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-zinc-300">{year || "Undated"}</h3>
            <div className={sectionGrid}>
              {entries.map((e) => (
                <Card
                  key={e.id}
                  title={e.label}
                  subtitle={`${e.kind === "trip" ? "Trip" : "Event"} · ${e.count} photos`}
                  cover={
                    <Cover
                      hashes={tripsById.get(e.id)?.hashes ?? []}
                      photoByHash={photoByHash}
                      icon={e.kind === "trip" ? <Plane className="w-8 h-8" /> : <Calendar className="w-8 h-8" />}
                    />
                  }
                  onOpen={() => onOpenTrip(e.id)}
                  menu={[
                    { label: "Highlights", run: () => onHighlights(e.label, tripsById.get(e.id)?.hashes ?? []) },
                    { label: "Share as web gallery", run: () => onShareGallery(e.label, tripsById.get(e.id)?.hashes ?? []) },
                    { label: "Rename", run: () => setRenaming({ kind: "trip", id: e.id, value: "" }) },
                  ]}
                  renaming={renaming?.kind === "trip" && renaming.id === e.id}
                  renameValue={renaming?.value}
                  onRenameChange={(v) => setRenaming((r) => (r ? { ...r, value: v } : r))}
                  onRenameDone={finishRename}
                />
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
