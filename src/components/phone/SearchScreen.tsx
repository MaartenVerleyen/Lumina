import { useMemo, useRef, useState } from "react";
import { ArrowLeft, Clock, Map as MapIcon, Search, Sparkles, UserRound, X } from "lucide-react";
import { mediaUrl } from "../../api";
import type { LibraryState } from "../../hooks/useLibraryState";
import type { PhotoItem } from "../../types/lumina";
import { thumbSrc } from "../../utils/photoHelpers";
import PhotoMap from "../views/PhotoMap";

// The phone app's Search tab (docs/plans/android-app-ui.md): a search field with smart search, and an explore
// page of people, places and things to tap; results show in the Photos grid

const RECENT_KEY = "lumina_recent_searches";

function recentSearches(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function remember(query: string) {
  const q = query.trim();
  if (!q) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...recentSearches().filter((x) => x !== q)].slice(0, 8)));
  } catch {}
}

// The most common values of a photo's field, each with a cover: its newest photo that isn't already another
// one's cover (a photo has many tags, and a row of the same photo says nothing)
function topOf(photos: PhotoItem[], valuesOf: (p: PhotoItem) => string[], limit: number): { name: string; count: number; cover: PhotoItem }[] {
  const found = new Map<string, { name: string; count: number; candidates: PhotoItem[] }>();
  for (const p of photos) {
    for (const v of valuesOf(p)) {
      let entry = found.get(v);
      if (!entry) found.set(v, (entry = { name: v, count: 0, candidates: [] }));
      entry.count++;
      if (p.thumb_ready) entry.candidates.push(p);
    }
  }
  const used = new Set<string>();
  return [...found.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .filter((e) => e.candidates.length > 0)
    .map((e) => {
      const newest = [...e.candidates].sort((a, b) => (b.captured_at > a.captured_at ? 1 : -1));
      const cover = newest.find((p) => !used.has(p.hash)) ?? newest[0];
      used.add(cover.hash);
      return { name: e.name, count: e.count, cover };
    });
}

export default function SearchScreen({ lib, onSearch, onOpenPhoto }: { lib: LibraryState; onSearch: () => void; onOpenPhoto: (hash: string) => void }) {
  const [view, setView] = useState<"explore" | "people" | "map">("explore");
  const input = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState(recentSearches);
  const people = useMemo(
    () => lib.people.filter((p) => !p.hidden && p.photo_count > 0).sort((a, b) => Number(b.starred) - Number(a.starred) || b.photo_count - a.photo_count),
    [lib.people]
  );
  const places = useMemo(() => topOf(lib.photos, (p) => (p.location ? [p.location.split(",")[0].trim()] : []), 15), [lib.photos]);
  const things = useMemo(() => topOf(lib.photos, (p) => p.tags, 18), [lib.photos]);

  const search = (query: string) => {
    lib.clearAllFilters();
    lib.setSearchQuery(query);
    remember(query);
    setRecent(recentSearches());
    onSearch();
  };
  const showPerson = (name: string) => {
    lib.clearAllFilters();
    lib.setPeopleFilter({ person: name });
    onSearch();
  };

  if (view === "people") {
    return (
      <SubPage title="People" onBack={() => setView("explore")}>
        <div className="grid grid-cols-3 min-[520px]:grid-cols-5 gap-x-2 gap-y-4 p-3">
          {people.map((p) => (
            <Face key={p.id} name={p.name} thumb={p.cover_thumb} count={p.photo_count} onClick={() => showPerson(p.name)} />
          ))}
        </div>
      </SubPage>
    );
  }
  if (view === "map") {
    return (
      <SubPage title="Places" onBack={() => setView("explore")}>
        <div className="flex-1 min-h-0 flex flex-col">
          <PhotoMap photos={lib.photos} onSelectPhoto={onOpenPhoto} />
        </div>
      </SubPage>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto overscroll-contain pb-6">
      <form
        className="flex items-center gap-2 px-3 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          input.current?.blur();
          search(lib.searchQuery);
        }}
      >
        <div className={`flex-1 flex items-center gap-2 h-11 rounded-full px-4 border ${lib.smartSearch ? "border-indigo-500/60" : "border-zinc-700"} bg-zinc-900`}>
          <Search className="w-4 h-4 text-zinc-500 shrink-0" />
          <input
            ref={input}
            type="search"
            enterKeyHint="search"
            value={lib.searchQuery}
            onChange={(e) => lib.setSearchQuery(e.target.value)}
            placeholder={lib.smartSearch ? "Describe a photo" : "Search your photos"}
            className="flex-1 min-w-0 bg-transparent text-base text-zinc-100 placeholder-zinc-500 outline-none"
          />
          {lib.searchQuery && (
            <button type="button" onClick={() => lib.setSearchQuery("")} className="text-zinc-500" aria-label="Clear search">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={lib.toggleSmartSearch}
          aria-pressed={lib.smartSearch}
          aria-label="Smart search"
          className={`h-11 w-11 shrink-0 rounded-full flex items-center justify-center border ${
            lib.smartSearch ? "bg-indigo-600 border-indigo-500 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-300"
          }`}
        >
          <Sparkles className="w-4 h-4" />
        </button>
      </form>
      {lib.smartSearch && <p className="px-5 pt-2 text-[11px] text-zinc-500">Smart search: describe what's in the photo, as “dog in the snow”.</p>}

      {recent.length > 0 && (
        <Row title="Recent">
          <div className="flex flex-wrap gap-2 px-4">
            {recent.map((q) => (
              <button key={q} onClick={() => search(q)} className="flex items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 active:bg-zinc-700">
                <Clock className="w-3 h-3 text-zinc-500" />
                {q}
              </button>
            ))}
          </div>
        </Row>
      )}

      {people.length > 0 && (
        <Row title="People" onAll={() => setView("people")}>
          <Scroller>
            {people.slice(0, 12).map((p) => (
              <div key={p.id} className="w-[72px] shrink-0">
                <Face name={p.name} thumb={p.cover_thumb} onClick={() => showPerson(p.name)} />
              </div>
            ))}
          </Scroller>
        </Row>
      )}

      <Row title="Places" onAll={() => setView("map")}>
        <Scroller>
          <button onClick={() => setView("map")} className="w-28 shrink-0 text-left active:opacity-70">
            <div className="aspect-square rounded-xl bg-emerald-900/40 border border-emerald-700/40 flex items-center justify-center">
              <MapIcon className="w-8 h-8 text-emerald-300" />
            </div>
            <div className="pt-1.5 text-sm text-zinc-100">Map</div>
          </button>
          {places.map((p) => (
            <Tile key={p.name} photo={p.cover} title={p.name} onClick={() => search(p.name)} />
          ))}
        </Scroller>
      </Row>

      {things.length > 0 && (
        <Row title="Things">
          <div className="grid grid-cols-3 gap-2 px-3">
            {things.map((t) => (
              <Tile key={t.name} photo={t.cover} title={t.name} onClick={() => search(t.name)} grid />
            ))}
          </div>
        </Row>
      )}
    </div>
  );
}

function SubPage({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 h-12 flex items-center gap-1 px-2 border-b border-zinc-800/80">
        <button onClick={onBack} className="p-2 rounded-full text-zinc-300 active:bg-white/10" aria-label="Back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="text-[15px] font-semibold text-zinc-100">{title}</div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col">{children}</div>
    </div>
  );
}

function Row({ title, onAll, children }: { title: string; onAll?: () => void; children: React.ReactNode }) {
  return (
    <section className="pt-5">
      <div className="flex items-center justify-between px-4 pb-2">
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {onAll && (
          <button onClick={onAll} className="text-xs text-emerald-400">
            All
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Scroller({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{children}</div>;
}

function Face({ name, thumb, count, onClick }: { name: string; thumb?: string | null; count?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex flex-col items-center gap-1.5 active:opacity-70">
      <div className="w-full aspect-square rounded-full overflow-hidden bg-zinc-800 border border-zinc-700/60">
        {thumb ? (
          <img src={mediaUrl({ kind: "face", path: thumb })} alt="" loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <UserRound className="w-1/2 h-1/2 m-auto mt-[25%] text-zinc-600" />
        )}
      </div>
      <div className="text-xs text-zinc-200 font-medium truncate max-w-full">{name}</div>
      {count !== undefined && <div className="text-[10px] text-zinc-500 -mt-1">{count}</div>}
    </button>
  );
}

function Tile({ photo, title, onClick, grid }: { photo: PhotoItem; title: string; onClick: () => void; grid?: boolean }) {
  return (
    <button onClick={onClick} className={`${grid ? "w-full" : "w-28 shrink-0"} relative text-left active:opacity-70`}>
      <div className="aspect-square rounded-xl overflow-hidden bg-zinc-800">
        {photo.thumb_ready && <img src={thumbSrc(photo)} alt="" loading="lazy" className="w-full h-full object-cover" />}
      </div>
      {grid ? (
        <div className="absolute inset-x-0 bottom-0 rounded-b-xl bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-5 text-xs font-semibold text-white truncate">
          {title}
        </div>
      ) : (
        <div className="pt-1.5 text-sm text-zinc-100 truncate">{title}</div>
      )}
    </button>
  );
}
