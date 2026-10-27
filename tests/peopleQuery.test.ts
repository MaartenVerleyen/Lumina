import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePeopleQuery, resolvePerson, matchesPeople, describePeople } from "../src/utils/peopleQuery.ts";
import { parseSearchQuery, matchesTerms } from "../src/utils/searchQuery.ts";

const names = ["Anna", "Andy", "Bert", "Carl Jansen", "Carla"];

test("resolvePerson: exact, unique prefix, unique substring", () => {
  assert.equal(resolvePerson("anna", names), "Anna");
  assert.equal(resolvePerson("ber", names), "Bert");
  assert.equal(resolvePerson("jansen", names), "Carl Jansen");
  assert.equal(resolvePerson("carl", names), null); // "Carl Jansen" and "Carla"
  assert.equal(resolvePerson("an", names), null);
  assert.equal(resolvePerson("", names), null);
});

test("parsePeopleQuery: and / or between names", () => {
  const and = parsePeopleQuery("anna and bert", names);
  assert.equal(and.mode, "all");
  assert.deepEqual(and.parts.map((p) => p.person), ["Anna", "Bert"]);

  const or = parsePeopleQuery("anna or carl jansen", names);
  assert.equal(or.mode, "any");
  assert.deepEqual(or.parts.map((p) => p.person), ["Anna", "Carl Jansen"]);

  assert.equal(parsePeopleQuery("anna&bert", names).mode, "all");
  assert.equal(parsePeopleQuery("anna|bert", names).mode, "any");
  assert.equal(parsePeopleQuery("anna, bert", names).mode, "any");
  assert.equal(parsePeopleQuery("anna en bert", names).mode, "all");
});

test("parsePeopleQuery: a single name, and an operator word at the start is a name", () => {
  const one = parsePeopleQuery("andy", names);
  assert.equal(one.mode, null);
  assert.deepEqual(one.parts.map((p) => p.person), ["Andy"]);
  const typing = parsePeopleQuery("anna and ", names);
  assert.equal(typing.mode, "all");
  assert.deepEqual(typing.parts.map((p) => p.text), ["anna"]);
});

test("matchesPeople and describePeople", () => {
  assert.ok(matchesPeople(["Anna", "Bert"], ["anna", "bert"], "all"));
  assert.ok(!matchesPeople(["Anna"], ["Anna", "Bert"], "all"));
  assert.ok(matchesPeople(["Anna"], ["Anna", "Bert"], "any"));
  assert.ok(!matchesPeople(["Carla"], ["Anna", "Bert"], "any"));
  assert.ok(matchesPeople([], [], "all"));
  assert.equal(describePeople(["Anna", "Bert", "Carla"], "any"), "Anna, Bert or Carla");
  assert.equal(describePeople(["Anna", "Bert"], "all"), "Anna and Bert");
});

test("search syntax: person:a|b matches either", () => {
  const photo = { hash: "h", name: "a.jpg", rating: 0, flag: null, color_label: null, people: ["Bert"], tags: [],
    camera_model: "", location: "", captured_at: "", faces: [], ocr_text: "", ai_caption: "" };
  assert.ok(matchesTerms(photo, parseSearchQuery("person:anna|bert").terms));
  assert.ok(!matchesTerms(photo, parseSearchQuery("person:anna person:bert").terms));
});
