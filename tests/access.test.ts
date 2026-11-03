import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalLibrary, openLibraryIsLocal, openLibraryRole, rememberLibraryRoles, setOpenLibrary, subscribeAccess } from "../src/api/index.ts";

test("in a browser, rights follow the role on the open library", () => {
  let changes = 0;
  const off = subscribeAccess(() => changes++);
  rememberLibraryRoles([
    { root: "/photos/anna", role: "editor" },
    { root: "/photos/bob", role: "guest" },
  ]);
  setOpenLibrary("/photos/anna");
  assert.equal(openLibraryRole(), "editor");
  setOpenLibrary("/photos/bob");
  assert.equal(openLibraryRole(), "guest");
  setOpenLibrary("/photos/elsewhere");
  assert.equal(openLibraryRole(), undefined, "not known yet: the account's own role applies");
  assert.ok(changes >= 4, "every change tells the windows' access hooks");
  off();
  // No library of a browser is this computer's own
  assert.equal(openLibraryIsLocal(), false);
  assert.equal(isLocalLibrary("/photos/anna"), false);
});
