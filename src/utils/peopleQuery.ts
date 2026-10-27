// People search box: "anna and bob" (photos with both), "anna or bob" (with either), or one name.
// Each part is matched against the known people; the last part may still be being typed.

export type PeopleMatch = "all" | "any";

export interface PeopleQuery {
  // The parts as typed, each with the person it matches (null: no or several people match)
  parts: { text: string; person: string | null }[];
  // Set only when the query joins parts with and/or (one kind per query: the first one used wins)
  mode: PeopleMatch | null;
}

const AND = /^(and|en|&|&&|\+)$/i;
const OR = /^(or|of|\||\|\||,)$/i;

// Exact name first, then the only name starting with the text, then the only name containing it
export function resolvePerson(text: string, names: string[]): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const exact = names.find((n) => n.toLowerCase() === t);
  if (exact) return exact;
  const starts = names.filter((n) => n.toLowerCase().startsWith(t));
  if (starts.length === 1) return starts[0];
  const contains = names.filter((n) => n.toLowerCase().includes(t));
  return contains.length === 1 ? contains[0] : null;
}

export function parsePeopleQuery(query: string, names: string[]): PeopleQuery {
  // "&", "|", "+" and "," also work without spaces around them
  const tokens = query.replace(/(&&|\|\||[&|+,])/g, " $1 ").split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  let current: string[] = [];
  let mode: PeopleMatch | null = null;
  for (const tok of tokens) {
    const op: PeopleMatch | null = AND.test(tok) ? "all" : OR.test(tok) ? "any" : null;
    // An operator word only counts between two names ("and" alone could be the start of "Andy")
    if (op && current.length > 0) {
      parts.push(current.join(" "));
      current = [];
      mode ??= op;
    } else {
      current.push(tok);
    }
  }
  if (current.length > 0) parts.push(current.join(" "));
  return { parts: parts.map((text) => ({ text, person: resolvePerson(text, names) })), mode };
}

// Whether a photo with these people passes the filter
export function matchesPeople(photoPeople: string[], wanted: string[], match: PeopleMatch): boolean {
  if (wanted.length === 0) return true;
  const have = new Set(photoPeople.map((n) => n.toLowerCase()));
  return match === "all" ? wanted.every((n) => have.has(n.toLowerCase())) : wanted.some((n) => have.has(n.toLowerCase()));
}

// "Anna", "Anna and Bob", "Anna, Bob or Carl"
export function describePeople(names: string[], match: PeopleMatch): string {
  if (names.length <= 1) return names[0] ?? "";
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(", ")} ${match === "all" ? "and" : "or"} ${last}`;
}
