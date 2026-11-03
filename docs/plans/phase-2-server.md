# Phase 2: the server on the network, with accounts

Brief for the Claude Code session on the CachyOS machine. Read `CLAUDE.md` first; this file adds the plan
for phase 2. Work on branch `lumina-5`, on the test library, never on a real library database.

## Goal

Maarten and his partner open `https://cachy.<tailnet>.ts.net` in a browser (desktop or phone, over
Tailscale), log in with their own account and use Lumina on the server's library: browse, search, People,
Map, Collections, videos; and, with the right role, rate, tag, name faces and make albums. Changes one of
them makes show up for the other within seconds.

The web client is the existing React app (the same Vite build as the desktop), talking to the server
through `src/api` instead of Tauri. The desktop app must keep working exactly as before.

## Decisions already made

- **HTTPS through Tailscale.** The server listens on `127.0.0.1:8080` only, plain HTTP. `tailscale serve`
  on the host terminates HTTPS with a real certificate for the machine's MagicDNS name and forwards to it.
  Nothing is exposed on the LAN or the internet. (Tailscale admin console: MagicDNS and HTTPS certificates
  on.) Command: `sudo tailscale serve --bg --https=443 http://127.0.0.1:8080`.
- **Accounts from the start**, with passwords (argon2id). Roles, lowest to highest:
  `viewer` < `uploader` < `editor` < `admin`. `uploader` behaves as `viewer` until uploads exist (phase 3).
  Maarten is `admin`, his partner `editor`. Shared albums for people without a role on the library come in
  milestone 4.
- **One RPC endpoint, not a REST route per command.** `POST /api/rpc/{command}` takes the same JSON the
  desktop frontend already sends to Tauri's `invoke`, and returns what the Tauri command returns. Every
  command declares the lowest role allowed to call it (table below).
- **Same names, same shapes.** Command names, argument names and result types are the contract between the
  frontend and both backends. Tauri converts the frontend's camelCase argument names to the Rust
  parameters' snake_case; the server must accept the same camelCase JSON (`#[serde(rename_all = "camelCase")]`).
- **The engine stays in lumina-core and knows nothing about HTTP or users.** Authentication, roles and
  routing live in `crates/lumina-server`. Where the engine lacks something a server needs (a photo list
  without rescanning, for example), add it to lumina-core as an ordinary function and use it from both.

## Milestones

Each one ends working and tested. Commit at the end of each one on `lumina-5` and tell Maarten what works;
ask before pushing.

### 1. HTTP server, accounts, HTTPS

- `lumina-server serve` also starts an axum server. New config keys: `listen` (default `127.0.0.1:8080`),
  `web_dir` (the built frontend, default `dist` next to the binary or `/opt/lumina/web` in Docker);
  variables `LUMINA_LISTEN`, `LUMINA_WEB_DIR`.
- Tables in `library.db`, created by the server on start (`CREATE TABLE IF NOT EXISTS`, safe on every open):
  - `users (id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, role TEXT, password_hash TEXT, created_at INTEGER)`
  - `sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER, device TEXT, created_at INTEGER, last_seen INTEGER)`
    Only the SHA-256 of a session token is stored. Sessions expire after 90 days without use.
- CLI: `lumina-server create-user NAME --role admin` (asks for the password twice, no echo),
  `set-password NAME`, `set-role NAME ROLE`, `users`, `remove-user NAME`.
- Routes:
  - `POST /api/auth/login {name, password}` sets the cookie `lumina_session` (HttpOnly, Secure,
    SameSite=Strict, Path=/) and returns `{name, role}`. Failed logins are slowed down (a growing delay per
    name and per client address) and never say whether the name exists.
  - `POST /api/auth/logout`, `GET /api/auth/me`.
  - Everything under `/api` and `/media` needs a valid session (cookie, or `Authorization: Bearer` for the
    desktop and Android clients of later phases). State-changing requests also need the header
    `X-Lumina: 1`, which a cross-site form can't send.
  - `GET /` and the rest: the web client's files, with `index.html` for unknown paths (single-page app).
    Send a Content-Security-Policy close to the desktop's (`src-tauri/tauri.conf.json`), allowing only the
    page's own origin for scripts, media and the WebSocket.
- Tests: axum's `tower::ServiceExt::oneshot` against an in-memory or temporary database: login works, a wrong
  password and an unknown name answer the same, no session means 401, a viewer can't call an editor command.
- Docker: a Node stage builds the frontend (`npm ci && npm run build`) into `/opt/lumina/web`; the compose
  file publishes `127.0.0.1:8080:8080` only. Document `tailscale serve` in a short `server/README.md`.

### 2. Browsing from a browser (read-only)

- **Photo list without a rescan.** The desktop loads a library by calling `scan_folder`, which walks the
  folder. On the server the library is kept up to date by `serve` itself, so add to lumina-core a function
  that builds the same `Vec<PhotoItem>` from the database alone (the part of `scan_folder` after the walk:
  rows to `PhotoItem`, `link_live_photos`, duplicate groups), and let the RPC `scan_folder` return that for
  every role. Rescans are admin work (milestone 3).
- **Libraries instead of a folder picker:** an RPC `list_libraries` (from `libraries::list`). The frontend
  shows the server's libraries where the desktop shows "Choose Photo Folder".
- **Media by id** (`src/api/transport.ts` already names the kinds):
  - `GET /media/thumb/{hash}`: `thumbnails/{hash}.jpg`.
  - `GET /media/original/{hash}`: the file itself for JPEG, PNG and playable video, with Range support
    (tower-http's `ServeFile`). RAW and HEIC are served as their 1920 px preview
    (`decode::ensure_high_res_preview`): browsers can't show them.
  - `GET /media/preview/{hash}`: the playable copy of a video (`ffmpeg::make_playable_copy`).
  - `GET /media/face/{face_id}`: `faces/{face_id}.jpg` (the frontend has the crop's path; its file name is
    the face id).
  - Every lookup goes through the database by hash or id. Never build a file path from request text.
  - **The Linux desktop serves its local videos over HTTP too.** WebKitGTK can't play video from
    Tauri's `asset://` URLs (tauri#3725; tested 2026-11-03: `FormatError`, while GStreamer plays the file
    and a fetch of the URL works), and serving the file over HTTP from 127.0.0.1 does work. Decided
    with Maarten: a small server in the desktop crate, Linux only (`src-tauri/src/media_server.rs`), not
    the server's routes (those look files up by id in the server's database). It listens on 127.0.0.1
    only, on a random port, with a secret token per run in every URL (`/video/{token}?path=...`), and
    serves only video files inside the asset protocol's scope (the opened libraries and the app's data
    folder). `mediaUrl` in the local transport uses it for videos and playable copies on Linux. Only for
    that: local files on the Windows desktop (the standalone install) keep `convertFileSrc` (`asset://`,
    which plays there), and files from a server already come over the `/media/...` routes.
- **Events:** `GET /api/events` upgrades to a WebSocket and sends `{event, payload}` for every engine
  event (`ServerHost` already has a broadcast channel). Authenticated like the rest.
- **Remote transport** `src/api/remote.ts`, implementing `Transport`:
  - `call`: `fetch('/api/rpc/' + command, {method: 'POST', credentials: 'same-origin', headers:
    {'Content-Type': 'application/json', 'X-Lumina': '1'}, body: JSON.stringify(args ?? {})})`. An error
    answer is `{"error": "..."}` with a 4xx/5xx status; reject with that text as a plain string, because
    the frontend checks errors with `String(err).includes(...)` (for example `AI_CANCELLED`).
  - `subscribe`: one shared WebSocket for all subscriptions, reconnecting with backoff; handlers get
    `{payload}` as from Tauri.
  - `mediaUrl`: the `/media/...` URLs above (`face` by the file name in `path`).
  - `src/api/index.ts` chooses: inside Tauri (`'__TAURI_INTERNALS__' in window`) the local transport,
    otherwise the remote one on the page's own origin.
- **The web client's limits:** `src/api/platform.ts` must not call Tauri plugins in a browser. Make its
  flags real (`fileDialogs`, `localFiles`, `updater` false in a browser) and hide or disable what needs them:
  open folder, import from a card, export to a folder, backup to a folder, reveal in Explorer, open with
  the default app, copy image to the clipboard, the updater, Ollama service controls. Hide by flag, not by
  checking for Tauri all over the code.
- **Login screen** in the web client: shown when `/api/auth/me` answers 401; name and password; after
  login, the normal app. A small account menu with the name, role and Log out.
- **Phone layout** (added after the first phone test: the full layout is unusable on a phone): a phone in
  a browser (narrower than 768 px, or a touch screen lower than 500 px, so held sideways too) gets
  `src/components/mobile/MobileApp.tsx` instead of `App`, on the same `useLibraryState`. Photos by month
  (newest first), People, Albums and trips, Map, search with the Smart switch, and a full-screen viewer:
  swipe sideways for the next photo, down to close, up for the details; pinch or double-tap to zoom; the
  phone's back button closes it. The account sheet can switch to the full layout (remembered in that
  browser) and the full layout's account menu back. Browsing only; editing on a phone comes with
  milestone 3 if it's wanted there.
- **Paths in arguments:** some commands take paths the client got from the server (`ai_analyze_photo`
  `imagePathForAi`, `detect_faces_in_photo`, `ensure_high_res_preview` `sourcePath`, ...). The server
  checks that such a path is the stored path of a photo in a library (look it up), and refuses anything
  else.
- **Done when:** in Chrome and Firefox on another machine, and on a phone, over
  `https://cachy.<tailnet>.ts.net`: log in, the test library's grid with thumbnails, Loupe with full-size
  photos (RAW and HEIC included), videos play and seek, smart search, People, Map, Collections, Timeline.
  The desktop app on Windows still works unchanged (`npm test`, `cargo test --workspace --lib`).

### 3. Editing with roles, and live updates between users

- Turn on the commands of the `editor` and `admin` columns below. The server checks the role before it
  calls the engine; the web client hides what the user's role can't do (`/api/auth/me` gives the role).
- **Live updates:** after a command that changes photos (ratings, flags, labels, tags, people, faces, albums,
  locations, rotation, dates, captions), the server sends an event `photos-changed` with the hashes, and
  `people-changed` / `albums-changed` where they apply. Add an RPC `get_photos` (hashes in, `PhotoItem`s
  out) so a client refreshes just those photos. The desktop never receives these events, so its behaviour
  doesn't change.
- **Engine-wide state:** cancel flags and running jobs in lumina-core are process-wide (`SCAN_GENERATION`,
  `cancel_*`, `AI_BATCH_RUNNING`, `SEMANTIC_RUNNING`). That's why starting and cancelling long jobs is admin
  work. A second editor's single-photo AI request while a batch runs gets the existing "Batch AI is
  running" answer.
- **Who did what:** a table `changes (at, user_id, hash, what)` written by the server for every editing
  command, and an RPC to read a photo's history (shown in the Inspector later). Keep it small: one row per
  command and photo, no payloads.
- **Done when:** Maarten (admin) and his partner (editor) are logged in at the same time in two browsers. A
  rating, tag, album or named face from one appears in the other within a few seconds. A viewer account sees
  everything and can change nothing (buttons hidden; direct RPC calls refused with 403).

### 4. Shared albums

- `album_shares (album_id, user_id)`. A user with role `guest` (lower than `viewer`; add it) has no access to
  the library itself, only to the albums shared with them.
- Scoping is enforced on the server, in one place: the photo list, search (smart and text), People, Map,
  Collections, media requests and events are filtered to the photos in the user's shared albums. Prefer
  filtering result sets in the server over adding a user parameter to every engine query, unless a query
  would return far too much to filter.
- Admin and editor can share an album with a user (RPC + a small dialog in the album's menu).
- **Done when:** a guest sees exactly the shared albums' photos everywhere, can't open other photos by
  guessing a hash (404), and gets no events about other photos.

### 5. Administration in the browser

- Users: list, add, change role, reset password, remove (admin only).
- Server status: libraries with counts, backlog (photos without thumbnails, faces, smart search, captions),
  running jobs, GPU device in use, disk space of the data folder.
- Restore a `.luminabackup` by upload (multipart, large file, written to the data folder first), with the
  folder remaps of `backup::inspect_backup` / `restore_library`; the server restarts its pipeline after.
- Start a rescan, a face scan, the smart search index or Batch AI captions for a library.

## Commands and roles

`scan_folder` becomes the database listing for everyone (milestone 2). Commands not listed don't exist on
the server: the RPC answers 404.

| Role | Commands |
| :--- | :--- |
| viewer | `scan_folder` (listing), `list_libraries` (new), `get_photos` (new), `get_people`, `get_albums`, `get_saved_searches`, `get_trip_names`, `semantic_status`, `semantic_search`, `find_similar_photos`, `search_cities_offline`, `get_face_match_config`, `get_confirmed_faces_for_person`, `pick_highlights`, `existing_playable_copy`, `make_playable_copy`, `cancel_playable_copy`, `ensure_high_res_preview`, `check_ollama_status` |
| editor | `set_photos_rating`, `set_photo_flag`, `set_photo_color_label`, `set_photo_rotation`, `set_photos_rotation_exact`, `set_photo_basket`, `add_tag_batch`, `remove_tag`, `remove_tag_batch`, `set_manual_location`, `shift_capture_timestamps`, `rescan_exif_batch`, `add_person_to_photos`, `remove_person_from_photo`, `remove_person_from_photos`, `rename_person`, `set_person_hidden`, `set_person_starred`, `set_person_cover`, `find_similar_faces`, `get_rejected_faces_for_person`, `assign_faces_to_person_batch`, `unassign_faces_batch`, `reject_face_candidates_batch`, `unreject_face_candidates_batch`, `ignore_faces`, `get_pending_face_match_counts`, `get_unknown_face_clusters`, `assign_face_region_and_automatch`, `remove_face_box`, `detect_faces_in_photo`, `create_album`, `rename_album`, `delete_album`, `add_to_album`, `remove_from_album`, `save_search`, `delete_saved_search`, `set_trip_name`, `ai_analyze_photo`, `prepare_ai_image`, `cancel_ai_analysis`, `find_duplicates`, `stage_photo_move`, `stage_photos_move`, `stage_duplicate_extras`, `get_staged_operations`, `get_outdated_face_photos` |
| admin | `commit_staged_operations`, `clear_all_staged`, `trash_summary`, `empty_library_trash_to_os` (on Linux always a permanent delete: ask in the UI), `export_xmp_sidecars`, `get_library_health_stats`, `prune_orphaned_cache`, `video_cache_info`, `clear_video_cache`, `scan_library_faces_batch`, `cancel_face_scan`, `start_semantic_index`, `cancel_semantic_index`, `measure_face_quality`, `run_caption_batch`, `cancel_folder_scan`, `cancel_thumbnail_pass`, `ollama_tuning_status`, `preload_ollama_vram`, `unload_ollama_vram`, `pull_ollama_model`, `cancel_ollama_pull`, `inspect_backup`, `restore_library` (milestone 5), `rescan_library` (new: `scan_folder` with a walk) |
| not on the server | `open_in_default_app`, `reveal_in_file_manager`, `create_library_subfolder`, `get_app_data_dir`, `copy_image_to_clipboard`, `close_splashscreen`, `restart_app`, `watch_library` (the server watches by itself; answer OK and do nothing), `list_import_sources`, `preview_import`, `start_import`, `cancel_import` (uploads replace import, phase 3), `export_photos`, `cancel_export`, `export_gallery`, `backup_library`, `export_library_csv` (write to server folders; downloads come later), `start_ollama_service`, `enable_ollama_flash_attention` (the container is configured instead) |

`stage_*` only marks a planned move or a photo for `_Trash`; files change only at `commit_staged_operations`,
which is admin work.

## Implementation notes

- Crates: `axum` 0.8 (with `ws`), `tower-http` (`fs`, `set-header`, `trace`), `axum-extra` (cookies),
  `argon2`, `rand`, `sha2`, `rpassword`. The RPC dispatch is one table built by a macro: name, minimum role,
  argument struct, async call into lumina-core. Write it so the desktop's `engine_commands.rs` and the
  server's table can't drift apart unnoticed: a test lists the commands the frontend calls
  (`grep "call<\|call(" src`) and checks each one is either in the server table or in the "not on the
  server" list.
- Engine functions take `SharedHost`; the server passes its `Arc<ServerHost>`. Long work is already off the
  async threads (`spawn_blocking`, own threads); keep it that way in new code.
- The database is shared by the pipeline (`serve`) and the HTTP handlers: open a connection per request
  with `db::open_global_db` as the engine does (WAL, busy timeout); don't hold one across `await`.
- Error answers: 400 with `{"error"}` for bad arguments, 401 not logged in, 403 role too low, 404 unknown
  command or media, 500 with the engine's error text otherwise.
- Logging: one line per request with user, command or path, status and milliseconds; never log passwords,
  tokens or cookies.
- Frontend: keep `call`, `subscribe` and `mediaUrl` the only way to the backend. New UI (login, account
  menu, libraries list, admin pages) follows the existing components' style (Tailwind, the zinc/emerald
  palette, lucide icons).

## Testing

- Rust: unit tests for password hashing, sessions, role checks and path validation; HTTP tests with
  `oneshot` for every route family; the existing `cargo test --workspace --lib` must stay green.
- Frontend: `npm test` and `npx tsc --noEmit -p .` stay green; add tests for the remote transport's
  error handling and URL building (`tests/`).
- By hand, at the end of each milestone, over `https://cachy.<tailnet>.ts.net`: Chrome and Firefox on
  another computer, Safari on an iPhone, two accounts at once. Write down what was checked in the commit
  message.
- Test accounts on the test server data only (`~/LuminaTest/ServerData`), never real passwords in commits.

## Out of scope for phase 2

Uploads and downloads (phase 3), the desktop app's client mode and "available on this device" (phase 3),
clients helping with AI (phase 4), Android (phase 5).
