import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDesktopRemoteTransport,
  createRemoteEvents,
  isLocalCommand,
  libraryRefFromString,
  libraryRefToString,
  remoteMediaKey,
} from "../src/api/desktopRemote.ts";

test("media of a server library go through lumina-remote by id", () => {
  assert.equal(remoteMediaKey("cachy.ts.net", { kind: "thumb", hash: "abc", path: "/data/thumbnails/abc.jpg" }), "cachy.ts.net/thumb/abc");
  assert.equal(remoteMediaKey("cachy.ts.net", { kind: "face", path: "C:/x/faces/abc_1_2.jpg" }), "cachy.ts.net/face/abc_1_2");
  const calls: unknown[] = [];
  const t = createDesktopRemoteTransport(
    "cachy.ts.net",
    {
      invoke: async (command, args) => {
        calls.push([command, args]);
        return null as never;
      },
      convertFileSrc: (path, protocol) => `${protocol}://localhost/${encodeURIComponent(path)}`,
    },
    createRemoteEvents(() => "cachy.ts.net"),
    "win1"
  );
  assert.equal(t.mediaUrl({ kind: "original", hash: "abc", path: "/photos/a.jpg" }), "lumina-remote://localhost/cachy.ts.net%2Foriginal%2Fabc");
  t.call("get_people", { rootFolder: "/photos" });
  assert.deepEqual(calls[0], ["server_call", { server: "cachy.ts.net", command: "get_people", args: { rootFolder: "/photos" }, client: "win1" }]);
});

test("commands about this computer stay local", () => {
  for (const c of ["open_in_default_app", "start_import", "watch_library", "close_splashscreen", "server_login"]) assert.ok(isLocalCommand(c), c);
  for (const c of ["scan_folder", "get_people", "set_photos_rating", "list_libraries"]) assert.ok(!isLocalCommand(c), c);
});

test("a server's events reach handlers only while its library is open", () => {
  let open: string | null = "a.ts.net";
  const events = createRemoteEvents(() => open);
  const got: unknown[] = [];
  events.subscribe("photos-changed", (e) => got.push(e.payload));
  events.deliver({ server: "a.ts.net", event: "photos-changed", payload: 1 });
  events.deliver({ server: "b.ts.net", event: "photos-changed", payload: 2 });
  events.deliver({ server: "a.ts.net", event: "people-changed", payload: 3 });
  open = null;
  events.deliver({ server: "a.ts.net", event: "photos-changed", payload: 4 });
  assert.deepEqual(got, [1]);
});

test("the open library is remembered with its server", () => {
  const local = { server: null, root: "C:\Photos" };
  assert.equal(libraryRefToString(local), "C:\Photos");
  assert.deepEqual(libraryRefFromString("C:\Photos"), local);
  const remote = { server: "cachy.ts.net", root: "/photos" };
  assert.deepEqual(libraryRefFromString(libraryRefToString(remote)), remote);
});

test("All photos hears the events of every server in it, and no other", () => {
  const events = createRemoteEvents(() => ["a.ts.net", "b.ts.net"]);
  const got: unknown[] = [];
  events.subscribe("photos-changed", (e) => got.push(e.payload));
  events.deliver({ server: "a.ts.net", event: "photos-changed", payload: 1 });
  events.deliver({ server: "b.ts.net", event: "photos-changed", payload: 2 });
  events.deliver({ server: "c.ts.net", event: "photos-changed", payload: 3 });
  assert.deepEqual(got, [1, 2]);
});
