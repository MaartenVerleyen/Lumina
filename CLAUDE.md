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
                          (transport.ts, index.ts) and platform.ts (dialogs, updater, folders, file drop)
  hooks/library/*         state and actions per area (useFolder, usePeople, useAi, ...)
  components/, utils/     UI and pure helpers
tests/*.test.ts           frontend tests (node --test)
src-tauri/                Cargo workspace root, and the desktop app crate ("Lumina")
  src/lib.rs              Tauri setup and command registration
  src/engine_commands.rs  thin #[tauri::command] wrappers around lumina-core functions
  src/system.rs           desktop-only: open in Explorer, clipboard, splash screen
  src/prepare.rs          model download for the installer
  crates/lumina-core/     the engine, no Tauri: db, libraries, scan, thumbs, decode, video_frames, ffmpeg,
                          face_* (SCRFD + ArcFace via ONNX Runtime), clip, ai (Ollama), albums, files,
                          backup, import, watch, ...; tests.rs holds the engine tests
  crates/lumina-server/   headless server binary (serve / scan / libraries / restore-backup)
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
cargo test --workspace --lib                 # ~89 tests; ~20 more are #[ignore] diagnostics
cargo build --release -p lumina-server

# Frontend (from the repository root)
npm ci
npm test                                     # 68 tests
npx tsc --noEmit -p .

# Desktop app in development, on the test data (never on the real library)
LUMINA_DATA_DIR=~/LuminaTest/AppData npm run tauri dev

# Server on the test library
LUMINA_DATA_DIR=~/LuminaTest/ServerData ./src-tauri/target/release/lumina-server scan ~/LuminaTest/Library
LUMINA_DATA_DIR=~/LuminaTest/ServerData LUMINA_LIBRARIES=~/LuminaTest/Library ./src-tauri/target/release/lumina-server serve
```

Server configuration: `lumina-server.toml` (`data_dir`, `libraries`, `ollama_url`, `caption_model`) or the
variables `LUMINA_DATA_DIR`, `LUMINA_LIBRARIES` (separated by `;`), `LUMINA_OLLAMA_URL`,
`LUMINA_CAPTION_MODEL`. `LUMINA_FFMPEG` names another ffmpeg.

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
| GPU for ONNX models | DirectML | CUDA (`ort` feature `cuda`), CPU fallback; log says `GPU (CUDA)` or `CPU (GPU unavailable: …)` |
| Video frames | Media Foundation (`video_frames::mf`) | ffmpeg (`video_frames::ff`) |
| HEIC | WIC | ffmpeg (`decode::decode_with_ffmpeg`) |
| ffmpeg | downloaded, SHA-256 pinned | the system's (`ffmpeg::system_ffmpeg`) |
| File dates to local time | FileTimeToLocalFileTime | `localtime_r` (set `TZ` in containers) |
| Emptying `_Trash` | Recycle Bin, never permanent by surprise | no Recycle Bin: the UI asks for a permanent delete |

The ffmpeg paths were checked on Windows against the native ones (ignored tests
`ffmpeg_frames_match_media_foundation`, `ffmpeg_heic_matches_wic`). CUDA, the Docker image and the engine
tests have **not** been run on Linux yet.

## Lumina 5 plan and status

- **Phase 0 (released as 4.3.0):** lumina-core crate + `Host`; libraries table + relative paths; batch AI
  (`ai::run_caption_batch`) in the engine; frontend transport layer `src/api/`.
- **Phase 1 (on `lumina-5`, partly untested):** Linux counterparts (table above), `lumina-server`,
  `server/Dockerfile` + `docker-compose.yml`.
- **Phase 2 (next):** HTTP API in the server (axum): `POST /api/rpc/{command}` with the existing command
  names, WebSocket events, `/media/{thumb|original|preview|face}/…` (the kinds of `MediaRef` in
  `src/api/transport.ts`), accounts with roles (viewer, uploader, editor, admin) and shared albums, a jobs
  table, the web client served from `/`, restore of a `.luminabackup` in the admin UI.
- **Phase 3:** desktop client mode (connect to a server), uploads (hash first), downloads, an "available on
  this device" badge and filter, and shared folders from another server next to local libraries
  (`transportFor` picks the connection per library). Mac and Linux desktop builds.
- **Phase 4:** clients help with the server's AI backlog on request, and analyse photos before uploading.
- **Phase 5:** Android app (Tauri) with automatic backup (Kotlin WorkManager).

## First jobs on the Linux machine

1. `cargo test --workspace --lib` on Linux. Some engine tests use Windows paths (`D:\...`) with
   `make_folder_prefix`, which uses the platform separator: fix the tests or the code, whichever is wrong.
2. Run the server on the test library and check: `GPU (CUDA)` in the face scan line, thumbnails and frames
   for all 6 videos, 136 faces, smart search finds "rocket launch". Add a few iPhone HEIC files and videos.
3. Build and run `server/docker-compose.yml` (fix the CUDA / cuDNN / ONNX Runtime versions if needed).
4. With two GPUs: Ollama on the RTX 2070 Super, Lumina on the GTX 980 Ti (`device_ids` in the compose file).
   If ONNX Runtime's CUDA build doesn't support the 980 Ti (Maxwell), the models fall back to the CPU.
5. Try `npm run tauri dev` on Linux (WebKitGTK); the desktop app has only been run on Windows.

## Style

- Comments explain why, in plain sentences, at the density of the surrounding code; no banner comments.
- Names and idioms follow the file being edited. Rust: `Result<_, String>` errors with a readable message.
- New engine code goes in lumina-core and takes `&dyn Host` / `SharedHost`, never Tauri types; the desktop
  only adds a wrapper in `engine_commands.rs` and registers it in `lib.rs`.
- Frontend code calls the engine only through `src/api` (`call`, `subscribe`, `mediaUrl`), never
  `@tauri-apps/*` directly.
- User-facing text (UI, release notes in `src/utils/welcome.ts`, README) is plain and concrete.
