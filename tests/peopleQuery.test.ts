import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePeopleExpr,
  resolvePerson,
  matchesPeopleExpr,
  describePeopleExpr,
  flatPeople,
  peopleExprFromList,
  renameInExpr,
  removeFromExpr,
} from "../src/utils/peopleQuery.ts";
import { parseSearchQuery, matchesTerms } from "../src/utils/searchQuery.ts";

const names = ["Anna", "Andy", "Bob", "Ella", "James", "Carl Jansen", "Carla"];
const expr = (q: string) => {
  const r = parsePeopleExpr(q, names);
  assert.equal(r.error, null, `${q}: ${r.error}`);
  return r.expr;
};

test("resolvePerson: exact, unique prefix, unique substring", () => {
  assert.equal(resolvePerson("anna", names), "Anna");
  assert.equal(resolvePerson("bo", names), "Bob");
  assert.equal(resolvePerson("jansen", names), "Carl Jansen");
  assert.equal(resolvePerson("carl", names), null); // "Carl Jansen" and "Carla"
  assert.equal(resolvePerson("", names), null);
});

test("and / or / not with brackets and precedence", () => {
  assert.equal(describePeopleExpr(expr("(anna or bob) and (ella or james)")), "(Anna or Bob) and (Ella or James)");
  // and binds tighter than or
  assert.equal(describePeopleExpr(expr("anna or bob and ella")), "Anna or (Bob and Ella)");
  assert.equal(describePeopleExpr(expr("anna and not bob")), "Anna and not Bob");
  assert.equal(describePeopleExpr(expr("anna & -bob")), "Anna and not Bob");
  assert.equal(describePeopleExpr(expr("(anna|bob)+(ella,james)")), "(Anna or Bob) and (Ella or James)");
  assert.equal(describePeopleExpr(expr("anna en bob")), "Anna and Bob");
  assert.equal(describePeopleExpr(expr("carl jansen or ella")), "Carl Jansen or Ella");
  // nested same operators flatten
  assert.deepEqual(expr("anna and (bob and ella)"), { op: "all", items: [{ person: "Anna" }, { person: "Bob" }, { person: "Ella" }] });
});

test("matching", () => {
  const e = expr("(anna or bob) and (ella or james)");
  assert.ok(matchesPeopleExpr(["Anna", "James"], e));
  assert.ok(matchesPeopleExpr(["bob", "ella", "Carla"], e));
  assert.ok(!matchesPeopleExpr(["Anna", "Bob"], e));
  assert.ok(!matchesPeopleExpr(["Ella"], e));
  assert.ok(matchesPeopleExpr(["Anna"], expr("anna and not bob")));
  assert.ok(!matchesPeopleExpr(["Anna", "Bob"], expr("anna and not bob")));
  assert.ok(matchesPeopleExpr([], null));
});

test("unfinished and wrong queries", () => {
  const typing = parsePeopleExpr("(anna or bob) and (el", names);
  assert.equal(typing.incomplete, true);
  assert.equal(typing.typing, "el");
  assert.equal(parsePeopleExpr("anna and ", names).incomplete, true);
  assert.equal(parsePeopleExpr("anna and ", names).typing, "");
  const unknown = parsePeopleExpr("anna and zoe", names);
  assert.equal(unknown.incomplete, false);
  assert.match(unknown.error!, /zoe/);
  assert.match(parsePeopleExpr("carl or bob", names).error!, /several/);
  assert.match(parsePeopleExpr("anna)", names).error!, /bracket/);
  // an operator word alone is a name being typed ("and" -> Andy)
  assert.deepEqual(expr("and"), { person: "Andy" });
});

test("flat lists (chips), rename and remove", () => {
  assert.deepEqual(flatPeople(expr("anna or bob")), { names: ["Anna", "Bob"], match: "any" });
  assert.deepEqual(flatPeople(null), { names: [], match: "all" });
  assert.equal(flatPeople(expr("(anna or bob) and ella")), null);
  assert.equal(flatPeople(expr("anna and not bob")), null);
  assert.deepEqual(peopleExprFromList(["Anna"], "any"), { person: "Anna" });
  assert.equal(peopleExprFromList([], "all"), null);
  const e = expr("(anna or bob) and ella");
  assert.equal(describePeopleExpr(renameInExpr(e, "bob", "Robert")), "(Anna or Robert) and Ella");
  assert.equal(describePeopleExpr(removeFromExpr(e, "Bob")), "Anna and Ella");
  assert.equal(removeFromExpr({ person: "Anna" }, "anna"), null);
});

test("search syntax: person:a|b matches either", () => {
  const photo = { hash: "h", name: "a.jpg", rating: 0, flag: null, color_label: null, people: ["Bob"], tags: [],
    camera_model: "", location: "", captured_at: "", faces: [], ocr_text: "", ai_caption: "" };
  assert.ok(matchesTerms(photo, parseSearchQuery("person:anna|bob").terms));
  assert.ok(!matchesTerms(photo, parseSearchQuery("person:anna person:bob").terms));
});
