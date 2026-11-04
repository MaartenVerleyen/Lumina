# Lumina

Lumina is a local photo and video organiser with AI: culling, ratings, people (face recognition), smart
search (CLIP), captions/tags/OCR through Ollama, albums, trips, backups. Today it is a Windows desktop app
(Tauri v2, React 19 + TypeScript, Rust). **Lumina 5** turns it into three things: the full app (as today),
a server (Linux in Docker, with the GPU) and clients (desktop, web, Android). The owner, Maarten, works on
a Windows PC and a CachyOS (Arch) Linux desktop.

More: `docs/ARCHITECTURE.md` (data model, threading, backups), `docs/RELEASING.md` (releases),
`README.md` (features).

## Rules

- **Commit, push, merge and publish only when Maarten asks.** Branch first when on `main`. Commit messages
  end with the `Co-Authored-By` line the session gives.
- **Ask before changing architecture** (database layout, crate structure, how the frontend talks to the
  engine): long-running indexing may depend on it.
- **Never touch a real library database without asking.** Work on the test library (below) or on a copy
  made with SQLite's backup API (`sqlite3 src.db ".backup copy.db"`). On Windows the real one is
  `%LOCALAPPDATA%\com.amazhr.lumina\library.db`; the dev app uses it unless `LUMINA_DATA_DIR` is set.
- **Never commit the updater private key** (`~/.tauri/lumina-updater.key`).
- **Don't edit the GitHub repository's About or topics.** `gh` is for releases (and cloning) only.
- Photos are never modified by Lumina; moves happen only through the staged-move flow the user commits.

## Layout

```
src/                      React frontend
  api/                    the only place that talks to the engine: call(), subscribe(), mediaUrl()
                          (transport.ts, index.ts) and platform.ts (dialogs, updater, folders, file drop);
                          desktopRemote.ts (a server's library in the desktop app), remote.ts (the web
                          client's server), webUpload.ts (uploads from a browser); allPhotos.ts (All photos:
                          several libraries merged by hash, edits split per photo's home; routed in index.ts)
  hooks/library/*         state and actions per area (useFolder, usePeople, useAi, ...)
  components/, utils/     UI and pure helpers
tests/*.test.ts           frontend tests (node --test)
src-tauri/                Cargo workspace root, and the desktop app crate ("Lumina")
  src/lib.rs              Tauri setup and command registration
  src/engine_commands.rs  thin #[tauri::command] wrappers around lumina-core functions
  src/system.rs           desktop-only: open in Explorer, clipboard, splash screen
  src/media_server.rs     Linux only: local videos over HTTP on 127.0.0.1 (WebKitGTK can't stream asset://)
  src/prepare.rs          model download for the installer
  src/remote.rs           client mode: servers, sign-in (token in the OS credential store), server_call, the
                          event socket per server (`remote-event`), the lumina-remote:// media protocol + cache
  src/transfer.rs         the upload/download protocol (tests against a stand-in server: transfer_tests.rs)
  src/transfers.rs        the upload and download queues (saved, resumed, retried; `upload-progress` ...)
  src/client_db.rs        client.db in the app data folder: local copies of server photos ("On this PC"), the
                          device's basket (never on a server), this PC's libraries for All photos
  crates/lumina-core/     the engine, no Tauri: db, libraries, scan, thumbs, decode, video_frames, ffmpeg,
                          face_* (SCRFD + ArcFace via ONNX Runtime), clip, ai (Ollama), albums, files,
                          backup, import, watch, ...; tests.rs holds the engine tests
  crates/lumina-server/   headless server binary (serve / scan / libraries / restore-backup / users):
                          accounts.rs (users, sessions), http/ (axum: login, RPC table with roles, web client)
server/                   Dockerfile and docker-compose.yml (CUDA + ffmpeg + Ollama)
installer/                "Lumina Setup" (Windows)
scripts/                  release.ps1, set-version.ps1 (Windows); test-library/; linux/setup-cachyos.sh
```

The engine reaches its environment only through `trait Host` (`lumina-core/src/host.rs`): `data_dir()`,
`emit_value(event, payload)`, `allow_media_dir()`. The desktop implements it for Tauri's `AppHandle`
(feature `tauri`), the server with `ServerHost` (events go to the log and to waiters). Long work runs on
`tokio::task::spawn_blocking`, `std::thread` or the rayon pool `BG_POOL`; progress goes out as events
(`scan-progress`, `thumb-batch-ready`, `face-scan-progress`, `semantic-progress`, `ai-batch-progress`, ...)
with a final `done: true`.

## Data model essentials

- One SQLite database (`library.db`, WAL). A photo's id is a content hash (size + first/last 64 KB).
- `libraries (id, root)`; `photos.library_id` and `photos.rel_path` ('/'-separated) are kept in step with
  `photos.current_path` (the full local path) by SQLite triggers. `libraries::relocate` moves a library to
  a new root. Folder-scoped queries still use `current_path LIKE make_folder_prefix(root)`.
- Videos are `photos` rows with `media_type = 'video'`. Video faces carry their frame in the id.
- `photos.faces_engine`: the face engine that last scanned the photo (the server's backlog skips those).
- Migrations live in `db::migrate` (`PRAGMA user_version`: 1 screenshots fix, 2 libraries); they must be
  safe to run on every open and keep every count (see the ignored test `migrate_db_copy`).

## Commands

```bash
# Engine and desktop (from src-tauri/)
cargo check --workspace
cargo test --workspace --lib                 # ~90 tests; ~20 more are #[ignore] diagnostics
cargo test -p lumina-server                  # the server's own tests (a binary crate: --lib skips them)
cargo build --release -p lumina-server

# Frontend (from the repository root)
npm ci
npm test                                     # 89 tests
npx tsc --noEmit -p .

# Desktop app in development, on the test data (never on the real library)
LUMINA_DATA_DIR=~/LuminaTest/AppData npm run tauri dev

# Server on the test library
LUMINA_DATA_DIR=~/LuminaTest/ServerData ./src-tauri/target/release/lumina-server scan ~/LuminaTest/Library
LUMINA_DATA_DIR=~/LuminaTest/ServerData LUMINA_LIBRARIES=~/LuminaTest/Library ./src-tauri/target/release/lumina-server serve
```

Server configuration: `lumina-server.toml` (`data_dir`, `libraries`, `ollama_url`, `caption_model`, `listen`,
`web_dir`, `upload_library`) or the variables `LUMINA_DATA_DIR`, `LUMINA_LIBRARIES` (separated by `;`),
`LUMINA_OLLAMA_URL`, `LUMINA_CAPTION_MODEL`, `LUMINA_LISTEN` (default `127.0.0.1:8080`), `LUMINA_WEB_DIR` (the
built `dist`), `LUMINA_UPLOAD_LIBRARY` (default the first library). Uploads (`http/upload.rs`) are resumable and
land in `<library>/uploads/<user>/`; `/media/download/{hash}` sends originals with their BLAKE3.
`LUMINA_FFMPEG` names another ffmpeg. Accounts: `lumina-server create-user NAME --role admin` (see
`server/README.md`); HTTPS comes from `tailscale serve` in front of `127.0.0.1:8080`.

On the server every RPC command has a lowest role and names what it touches (`http/rpc.rs`, `http/access.rs`);
roles are per library (a default per user, `library_roles` overrides, admins server-wide) and guests see only
albums shared with them (`scope.rs`), so reads, media and events are filtered per user. Smart albums (saved
searches) can be shared too (`dynamic.rs`, `docs/plans/shared-dynamic-albums.md`): the server runs the search with
a Rust copy of the search language (`lumina-core/src/search.rs`, kept in step with `src/utils/searchRun.ts` by
`tests/fixtures/search-cases.json`) and the guest gets an album of its photos, never its query. An editing command also
says which photos it changed, so the server writes `changes` (who did what) and sends `photos-changed` / `people-changed` /
`albums-changed`, which other windows refresh from (`get_photos`; `useLiveUpdates`). The web client hides what
the role on the open library can't do through `useAccess()` (`src/components/auth/ServerGate.tsx`); admins have
an admin page (`src/components/admin/AdminPage.tsx`, `http/admin.rs`: status, jobs through the serve loop,
accounts, restore by upload with `restore.rs`); the server's pipeline runs the
library's background jobs, so the web client never starts them (`platform.libraryJobs`).

## Test library

94 freely licensed files (NASA public domain photos and videos, CC0 RAW files from raw.pixls.us, edge cases)
with `LICENSES.md`. On Windows it is `C:\LuminaTest\Library` (app data in `C:\LuminaTest\AppData`); on Linux
copy it to `~/LuminaTest/Library`. `scripts/test-library/build_test_library.py` rebuilds it but resizes with
a Windows PowerShell script. Known results on Windows: 94 files, 6 videos, 136 faces, a full server pass in
about 14 s, a second pass finds nothing to do.

## Platform notes

Windows-only code paths and their Linux counterparts (all in lumina-core):

| What | Windows | Linux |
| :--- | :--- | :--- |
| GPU for ONNX models | DirectML | CUDA 13 + cuDNN 9 (`ort` feature `cuda`; Arch: `pacman -S cuda cudnn`), CPU fallback; log says `GPU (CUDA)` or `CPU (GPU unavailable: …)` |
| Video frames | Media Foundation (`video_frames::mf`) | ffmpeg (`video_frames::ff`) |
| HEIC | WIC | ffmpeg (`decode::decode_with_ffmpeg`) |
| ffmpeg | downloaded, SHA-256 pinned | the system's (`ffmpeg::system_ffmpeg`) |
| File dates to local time | FileTimeToLocalFileTime | `localtime_r` (set `TZ` in containers) |
| Emptying `_Trash` | Recycle Bin, never permanent by surprise | no Recycle Bin: the UI asks for a permanent delete |

The ffmpeg paths were checked on Windows against the native ones (ignored tests
`ffmpeg_frames_match_media_foundation`, `ffmpeg_heic_matches_wic`). On the CachyOS machine (RTX 2070 Super,
driver 580) the engine tests pass and the server scans the test library on CUDA: 94 files, 6 videos with
5 frames each, 137 faces (one more than Windows, on CPU as well as CUDA), a full pass in about 9 s.

The pinned `ort` downloads an ONNX Runtime built for CUDA 13 only. The GPU counts only once the warm-up run
succeeds (`FaceModels::ready`, `ClipModels::load`): CUDA without cuDNN makes its sessions fine and fails
only when a model runs. The face scan skips photos whose analysis fails without a word, so 0 faces after a
scan means the models did not run.

## Lumina 5 plan and status

- **Phase 0 (released as 4.3.0):** lumina-core crate + `Host`; libraries table + relative paths; batch AI
  (`ai::run_caption_batch`) in the engine; frontend transport layer `src/api/`.
- **Phase 1 (on `lumina-5`, partly untested):** Linux counterparts (table above), `lumina-server`,
  `server/Dockerfile` + `docker-compose.yml`.
- **Phase 2 (done on `lumina-5`; the brief with milestones and what was built is `docs/plans/phase-2-server.md`):**
  HTTP API in the server (axum), HTTPS through `tailscale serve`, accounts from the start: `POST /api/rpc/{command}` with the existing command
  names, WebSocket events, `/media/{thumb|original|preview|face}/…` (the kinds of `MediaRef` in
  `src/api/transport.ts`), accounts with roles (viewer, uploader, editor, admin) and shared albums, a jobs
  table, the web client served from `/`, restore of a `.luminabackup` in the admin UI.
- **Phase 3 (on `lumina-5`; the brief is `docs/plans/phase-3-client.md`):** milestone 1 (the server's upload
  and download routes) done on Linux; milestones 2–4 done on Windows: the desktop app connects to servers
  (Settings → Servers, or the start screen) and opens their libraries next to local folders (the open library
  is a root plus its server, `setOpenLibrary(root, server)`; calls, events and media follow it, commands about
  this computer stay local, `LOCAL_COMMANDS`), uploads (drop on the window, or Library → Upload Photos; the web
  client's Upload button), downloads (selection → Download) with BLAKE3 checks, and "On this PC" badges, filter
  and "Remove from this PC". Checked on Windows against a lumina-server on 127.0.0.1; still to check over
  Tailscale with two accounts, and on Linux (keyring needs D-Bus' Secret Service; whether WebKitGTK streams
  server videos from lumina-remote:// as it can't from asset://). Milestone 5 (written, first run pending):
  `.github/workflows/desktop.yml` builds Linux (AppImage, .deb) and Mac (Apple Silicon .dmg; ONNX Runtime
  has no Intel Mac build; CoreML as the Mac's GPU) when a release is published, and on demand; the Mac app is
  client-only for now (`platform.fullApp`). See docs/RELEASING.md.
- **One view (on `lumina-5`; the brief is `docs/plans/one-view.md`):** All photos, this PC's folders and the
  servers' libraries in one grid. Milestone 1 done on Windows (the merged grid with marks and the Where filter,
  edits per home, the device's basket); next: backup with metadata, albums and people across sources, following
  shared albums.
- **Phase 4:** clients help with the server's AI backlog on request, and analyse photos before uploading.
- **Phase 5:** Android app (Tauri) with automatic backup (Kotlin WorkManager).

## First jobs on the Linux machine

1. Done: `cargo test --workspace --lib` passes on Linux (the tests now write paths the local way).
2. Done: the server on the test library (results under Platform notes; smart search finds "rocket launch").
   Still open: add a few iPhone HEIC files and videos to the test library.
3. Done: `server/docker-compose.yml` builds and runs (CUDA 13.0 + cuDNN 9 image, built on Ubuntu 24.04);
   in the container the test library gives the same results on `GPU (CUDA)`, and Ollama finds the GPU.
4. Done: one GPU for everything. Ollama and Lumina share the RTX 2070 Super (8 GB) by taking turns: the
   server pipeline unloads Ollama's models before faces and smart search (`ai::unload_loaded_models`) and
   drops its own before captions (`face_ort::release_models`). Lumina takes 1.3 GB idle, 3.3 GB scanning.
   Ollama must be 0.40 or newer (pinned in the compose file): up to 0.30 it ran the vision encoder on the
   CPU on any card with 10 GB or less, ~30 s per photo instead of ~4. Caption model `qwen3-vl:8b-instruct`
   (~4 s per photo, 34/37 layers on the GPU); `qwen3-vl:8b` is the thinking variant and named more things
   that weren't there on a 12-photo test set; `4b-instruct` is 1.5 s but invented details on 2 of 12.
5. Done: `npm run tauri dev` on Linux (WebKitGTK) opens the test library with thumbnails, 137 faces and
   smart search on `GPU (CUDA)`, on Wayland and on X11 (under X11 with NVIDIA the app turns off WebKit's
   DMA-BUF renderer itself, `system::linux_webkit_workarounds`). Video needs `gst-plugins-good` (without
   it WebKit's web process aborts). WebKitGTK can't stream Tauri's `asset://` URLs (tauri#3725), so on
   Linux the app serves local videos from 127.0.0.1 itself (`src-tauri/src/media_server.rs`: a random port,
   a token per run, video files inside the asset scope only; the CSP in `tauri.linux.conf.json`); photos,
   thumbnails and faces stay on `asset://`, and the Windows desktop keeps `asset://` for everything.

## Style

- Comments explain why, in plain sentences, at the density of the surrounding code; no banner comments.
- Names and idioms follow the file being edited. Rust: `Result<_, String>` errors with a readable message.
- New engine code goes in lumina-core and takes `&dyn Host` / `SharedHost`, never Tauri types; the desktop
  only adds a wrapper in `engine_commands.rs` and registers it in `lib.rs`.
- Frontend code calls the engine only through `src/api` (`call`, `subscribe`, `mediaUrl`), never
  `@tauri-apps/*` directly.
- User-facing text (UI, release notes in `src/utils/welcome.ts`, README) is plain and concrete.
