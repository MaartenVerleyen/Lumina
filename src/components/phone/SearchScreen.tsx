import { useMemo, useRef, useState } from "react";
import { ChevronRight, Clock, Map as MapIcon, Search, Sparkles, UserRound, Users, X } from "lucide-react";
import { mediaUrl } from "../../api";
import { useAccess } from "../auth/ServerGate";
import type { LibraryState } from "../../hooks/useLibraryState";
import type { PhotoItem } from "../../types/lumina";
import { thumbSrc } from "../../utils/photoHelpers";

// The phone app's Search tab (docs/plans/android-app-ui.md): a search field with smart search, and an explore
// page of people, places and things to tap; results open in a grid of their own

const RECENT_KEY = "lumina_recent_searches";
let lastText = "";

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

export default function SearchScreen({
  lib,
  onSearch,
  onPerson,
  onPeople,
  onMap,
  onGroups,
}: {
  lib: LibraryState;
  // Results show in a grid screen of their own
  onSearch: (query: string) => void;
  onPerson: (name: string) => void;
  onPeople: () => void;
  onMap: () => void;
  onGroups: () => void;
}) {
  const canEdit = useAccess().edit;
  const input = useRef<HTMLInputElement>(null);
  // What was searched for last stays in the field when its results are closed again
  const [text, setTextState] = useState(lastText);
  const setText = (value: string) => {
    lastText = value;
    setTextState(value);
  };
  const [recent, setRecent] = useState(recentSearches);
  const people = useNamedPeople(lib);
  const places = useMemo(() => topOf(lib.photos, (p) => (p.location ? [p.location.split(",")[0].trim()] : []), 15), [lib.photos]);
  const things = useMemo(() => topOf(lib.photos, (p) => p.tags, 18), [lib.photos]);
  const pendingTotal = people.reduce((n, p) => n + (lib.pendingFaceCounts[p.name] ?? 0), 0);

  const search = (query: string) => {
    const q = query.trim();
    if (!q) return;
    remember(q);
    setRecent(recentSearches());
    onSearch(q);
  };

  return (
    <div className="flex-1 overflow-y-auto overscroll-contain pb-6">
      <form
        className="flex items-center gap-2 px-3 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          input.current?.blur();
          search(text);
        }}
      >
        <div className={`flex-1 flex items-center gap-2 h-11 rounded-full px-4 border ${lib.smartSearch ? "border-indigo-500/60" : "border-zinc-700"} bg-zinc-900`}>
          <Search className="w-4 h-4 text-zinc-500 shrink-0" />
          <input
            ref={input}
            type="search"
            enterKeyHint="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={lib.smartSearch ? "Describe a photo" : "Search your photos"}
            className="flex-1 min-w-0 bg-transparent text-base text-zinc-100 placeholder-zinc-500 outline-none"
          />
          {text && (
            <button type="button" onClick={() => setText("")} className="text-zinc-500" aria-label="Clear search">
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
        <Row title="People" onAll={onPeople}>
          {canEdit && pendingTotal > 0 && (
            <button onClick={onPeople} className="mx-4 mb-2 flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-3 py-1 text-xs text-emerald-200 active:bg-emerald-500/30">
              {pendingTotal} {pendingTotal === 1 ? "face" : "faces"} to check
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
          <Scroller>
            {people.slice(0, 12).map((p) => (
              <div key={p.id} className="w-[72px] shrink-0">
                <Face name={p.name} thumb={p.cover_thumb} onClick={() => onPerson(p.name)} />
              </div>
            ))}
          </Scroller>
        </Row>
      )}

      {people.length === 0 && canEdit && (
        <Row title="People">
          <div className="mx-3 rounded-2xl bg-raised/70 border border-zinc-800">
            <GroupsButton title="Name the people in your photos" onClick={onGroups} />
          </div>
        </Row>
      )}

      <Row title="Places" onAll={onMap}>
        <Scroller>
          <button onClick={onMap} className="w-28 shrink-0 text-left active:opacity-70">
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

// The named people with photos: the starred first, then those in the most photos
function useNamedPeople(lib: LibraryState) {
  return useMemo(
    () => lib.people.filter((p) => !p.hidden && p.photo_count > 0).sort((a, b) => Number(b.starred) - Number(a.starred) || b.photo_count - a.photo_count),
    [lib.people]
  );
}

// The People tab: the faces to check first (those the server thinks are someone already named, and the groups
// without a name), then everyone. A person opens their photos, the badge on them the faces to check.
export function PeopleScreen({
  lib,
  onPerson,
  onReview,
  onGroups,
}: {
  lib: LibraryState;
  onPerson: (name: string) => void;
  onReview: (name: string) => void;
  onGroups: () => void;
}) {
  const canEdit = useAccess().edit;
  const people = useNamedPeople(lib);
  const pendingOf = (name: string) => lib.pendingFaceCounts[name] ?? 0;
  const toCheck = people.filter((p) => pendingOf(p.name) > 0).sort((a, b) => pendingOf(b.name) - pendingOf(a.name));
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain pb-6">
      {canEdit && (
        <div className="mx-3 mt-3 rounded-2xl bg-raised/70 border border-zinc-800 divide-y divide-zinc-800">
          {toCheck.slice(0, 5).map((p) => (
            <button key={p.id} onClick={() => onReview(p.name)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left active:bg-white/5">
              <FaceThumb thumb={p.cover_thumb} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-zinc-100 truncate">Is this {p.name}?</span>
                <span className="block text-xs text-zinc-500">
                  {pendingOf(p.name)} {pendingOf(p.name) === 1 ? "face" : "faces"} to check
                </span>
              </span>
              <ChevronRight className="w-4 h-4 text-zinc-500" />
            </button>
          ))}
          <GroupsButton title="Without a name" onClick={onGroups} />
        </div>
      )}
      {people.length === 0 ? (
        <div className="p-8 text-center text-sm text-zinc-400">Nobody has a name yet.</div>
      ) : (
        <div className="grid grid-cols-3 min-[520px]:grid-cols-5 gap-x-2 gap-y-4 p-3">
          {people.map((p) => (
            <Face
              key={p.id}
              name={p.name}
              thumb={p.cover_thumb}
              count={p.photo_count}
              pending={canEdit ? pendingOf(p.name) : 0}
              onClick={() => onPerson(p.name)}
              onPending={() => onReview(p.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupsButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-3 py-2.5 text-left active:bg-white/5">
      <span className="w-10 h-10 shrink-0 rounded-full bg-amber-500/15 border border-amber-500/40 flex items-center justify-center">
        <Users className="w-5 h-5 text-amber-300" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-zinc-100">{title}</span>
        <span className="block text-xs text-zinc-500">Faces that come back often, to name at once</span>
      </span>
      <ChevronRight className="w-4 h-4 text-zinc-500" />
    </button>
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

function Face({
  name,
  thumb,
  count,
  pending = 0,
  onClick,
  onPending,
}: {
  name: string;
  thumb?: string | null;
  count?: number;
  // Faces the server thinks are this person too: the badge opens them to check
  pending?: number;
  onClick: () => void;
  onPending?: () => void;
}) {
  return (
    <div className="relative w-full">
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
      {pending > 0 && onPending && (
        <button
          onClick={onPending}
          aria-label={`Check ${pending} faces for ${name}`}
          className="absolute top-0 right-0 min-w-7 h-7 px-1.5 rounded-full bg-emerald-600 border-2 border-surface text-[11px] font-semibold text-white active:bg-emerald-700"
        >
          +{pending}
        </button>
      )}
    </div>
  );
}

function FaceThumb({ thumb }: { thumb?: string | null }) {
  return (
    <span className="w-10 h-10 shrink-0 rounded-full overflow-hidden bg-zinc-800">
      {thumb ? <img src={mediaUrl({ kind: "face", path: thumb })} alt="" loading="lazy" className="w-full h-full object-cover" /> : null}
    </span>
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
