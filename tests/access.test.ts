import { test } from "node:test";
import assert from "node:assert/strict";
import { openLibraryIsLocal, openLibraryRole, openLibraryServer, rememberLibraryRoles, setOpenLibrary, subscribeAccess } from "../src/api/index.ts";

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
});

test("roles are kept per server: two servers can both have /photos", () => {
  rememberLibraryRoles([{ root: "/photos", role: "editor" }], "cachy.example.ts.net");
  rememberLibraryRoles([{ root: "/photos", role: "guest" }], "nas.example.ts.net");
  setOpenLibrary("/photos", "cachy.example.ts.net");
  assert.equal(openLibraryRole(), "editor");
  assert.equal(openLibraryServer(), "cachy.example.ts.net");
  setOpenLibrary("/photos", "nas.example.ts.net");
  assert.equal(openLibraryRole(), "guest");
  // Closing the library forgets its server too
  setOpenLibrary(null, "nas.example.ts.net");
  assert.equal(openLibraryServer(), null);
});
