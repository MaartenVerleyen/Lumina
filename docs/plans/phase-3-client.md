# Phase 3: the desktop app as a client, uploads and downloads

Brief for the Claude Code sessions on both machines. Read `CLAUDE.md` and `docs/plans/phase-2-server.md`
first. Work on branch `lumina-5`, on the test library and test accounts, never on a real library database.

**Before starting phase 3:** phase 2 milestones 3 (editing with roles, live updates), 4 (guests and shared
albums) and 5 (administration) are done, and the login throttle is fixed (first task below). Phase 3 builds
on the roles and on the `photos-changed` events of milestone 3.

## Goal

From the Windows PC (and later a Mac or Linux laptop), Maarten opens Lumina and works on the server's
library as if it were local: the same app, with the server's libraries in the sidebar next to any local
ones. Photos dragged from a card or a folder onto the window go to the server, skipping what it already
has, and surviving a closed laptop. Originals of a selection or an album can be downloaded, and the app
shows which photos are on this device. Maarten's partner does the same from their own computer, or uploads
from a phone's browser. Everyone who may upload sees their uploads in `uploads/<their name>/`; the server indexes them like
any other photo, so they appear in the library, search and People right away.

## Decisions already made (Maarten, 2026-11-03)

- **Uploads go to `<library>/uploads/<user name>/`**, not to dated folders: each person's uploads are easy
  to recognise. They are ordinary library photos from then on (moving them into the library's own folders is
  the existing staged-move flow).
- **Who may upload:** `uploader`, `editor` and `admin`. `viewer` (full read-only access) and `guest` (only
  what is shared with them) may not.
- **The full app stays as it is.** Client mode is added; nobody has to use a server.
- **Work split:** the server's routes on the Linux machine, the desktop client on Windows (where the desktop
  app is used day to day). Each milestone says where it happens.

## First task (Linux): the login throttle under parallel attempts

`http/auth.rs` waits out the current delay and then checks the password. Attempts sent at the same time all
read the same delay, wait it out together, and are all checked, so the throttle only holds for one attempt
at a time. Fix: per name and per address, keep the time the next attempt is allowed; an attempt that
arrives earlier gets 429 with `Retry-After` and isn't checked, and each failure pushes that time out
(the existing doubling, at most 30 s). Test: 20 parallel wrong attempts check at most one password per key
per delay.

## Milestones

Commit at the end of each one on `lumina-5` and tell Maarten what to test; ask before pushing.

### 1. Upload and download routes (Linux)

The upload protocol is resumable and checks what the server already has before sending anything.

- `POST /api/upload/check` `{files: [{hash, size, name}]}` → `{missing: [hash, ...]}`. `hash` is Lumina's
  content hash (`imaging::hash_and_read_head`: BLAKE3 of the size, the first and the last 64 KB); a photo
  the server has under that hash (or a path-salted copy of it) counts as present.
- `POST /api/upload` `{name, size, hash, full_hash, modified}` → `{id, received}`. `full_hash` is the
  BLAKE3 of the whole file, for the check at the end. Starting the same file again (same user, hash and
  size) returns the existing upload and how much has arrived, so a client resumes instead of starting over.
- `PUT /api/upload/{id}` with header `Upload-Offset: N` and up to 8 MB of the file. A chunk at the wrong
  offset gets 409 with the offset the server expects. `GET /api/upload/{id}` → `{received, size}`.
- `POST /api/upload/{id}/finish`: the server checks the size and `full_hash`, moves the file into
  `<library>/uploads/<user>/<name>` (the user's name made safe for every file system; a name that exists
  gets " (2)", " (3)", ...; never overwrite), sets its modification time to `modified`, and indexes it at
  once (the watcher would pick it up too, but the client wants the photo back): answer the new `PhotoItem`.
  Then a `photos-changed` event goes to everyone who may see it.
- Partial uploads live in `<data_dir>/incoming/` and are removed after 7 days without new chunks. Refuse an
  upload larger than the free disk space minus 5 GB (507 with a clear message).
- Which library: the config key `upload_library` (`LUMINA_UPLOAD_LIBRARY`), default the first library.
  Sidecars (`.xmp`) and a Live Photo's clip are uploaded as files of their own; same folder and stem keep
  them paired as today.
- `GET /media/download/{hash}`: the original file as stored (not a preview), with
  `Content-Disposition: attachment; filename="..."`, Range support and its full BLAKE3 in a header
  (`X-Lumina-Blake3`) so a client can check what it saved. Viewer and up; a guest only for shared photos.
- `POST /api/rpc/content_hashes` `{hashes}` → which of them the server has, for the client's "available on
  this device" check (milestone 4).
- Roles: every upload route needs `uploader` or higher; downloads follow the photo's visibility.
- Tests (`oneshot`): a full upload in three chunks; a resumed upload; a wrong offset; a wrong `full_hash`
  (the file is not kept); a name that exists; a viewer gets 403; `check` reports a present file.

### 2. The desktop app connects to a server (Windows)

- **Where the connection lives:** in Rust, not in the page. The desktop's webview can't call the server
  directly without CORS and cookies across origins, and the session token must not sit in page storage.
  New desktop module `src-tauri/src/remote.rs`:
  - `server_login(url, name, password)` → stores the session token in the operating system's credential
    store (crate `keyring`: Windows Credential Manager, macOS Keychain, Secret Service on Linux) and the
    server's address and user in the app's settings; `server_logout`, `server_status`.
  - `server_call(server, command, args)`: `POST /api/rpc/{command}` with `Authorization: Bearer`, the
    error text passed back as the command's error (the frontend checks `String(err).includes(...)`).
  - Events: one WebSocket per connected server (`tokio-tungstenite`, Bearer token), reconnecting with
    backoff, each event re-emitted to the window as `remote-event` `{server, event, payload}`.
  - Media: a custom protocol `lumina-remote://` (Tauri `register_asynchronous_uri_scheme_protocol`) that
    serves `/{server}/{kind}/{id}` from a disk cache or fetches it with the token. Thumbnails and face
    crops are cached (`<app data>/remote-cache/<server>/`, least recently used out above a size limit,
    default 2 GB, a setting); originals and videos are streamed, with Range passed through for seeking.
- **Frontend:** `src/api/desktopRemote.ts`, a `Transport` over `server_call`, `remote-event` and
  `lumina-remote://` URLs. `src/api/remote.ts` stays the browser's transport.
- **Libraries from several places:** today the active library is a folder path string used as `root_folder`
  everywhere. Introduce `LibraryRef = {server: string | null, root: string}` in `useFolder` (local
  libraries have `server: null`), keep passing `root` to the engine as now, and let `transportFor` take the
  `LibraryRef`. The sidebar's library menu lists local libraries and, per connected server, its libraries
  (`list_libraries`), as "On <server name>". A library from a server shared with you is the same thing:
  "shared folders" from the plan.
- **First start / Settings:** "Use on this PC" or "Connect to a server" (address, name, password), and in
  Settings a Servers section: add, sign out, remove, cache size. The full app keeps working with no server.
- **Role-aware UI:** the role from `/api/auth/me` per server hides what the user can't do in that library
  (reuse the web client's flags from phase 2 milestone 3).
- **Done when:** the Windows desktop app shows the server's test library next to a local one, browsing,
  search, People, Map and videos work on the server library, edits by an editor reach a second client
  within seconds, and the local library behaves exactly as before. Closing and reopening the app keeps the
  connection without logging in again.

### 3. Uploading (Windows client, plus the web client)

- **Desktop:** drop files or folders on the window while a server library is open, or choose "Upload to
  server" in the Import dialog (the card import's file list, filters and Live Photo handling, with the
  server as destination). The upload queue lives in Rust (`src-tauri/src/uploads.rs`): hash locally
  (`imaging::hash_and_read_head` plus a full BLAKE3), `check` in batches, upload what's missing in chunks,
  two files at a time, resume after a restart (the queue is saved in the app's data folder), retry with
  backoff. Progress as events, shown like other background jobs (`src/app/backgroundJobs.ts`): files and
  bytes, speed, time left, skipped (already on the server), failed with reasons, cancel.
- **Web client:** an Upload button for uploader and up (file picker, several files), the same protocol from
  the browser (`File.slice` for chunks; BLAKE3 in the browser via a small WASM build or `hash-wasm`). This
  is how a phone uploads until the Android app exists.
- **Done when:** uploading the test library's photos to a server that has half of them sends only the other
  half; pulling the network cable mid-upload and reconnecting finishes the job; the files appear in
  `uploads/<name>/` and in both users' grids, with faces and smart search once the server's pipeline has
  run; a viewer has no Upload button and the server refuses a direct attempt.

### 4. Downloads and "available on this device" (Windows client)

- **Download:** for a selection, an album or a person: "Download originals…" asks for a folder (the
  platform's folder picker), downloads with progress and resume, checks each file against
  `X-Lumina-Blake3`, and keeps the original file names (" (2)" for clashes).
- **On this device:** the desktop keeps `local_copies (server, hash, path, size, verified_at)` in its own
  database. A download adds a row; uploads add one for the file they sent. A photo of a server library
  with a verified local copy gets a small badge in the grid and the filter "On this device" / "Only on the
  server" next to All / Photos / Videos. A copy that moved or changed is found again by content hash when
  its folder is scanned, or dropped from the list.
- **Actions:** "Keep on this device" (download into a chosen or default folder), "Remove local copy" (only
  when the server has the file, checked with `content_hashes` first; to the Recycle Bin on Windows).
- **Done when:** after downloading an album, its photos show the badge, the filter shows exactly them, a
  downloaded file is byte for byte the original (BLAKE3), and removing a local copy never touches the
  server's file.

### 5. Mac and Linux builds of the desktop app

- A GitHub Actions workflow (`.github/workflows/desktop.yml`) builds the desktop app on push of a tag:
  Windows (as today, but `scripts/release.ps1` stays the way releases are published), Linux (AppImage and
  .deb; the full app works there since phase 1, with the loopback video server) and macOS (universal .dmg,
  unsigned at first: the README explains "right-click → Open"). On macOS the full app is offered only after
  its decoding paths are checked (HEIC and video through ffmpeg, as on Linux); until then client mode only.
- The updater's `latest.json` gets the Linux and macOS entries.
- Ask Maarten before adding the workflow (it runs on GitHub) and before any release.

## Implementation notes

- New server routes go through the same session check and roles as `/api/rpc`; upload chunks are the only
  large request bodies (raise axum's body limit for that route only).
- Hashing: reuse `imaging::hash_and_read_head` on both sides so the identities match; the full-file BLAKE3
  is only for checking transfers.
- The desktop's Rust side holds tokens and does all HTTP; the page never sees a token.
- The frontend still calls the engine only through `src/api`. The new transport and the `LibraryRef` change
  must leave the local path untouched: `npm test`, the Rust tests and a manual check of the full app on the
  test library after each milestone.
- User-facing text as elsewhere: plain and concrete ("12 of 340 photos already on the server, skipped").

## Testing

- Server: `oneshot` tests per route as listed; the whole workspace stays green on both machines.
- Desktop: Rust unit tests for the upload queue (resume, retry, skip) against a test server started in the
  test; frontend tests for `desktopRemote.ts` URL building and `LibraryRef` routing.
- By hand at the end of each milestone, over `https://cachy.tailaa193b.ts.net`: the Windows desktop and a
  browser at the same time, two accounts (admin and editor), a viewer account for the refusals. Write down
  what was checked in the commit message.

## Out of scope for phase 3

Clients helping with the server's AI backlog and analysing photos before upload (phase 4), the Android app
and automatic phone backup (phase 5).
