import { useEffect, useMemo, useRef, useState } from "react";
import {
  acceptNameSuggestion,
  allPhotosNameSuggestions,
  allPhotosPersonParts,
  dismissNameSuggestion,
  dropOwnNames,
  mediaUrl,
  openLibraryIsAll,
  setPersonApart,
} from "../../api";
import type { NameSuggestion } from "../../api/allPhotos";
import { PersonName } from "../people/PersonName";
import { useAccess } from "../auth/ServerGate";
import { ChevronDown, ChevronRight, Search, Star, User, Users, X } from "lucide-react";
import { PersonItem } from "../../types/lumina";
import {
  combinePeople,
  describePeopleExpr,
  flatPeople,
  parsePeopleExpr,
  PeopleExpr,
  peopleExprFromList,
  peopleInExpr,
  PeopleMatch,
  removeFromExpr,
} from "../../utils/peopleQuery";

interface PeopleSidebarProps {
  width: number;
  people: PersonItem[];
  pendingCounts: Record<string, number>;
  // Photos in the library (the "Everyone" row)
  totalPhotos: number;
  // The people filter on the photos (null = everyone)
  filter: PeopleExpr | null;
  onChange: (filter: PeopleExpr | null) => void;
  // Open Face Review for one person's suggested matches, or for "Who is this?"
  onReview: (name: string) => void;
  onWhoIsThis: () => void;
  onChooseCover: (name: string) => void;
  onRename: (oldName: string, newName: string) => Promise<string | null>;
  onSetHidden: (name: string, hidden: boolean) => Promise<void>;
  // Starred people come first and Best of focuses on them
  onSetStarred: (name: string, starred: boolean) => Promise<void>;
  // Collapsed list sections ("people-hidden"), remembered with the layout
  collapsedSections: string[];
  onToggleSection: (id: string) => void;
  // All photos: names of one's own or "not the same person" changed, so people and photos are listed again
  onNamesChanged?: () => void;
}

type MenuState = { name: string; x: number; y: number; mode: "menu" | "rename" | "merge" };

// The People tab's left pane: search (combine people with and / or / not and brackets), everyone with their photo count,
// a pill for suggested matches and a menu per person (right-click or ⋯)
export default function PeopleSidebar({
  width,
  people,
  pendingCounts,
  totalPhotos,
  filter,
  onChange,
  onReview,
  onWhoIsThis,
  onChooseCover,
  onRename,
  onSetHidden,
  onSetStarred,
  collapsedSections,
  onToggleSection,
  onNamesChanged,
}: PeopleSidebarProps) {
  // Naming, starring, hiding and reviewing are editing; someone who may only look gets the list and search
  const access = useAccess();
  // In All photos anyone may give people of a library they only look at a name of their own
  const isAll = openLibraryIsAll();
  const canName = access.edit || isAll;
  // All photos: people of two libraries who look alike under different names
  const [suggestions, setSuggestions] = useState<NameSuggestion[]>([]);
  useEffect(() => {
    if (!isAll) {
      setSuggestions([]);
      return;
    }
    let stale = false;
    allPhotosNameSuggestions()
      .then((list) => !stale && setSuggestions(list))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [isAll, people]);
  const labelOf = (engine: string, name: string) => allPhotosPersonParts(name).find((x) => x.engine === engine)?.label ?? "";
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [menuInput, setMenuInput] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const names = useMemo(() => people.map((p) => p.name), [people]);
  const parsed = useMemo(() => parsePeopleExpr(query, names), [query, names]);
  // A plain list ("Anna and Bob") shows as chips; a nested query as one chip
  const flat = flatPeople(filter);
  const selected = flat?.names ?? [];
  const match: PeopleMatch = flat?.match ?? "all";
  const named = peopleInExpr(filter).map((n) => n.toLowerCase());
  const isSelected = (name: string) => named.includes(name.toLowerCase());

  // The list follows the name being typed ("(anna or bob) and el" lists the people matching "el")
  const listed = useMemo(() => {
    const t = parsed.typing.toLowerCase();
    return t ? people.filter((p) => p.name.toLowerCase().includes(t)) : people;
  }, [people, parsed.typing]);
  const visible = [...listed.filter((p) => !p.hidden && p.starred), ...listed.filter((p) => !p.hidden && !p.starred)];
  const hidden = listed.filter((p) => p.hidden);

  // What Enter does: one name adds that person (the first one listed when the name is ambiguous),
  // a query with and / or / not / brackets replaces the filter
  const hasOperators = /[()&|+,!]|(^|\s)-|\b(and|or|en|of|not|niet)\b/i.test(query);
  const enterTarget = hasOperators
    ? null
    : parsed.expr && "person" in parsed.expr
    ? parsed.expr.person
    : visible[0]?.name ?? hidden[0]?.name ?? null;
  let hint = "";
  let hintIsError = false;
  if (query.trim()) {
    if (enterTarget) {
      hint = flat && selected.length > 0 && !isSelected(enterTarget) ? `Enter: add ${enterTarget}` : `Enter: show ${enterTarget}`;
    } else if (parsed.expr) {
      hint = `Enter: photos with ${describePeopleExpr(parsed.expr)}`;
    } else {
      hint = parsed.error ?? "No one with that name";
      hintIsError = !parsed.incomplete;
    }
  }

  const setList = (list: string[], m: PeopleMatch) => onChange(peopleExprFromList(list, m));
  const toggle = (name: string) => {
    if (isSelected(name)) onChange(removeFromExpr(filter, name));
    else if (flat) setList([...selected, name], match);
    else onChange(combinePeople("all", [filter!, { person: name }]));
  };

  function submitQuery() {
    if (enterTarget) {
      if (flat && !isSelected(enterTarget)) setList([...selected, enterTarget], match);
      else if (!flat) onChange({ person: enterTarget });
      setQuery("");
    } else if (parsed.expr) {
      onChange(parsed.expr);
      setQuery("");
    }
  }

  // The menu closes on an outside click or Escape
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openMenu = (name: string, x: number, y: number) => {
    // Keep the menu on screen (it is about 240 x 300 px)
    setMenu({ name, x: Math.min(x, window.innerWidth - 250), y: Math.min(y, window.innerHeight - 310), mode: "menu" });
    setMenuInput("");
  };

  const avatar = (p: PersonItem, size = "w-9 h-9") =>
    p.cover_thumb ? (
      <img
        src={mediaUrl({ kind: "face", path: p.cover_thumb })}
        alt=""
        loading="lazy"
        className={`${size} rounded-full object-cover border border-zinc-700 shrink-0`}
      />
    ) : (
      <div className={`${size} rounded-full bg-zinc-800 flex items-center justify-center shrink-0`}>
        <User className="w-4 h-4 text-zinc-400" />
      </div>
    );

  const row = (p: PersonItem) => {
    const on = isSelected(p.name);
    const pending = pendingCounts[p.name] || 0;
    return (
      <div
        key={p.name}
        onContextMenu={(e) => {
          e.preventDefault();
          if (canName) openMenu(p.name, e.clientX, e.clientY);
        }}
        className={`@container group relative flex items-center gap-2 pl-1.5 pr-1 py-1 rounded-xl border transition ${
          on ? "bg-emerald-500/15 border-emerald-500/40" : "border-transparent hover:bg-zinc-900"
        } ${p.hidden ? "opacity-60" : ""}`}
      >
        <input
          type="checkbox"
          checked={on}
          onChange={() => toggle(p.name)}
          aria-label={`Combine ${p.name} with the other selected people`}
          title="Add to / remove from the selection (combine people)"
          className={`accent-emerald-500 shrink-0 ${on || filter ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
        />
        <button
          onClick={(e) => {
            // Ctrl/Cmd+click combines, a plain click shows just this person (again: everyone)
            if (e.ctrlKey || e.metaKey) toggle(p.name);
            else onChange(on && flat && selected.length === 1 ? null : { person: p.name });
          }}
          className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
          title="Click: show their photos · Ctrl+click: combine with others"
        >
          <span className="relative shrink-0">
            {avatar(p)}
            {/* In a narrow panel the count rides on the avatar, so the name keeps its room (review via ⋯) */}
            {pending > 0 && (
              <span className="@[17rem]:hidden absolute -top-1 -right-1.5 min-w-4 px-1 rounded-full bg-amber-500 text-zinc-950 text-[10px] font-semibold leading-4 text-center">
                {pending}
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className={`flex items-baseline gap-1 min-w-0 text-xs font-semibold ${on ? "text-emerald-100" : "text-zinc-200"}`}>
              <PersonName name={p.name} />
            </span>
            <span className="block text-[11px] text-zinc-500 truncate">
              {p.photo_count} photo{p.photo_count === 1 ? "" : "s"}
            </span>
          </span>
        </button>
        {pending > 0 && access.edit && (
          <button
            onClick={() => onReview(p.name)}
            className="hidden @[17rem]:block shrink-0 px-2 py-0.5 rounded-full bg-amber-500/15 hover:bg-amber-500/30 border border-amber-400/40 text-amber-300 text-[11px] font-semibold"
            title={`Review ${pending} suggested match${pending === 1 ? "" : "es"} for ${p.name}`}
          >
            {pending} to review
          </button>
        )}
        {!p.hidden && !access.edit && p.starred && (
          <Star className="w-3.5 h-3.5 shrink-0 text-amber-300 fill-current" aria-label="Starred" />
        )}
        {!p.hidden && access.edit && (
          <button
            onClick={() => onSetStarred(p.name, !p.starred)}
            className={`shrink-0 p-0.5 rounded hover:bg-zinc-800 ${
              p.starred ? "text-amber-300" : "text-zinc-500 hover:text-amber-300 opacity-0 group-hover:opacity-100 focus:opacity-100"
            }`}
            aria-label={p.starred ? `Unstar ${p.name}` : `Star ${p.name}`}
            aria-pressed={p.starred}
            title={p.starred ? "Starred: Best of focuses on their photos (click to unstar)" : "Star: Best of focuses on their photos"}
          >
            <Star className={`w-3.5 h-3.5 ${p.starred ? "fill-current" : ""}`} />
          </button>
        )}
        {canName && (
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(p.name, r.left, r.bottom + 4);
          }}
          className="shrink-0 px-1.5 py-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 focus:opacity-100"
          aria-label={`Options for ${p.name}`}
        >
          ⋯
        </button>
        )}
      </div>
    );
  };

  const menuPerson = menu ? people.find((p) => p.name === menu.name) : undefined;
  // All photos: the libraries the person comes from; one only looked at can get a name of one's own, no more
  const parts = isAll && menuPerson ? allPhotosPersonParts(menuPerson.name) : [];
  const onlyLooking = parts.length > 0 && parts.every((x) => !x.editable);
  const namesAction = (run: () => Promise<void>) => () => {
    setMenu(null);
    run()
      .then(() => onNamesChanged?.())
      .catch((e) => console.error(e));
  };
  const menuItem = "w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200";
  const hiddenCollapsed = collapsedSections.includes("people-hidden");

  return (
    <aside style={{ width }} className="bg-panel flex flex-col shrink-0 min-h-0 overflow-hidden">
      {/* Search: one name, or several joined with "and" / "or" */}
      <div className="p-3 border-b border-zinc-800/60 flex flex-col gap-2">
        <div
          onClick={() => inputRef.current?.focus()}
          className="flex flex-wrap items-center gap-1 bg-zinc-950 border border-zinc-800 focus-within:border-emerald-500/60 rounded-lg px-2 py-1.5 cursor-text"
        >
          <Search className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          {selected.map((name, i) => (
            <span key={name} className="flex items-center gap-1">
              {i > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setList(selected, match === "all" ? "any" : "all");
                  }}
                  className="px-1 rounded text-xs font-medium text-amber-300 hover:bg-zinc-800"
                  title="Switch between and (photos with all of them) and or (with any of them)"
                >
                  {match === "all" ? "and" : "or"}
                </button>
              )}
              <span className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 text-[11px] capitalize">
                {name}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(name);
                  }}
                  className="hover:text-white"
                  aria-label={`Remove ${name}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            </span>
          ))}
          {filter && !flat && (
            <span className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 text-[11px] capitalize max-w-full">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setQuery(describePeopleExpr(filter));
                  inputRef.current?.focus();
                }}
                className="text-left truncate hover:text-white"
                title="Edit this query"
              >
                {describePeopleExpr(filter)}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
                className="hover:text-white shrink-0"
                aria-label="Show everyone"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitQuery();
              } else if (e.key === "Escape") {
                if (query) setQuery("");
                else (e.target as HTMLInputElement).blur();
              } else if (e.key === "Backspace" && !query && selected.length > 0) {
                setList(selected.slice(0, -1), match);
              }
            }}
            placeholder={filter ? "Add someone…" : "Search people: (anna or bob) and ella"}
            aria-label="Search people"
            className="flex-1 min-w-[80px] bg-transparent text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none select-text"
          />
        </div>
        {hint && <p className={`text-[11px] px-1 ${hintIsError ? "text-red-300" : "text-zinc-500"}`}>{hint}</p>}
        {!query && !filter && (
          <p className="text-[11px] px-1 text-zinc-600">Combine with and, or, not and brackets</p>
        )}
        {selected.length > 1 && (
          <div className="flex bg-zinc-950 border border-zinc-800 rounded-lg p-0.5 text-[11px]">
            {(["all", "any"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setList(selected, m)}
                className={`flex-1 px-2 py-1 rounded-md font-medium ${
                  match === m ? "bg-emerald-500/20 text-emerald-200" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {m === "all" ? "Together (and)" : "Any of them (or)"}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">
        {suggestions.length > 0 && (
          <div className="mb-2 p-2 rounded-xl border border-sky-500/30 bg-sky-950/20 flex flex-col gap-1.5">
            <span className="text-xs font-medium text-sky-300">Maybe the same person</span>
            {suggestions.slice(0, 5).map((sg) => (
              <div key={`${sg.from.engine}|${sg.from.name}`} className="flex flex-col gap-1 text-[11px] text-zinc-300">
                <span>
                  <span className="font-semibold inline-flex items-baseline gap-1">
                    <PersonName name={sg.from.name} />
                  </span>{" "}
                  on {labelOf(sg.from.engine, sg.from.name)} looks like{" "}
                  <span className="font-semibold inline-flex items-baseline gap-1">
                    <PersonName name={sg.to.name} />
                  </span>{" "}
                  on {labelOf(sg.to.engine, sg.to.name)}
                </span>
                <span className="flex gap-1">
                  <button
                    className="px-2 py-0.5 rounded bg-sky-600 hover:bg-sky-500 text-white"
                    title={`Show ${sg.from.name} as ${sg.to.name} (for you only, when on a server)`}
                    onClick={() =>
                      acceptNameSuggestion(sg)
                        .then(() => onNamesChanged?.())
                        .catch((e) => console.error(e))
                    }
                  >
                    Same person
                  </button>
                  <button
                    className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                    onClick={() => {
                      dismissNameSuggestion(sg);
                      setSuggestions((list) => list.filter((x) => x !== sg));
                    }}
                  >
                    Not the same
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={() => onChange(null)}
          className={`flex items-center gap-2.5 px-2 py-1.5 rounded-xl border text-left ${
            !filter ? "bg-emerald-500/15 border-emerald-500/40" : "border-transparent hover:bg-zinc-900"
          }`}
        >
          <div className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center shrink-0">
            <Users className="w-4 h-4 text-emerald-300" />
          </div>
          <span>
            <span className="block text-xs font-semibold text-zinc-200">Everyone</span>
            <span className="block text-[11px] text-zinc-500">{totalPhotos} photos</span>
          </span>
        </button>
        {access.edit && (
        <button
          onClick={onWhoIsThis}
          className="flex items-center gap-2.5 px-2 py-1.5 rounded-xl border border-transparent hover:bg-zinc-900 text-left"
          title="Groups of unnamed faces that look like the same person"
        >
          <div className="w-9 h-9 rounded-full bg-zinc-800/80 border border-zinc-700 flex items-center justify-center shrink-0">
            <Users className="w-4 h-4 text-zinc-400" />
          </div>
          <span>
            <span className="block text-xs font-semibold text-zinc-200">Who is this?</span>
            <span className="block text-[11px] text-zinc-500">Name unknown faces</span>
          </span>
        </button>
        )}

        <span className="px-2 pt-3 pb-1 text-xs font-medium text-zinc-500">
          People ({visible.length})
        </span>
        {visible.map(row)}
        {visible.length === 0 && (
          <p className="px-2 py-2 text-[11px] text-zinc-500">
            {people.length === 0 ? "No one named yet: use “Who is this?” or Scan faces." : "No one matches."}
          </p>
        )}

        {hidden.length > 0 && (
          <>
            <button
              onClick={() => onToggleSection("people-hidden")}
              aria-expanded={!hiddenCollapsed}
              className="flex items-center gap-1 px-2 pt-3 pb-1 text-xs font-medium text-zinc-500 hover:text-zinc-300"
            >
              {hiddenCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Hidden ({hidden.length})
            </button>
            {!hiddenCollapsed && hidden.map(row)}
          </>
        )}
      </div>

      {menu && menuPerson && (
        <div
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-[9990] w-60 bg-raised border border-zinc-700/80 rounded-xl shadow-2xl p-1.5 text-xs flex flex-col gap-0.5"
        >
          {menu.mode === "menu" ? (
            <>
              <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 mb-1">
                {avatar(menuPerson, "w-6 h-6")}
                <span className="font-semibold text-zinc-100 capitalize truncate">{menuPerson.name}</span>
              </div>
              {parts.length > 0 && (
                <div className="px-2.5 pb-1 text-[11px] text-zinc-500">
                  In{" "}
                  {parts
                    .map((x) => (x.name.toLowerCase() === menuPerson.name.toLowerCase() || x.engine === "" ? x.label : `${x.label} (as ${x.name})`))
                    .join(" · ")}
                </div>
              )}
              <button
                className={menuItem}
                onClick={() => {
                  onChange({ person: menuPerson.name });
                  setMenu(null);
                }}
              >
                Show their photos
              </button>
              <button
                className={menuItem}
                onClick={() => {
                  toggle(menuPerson.name);
                  setMenu(null);
                }}
              >
                {isSelected(menuPerson.name) ? "Remove from the selection" : "Add to the selection"}
              </button>
              {(pendingCounts[menuPerson.name] || 0) > 0 && !onlyLooking && (
                <button
                  className={menuItem}
                  onClick={() => {
                    onReview(menuPerson.name);
                    setMenu(null);
                  }}
                >
                  Review {pendingCounts[menuPerson.name]} suggested matches…
                </button>
              )}
              <div className="h-px bg-zinc-800 my-1" />
              {!menuPerson.hidden && !onlyLooking && (
                <button
                  className={menuItem}
                  onClick={() => {
                    onSetStarred(menuPerson.name, !menuPerson.starred);
                    setMenu(null);
                  }}
                >
                  {menuPerson.starred ? "Unstar" : "Star (Best of focuses on them)"}
                </button>
              )}
              {!onlyLooking && (
                <button
                  className={menuItem}
                  onClick={() => {
                    onChooseCover(menuPerson.name);
                    setMenu(null);
                  }}
                >
                  Choose profile picture…
                </button>
              )}
              <button
                className={menuItem}
                onClick={() => {
                  setMenu({ ...menu, mode: "rename" });
                  setMenuInput(menuPerson.name);
                }}
              >
                {onlyLooking ? "Call this person…" : "Rename…"}
              </button>
              {people.length > 1 && (
                <button className={menuItem} onClick={() => setMenu({ ...menu, mode: "merge" })}>
                  Merge into…
                </button>
              )}
              {new Set(parts.map((x) => x.engine)).size > 1 && !parts.some((x) => x.apart) && (
                <button
                  className={menuItem}
                  onClick={namesAction(() => setPersonApart(menuPerson.name, true))}
                  title="Two different people with the same name: each shows with the name of its library"
                >
                  Not the same person
                </button>
              )}
              {parts.some((x) => x.apart) && (
                <button className={menuItem} onClick={namesAction(() => setPersonApart(menuPerson.name, false))}>
                  The same person after all
                </button>
              )}
              {parts.some((x) => x.shownAs) && (
                <button className={menuItem} onClick={namesAction(() => dropOwnNames(menuPerson.name))}>
                  Use their name again ({parts.filter((x) => x.shownAs).map((x) => x.name).join(", ")})
                </button>
              )}
              {!onlyLooking && (
                <button
                  className={menuItem}
                  onClick={() => {
                    onSetHidden(menuPerson.name, !menuPerson.hidden);
                    setMenu(null);
                  }}
                >
                  {menuPerson.hidden ? "Show again" : "Hide (no suggestions)"}
                </button>
              )}
            </>
          ) : menu.mode === "rename" ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await onRename(menuPerson.name, menuInput);
                setMenu(null);
              }}
              className="flex gap-1 p-1"
            >
              <input
                autoFocus
                value={menuInput}
                onChange={(e) => setMenuInput(e.target.value)}
                aria-label="New name"
                className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-zinc-200 select-text focus:outline-none focus:border-emerald-500"
              />
              <button type="submit" className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white">
                OK
              </button>
            </form>
          ) : (
            <div className="flex flex-col max-h-64 overflow-y-auto">
              <span className="px-2 py-1 text-[11px] text-zinc-500">
                Merge "<span className="capitalize">{menuPerson.name}</span>" into:
              </span>
              {people
                .filter((o) => o.name !== menuPerson.name)
                .map((o) => (
                  <button
                    key={o.name}
                    onClick={async () => {
                      await onRename(menuPerson.name, o.name);
                      setMenu(null);
                    }}
                    className={`${menuItem} capitalize flex items-center gap-2`}
                  >
                    {avatar(o, "w-5 h-5")}
                    {o.name}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
