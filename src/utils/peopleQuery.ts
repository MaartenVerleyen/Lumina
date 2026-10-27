// People filter: "anna", "anna and bob", "(anna or bob) and (ella or james)", "anna and not bob".
// Precedence: not > and > or; brackets group. Names may be partial as long as only one person matches.
// Also understood: & + en (and), | , of (or), ! - niet (not).

export type PeopleMatch = "all" | "any";

export type PeopleExpr =
  | { person: string }
  | { not: PeopleExpr }
  | { op: PeopleMatch; items: PeopleExpr[] };

export interface ParsedPeople {
  // null when the query is empty or can't be used yet (see `error`)
  expr: PeopleExpr | null;
  // Why the query can't be used: unknown name, missing name, unbalanced bracket
  error: string | null;
  // True when the query is just unfinished ("anna and", "(anna or bob") rather than wrong
  incomplete: boolean;
  // The name being typed at the end ("" right after an operator or bracket), for the list below the box
  typing: string;
}

const AND = /^(and|en|&|&&|\+)$/i;
const OR = /^(or|of|\||\|\||,)$/i;
const NOT = /^(not|niet|!)$/i;

type Tok = { t: "(" | ")" | "and" | "or" | "not" | "word"; v: string };

function tokenize(query: string): Tok[] {
  const out: Tok[] = [];
  for (const m of query.matchAll(/\(|\)|&&|\|\||[&|+,!]|[^\s()&|+,!]+/g)) {
    const s = m[0];
    if (s === "(" || s === ")") out.push({ t: s, v: s });
    else if (AND.test(s)) out.push({ t: "and", v: s });
    else if (OR.test(s)) out.push({ t: "or", v: s });
    else if (NOT.test(s)) out.push({ t: "not", v: s });
    else if (s.length > 1 && s.startsWith("-")) {
      out.push({ t: "not", v: "-" });
      out.push({ t: "word", v: s.slice(1) });
    } else out.push({ t: "word", v: s });
  }
  return out;
}

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

class QueryError extends Error {
  incomplete: boolean;
  constructor(message: string, incomplete: boolean) {
    super(message);
    this.incomplete = incomplete;
  }
}

// a and (b and c) -> one "and" with three people
export function combinePeople(op: PeopleMatch, items: PeopleExpr[]): PeopleExpr {
  const flat = items.flatMap((e) => ("op" in e && e.op === op ? e.items : [e]));
  return flat.length === 1 ? flat[0] : { op, items: flat };
}

export function parsePeopleExpr(query: string, names: string[]): ParsedPeople {
  const toks = tokenize(query);
  let i = 0;
  let typing = "";
  if (toks.length && toks[toks.length - 1].t === "word") {
    let k = toks.length;
    while (k > 0 && toks[k - 1].t === "word") k--;
    typing = toks.slice(k).map((t) => t.v).join(" ");
  }
  if (toks.length === 0) return { expr: null, error: null, incomplete: true, typing };

  const parseOr = (): PeopleExpr => {
    const items = [parseAnd()];
    while (toks[i]?.t === "or") {
      i++;
      items.push(parseAnd());
    }
    return combinePeople("any", items);
  };
  const parseAnd = (): PeopleExpr => {
    const items = [parseUnary()];
    while (toks[i]?.t === "and") {
      i++;
      items.push(parseUnary());
    }
    return combinePeople("all", items);
  };
  const parseUnary = (): PeopleExpr => {
    const tok = toks[i];
    if (!tok) throw new QueryError("Keep typing: a name is missing", true);
    if (tok.t === "not") {
      i++;
      return { not: parseUnary() };
    }
    if (tok.t === "(") {
      i++;
      const inner = parseOr();
      if (toks[i]?.t !== ")") {
        if (i >= toks.length) throw new QueryError("Close the bracket", true);
        throw new QueryError(`Unexpected "${toks[i].v}"`, false);
      }
      i++;
      return inner;
    }
    // A name: consecutive words. An "and"/"or" word where a name should be is part of the name
    // ("And" alone at the start could be someone's name being typed).
    const words: string[] = [];
    if (tok.t === "and" || tok.t === "or") {
      if (!/^[a-z]+$/i.test(tok.v)) throw new QueryError(`A name is missing before "${tok.v}"`, false);
      words.push(tok.v);
      i++;
    }
    while (toks[i]?.t === "word") words.push(toks[i++].v);
    if (words.length === 0) throw new QueryError(`A name is missing before "${toks[i].v}"`, false);
    const text = words.join(" ");
    const person = resolvePerson(text, names);
    if (!person) {
      const several = names.filter((n) => n.toLowerCase().includes(text.toLowerCase())).length > 1;
      throw new QueryError(several ? `"${text}" matches several people` : `No one called "${text}"`, false);
    }
    return { person };
  };

  try {
    const expr = parseOr();
    if (i < toks.length) throw new QueryError(toks[i].t === ")" ? "One bracket too many" : `Unexpected "${toks[i].v}"`, false);
    return { expr, error: null, incomplete: false, typing };
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    return { expr: null, error: err.message, incomplete: err.incomplete, typing };
  }
}

// Whether a photo with these people passes the filter (null = no filter)
export function matchesPeopleExpr(photoPeople: string[], expr: PeopleExpr | null): boolean {
  if (!expr) return true;
  const have = new Set(photoPeople.map((n) => n.toLowerCase()));
  const test = (e: PeopleExpr): boolean =>
    "person" in e
      ? have.has(e.person.toLowerCase())
      : "not" in e
      ? !test(e.not)
      : e.op === "all"
      ? e.items.every(test)
      : e.items.some(test);
  return test(expr);
}

// "Anna", "Anna and Bob", "(Anna or Bob) and not Carl"
export function describePeopleExpr(expr: PeopleExpr | null): string {
  if (!expr) return "";
  const inner = (e: PeopleExpr): string => ("op" in e ? `(${describePeopleExpr(e)})` : describePeopleExpr(e));
  if ("person" in expr) return expr.person;
  if ("not" in expr) return `not ${inner(expr.not)}`;
  return expr.items.map(inner).join(expr.op === "all" ? " and " : " or ");
}

// A plain list of people ("Anna", "Anna and Bob and Carl"): shown as chips. null for anything nested or with "not".
export function flatPeople(expr: PeopleExpr | null): { names: string[]; match: PeopleMatch } | null {
  if (!expr) return { names: [], match: "all" };
  if ("person" in expr) return { names: [expr.person], match: "all" };
  if ("op" in expr && expr.items.every((e) => "person" in e)) {
    return { names: expr.items.map((e) => (e as { person: string }).person), match: expr.op };
  }
  return null;
}

export function peopleExprFromList(names: string[], match: PeopleMatch): PeopleExpr | null {
  if (names.length === 0) return null;
  return combinePeople(match, names.map((person) => ({ person })));
}

// Every person named in the filter (also the ones under "not")
export function peopleInExpr(expr: PeopleExpr | null): string[] {
  if (!expr) return [];
  if ("person" in expr) return [expr.person];
  if ("not" in expr) return peopleInExpr(expr.not);
  return expr.items.flatMap(peopleInExpr);
}

// The filter with one person renamed (merges keep the filter working)
export function renameInExpr(expr: PeopleExpr | null, oldName: string, newName: string): PeopleExpr | null {
  if (!expr) return null;
  const old = oldName.toLowerCase();
  if ("person" in expr) return expr.person.toLowerCase() === old ? { person: newName } : expr;
  if ("not" in expr) return { not: renameInExpr(expr.not, oldName, newName)! };
  return combinePeople(expr.op, expr.items.map((e) => renameInExpr(e, oldName, newName)!));
}

// The filter without one person (null when nothing is left)
export function removeFromExpr(expr: PeopleExpr | null, name: string): PeopleExpr | null {
  if (!expr) return null;
  if ("person" in expr) return expr.person.toLowerCase() === name.toLowerCase() ? null : expr;
  if ("not" in expr) {
    const inner = removeFromExpr(expr.not, name);
    return inner ? { not: inner } : null;
  }
  const items = expr.items.map((e) => removeFromExpr(e, name)).filter((e): e is PeopleExpr => e !== null);
  return items.length ? combinePeople(expr.op, items) : null;
}
