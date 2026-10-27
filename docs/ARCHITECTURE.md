# Lumina architecture

Lumina is a Tauri v2 app: a React 19 + TypeScript interface in a WebView2 window, and a Rust backend that does
all file, image, database and model work. The two talk through Tauri commands (`invoke`) and events.

The ground rule is that the interface never waits on heavy work. Commands that touch the disk or run a
model are `async` and move the work to `spawn_blocking` or to the shared background pool `BG_POOL`, a rayon
pool of one thread fewer than the CPU has, running at below-normal priority. Long jobs report progress
through events and can be cancelled.

## Data

One SQLite database (`library.db`, WAL mode) in the app's local data folder holds every library you open.
Queries for an open library are scoped by folder path. A photo is identified by a content hash (size plus
the first and last 64 KB). Identical copies get a path-salted hash, so each copy stays its own photo.

| Table | Holds |
| :--- | :--- |
| `photos` | path, EXIF (date, camera, lens, GPS), rating, flag, label, rotation, AI caption, OCR text, dHash, sharpness, staged move |
| `photo_tags`, `photo_people` | tags and people per photo |
| `photo_faces` | face boxes, crops, embeddings (little-endian f32 blobs) tagged with the engine that made them, names |
| `face_rejections` | "this face is not that person" decisions, used as negative examples |
| `people` | names, profile picture, hidden flag |
| `photo_clip` | one smart-search image vector per photo |
| `albums`, `album_photos`, `saved_searches`, `trip_names` | collections |

Thumbnails (480 px) and RAW/HEIC previews are cached as JPEG files next to the database, with face crops in
`faces/`. Thumbnails and previews rebuild when missing; face crops don't, so backups include them.

**Backups** (`backup.rs`) are zip files: `manifest.json` (format, version, library folders, counts), a
`VACUUM INTO` copy of the database, the frontend's settings and the face crops. A restore never swaps the
database under the running app. It unpacks the database next to the live one, checks it, rewrites every
stored path (`photos.current_path`, `staged_target`, face crop paths) through the chosen folder remaps in
one transaction and leaves it as `library.db.restore`. At the next start, before anything opens the
database, the current one is copied to `library-before-restore-<time>.db` and the restored one moves in.

**Settings** live in the frontend (`src/settings.ts`): one typed, validated `lumina_settings` entry in
localStorage, read anywhere with `useSettings()`.

## Backend modules (`src-tauri/src`)

| Module | Responsibility |
| :--- | :--- |
| `lib.rs` | shared types, app setup, command registration |
| `db.rs` | opening the database, schema and migrations, folder scoping |
| `scan.rs` | walking a folder, hashing, EXIF, duplicate and burst grouping; folds rows left by files edited in place into the current row |
| `storage.rs` | drive-aware I/O: few readers in folder order on a hard drive, full parallelism on an SSD |
| `imaging.rs`, `exif_meta.rs` | content hash, dHash, sharpness, screenshot detection; EXIF parsing |
| `decode.rs`, `fastdecode.rs` | RAW embedded previews, orientation, scaled JPEG decoding, in-process WIC for HEIC |
| `thumbs.rs` | the background thumbnail pipeline (readers, then a bounded queue, decoders on `BG_POOL`, a collector that writes to the DB and sends batches to the UI) |
| `face_ort.rs` | face engine: SCRFD `det_10g` detection with landmarks, alignment, ArcFace `w600k_r50` embeddings, on ONNX Runtime with DirectML (CPU fallback) |
| `face_match.rs` | person profiles, exclusive assignment with a margin, confidence tiers, clustering of unknown faces |
| `face_engine.rs` | the embedding cache used for matching |
| `face_scan.rs` | face detection: one photo on demand and the background face scan |
| `face_review.rs` | naming face boxes, match suggestions, accept / reject, "Who is this?" clusters |
| `people.rs` | the people list, tagging photos with a person, rename / merge / hide, profile pictures |
| `face_eval.rs` | manual benchmark on a labelled folder (`#[ignore]` test) |
| `clip.rs` | smart search: CLIP ViT-B/32 image encoder, multilingual text encoder, indexing job, query |
| `ai.rs` | Ollama: start, pull, flash-attention setting, per-photo caption/tags/OCR with a constrained JSON schema |
| `albums.rs`, `export.rs`, `files.rs`, `library.rs` | albums and smart albums; export; staged moves, commit, trash, XMP sidecars; offline place search |
| `face_quality.rs` | closed eyes (CLIP zero-shot on the aligned face) and face sharpness, measured in the face scan and backfilled for older faces |
| `highlights.rs` | highlights: a score per photo and a diverse pick (no two from one burst, spread in time and look) |
| `import.rs`, `watch.rs` | importing from cards, drives and folders (dated folders, duplicate check, verified copies, card detection); watching the open library for outside changes |
| `gallery.rs` | the shareable web page: resized photos without metadata and one self-contained `index.html` from `gallery_template.html` |
| `backup.rs` | backups, restore with path remapping, CSV export |
| `perf.rs`, `system.rs` | timing entries for the Session Log; system information |

Model files (face and CLIP) are downloaded on first use to a `.part` file, checked against a pinned SHA-256
and only then renamed into place.

### Scanning

```
walk folder ─► head read (hash + dimensions + EXIF in one read) ─► DB upsert ─► photos to the UI
                                                                      │
                                     background: thumbnails ─► thumb-batch-ready events (patched into the grid)
```

Each scan bumps `SCAN_GENERATION`. Workers check it, so opening another folder stops the previous scan's
background work, and events from an old scan are ignored.

### AI captions

`ai_analyze_photo` sends an 896 px JPEG to Ollama's `/api/chat` with a JSON schema that limits the length of
the caption, tags and OCR text. Lumina reuses the loaded model's context size where possible, because
changing it reloads the model. Ollama processes one request at a time for `qwen3-vl`, so the batch runs
sequentially. Flash attention gives about 10–15% more speed and Lumina can switch it on.

## Frontend (`src`)

| Path | Responsibility |
| :--- | :--- |
| `hooks/useLibraryState.ts` | composes the library hooks into the one `lib` object the components use |
| `hooks/library/` | one hook per area: `core` (folder, photos, selection, notifications, undo), `useFolder`, `useFilterState`, `useLibraryView` (visible photos, counts, compare), `useTriage`, `useStaging`, `useLocation`, `usePeople`, `useAi`, `useSmartSearch`, `useNaturalSearch`, `useCollections`, `useHighlights`, `useImport`, `useExport` (also web galleries), `useBackup`, `useHealth`, `usePreferences` |
| `hooks/useUpdater.ts` | the daily update check and install through `tauri-plugin-updater` (see `docs/RELEASING.md`) |
| `hooks/useKeyboardShortcuts.ts` | grid shortcuts (off while a dialog is open) |
| `App.tsx` | layout: header tabs, resizable side panes, the main view, dialogs |
| `app/` | App's helpers: remembered pane layout, app-level keys, window file drop, command palette actions, background jobs, search suggestions |
| `components/layout` | header, sidebars (filters and folders, people), inspector, toolbar, status bar, menus |
| `components/views` | justified virtualised grid, map, compare, collections, timeline |
| `components/modals` | Loupe, Face Review, export, commit, command palette and other dialogs |
| `utils` | pure, tested logic: search syntax, natural-language queries, people queries, grid layout, trips, RAW pairs, culling checks, highlights, backup path remapping, command search |

Grid and filter logic lives in `visiblePhotos` (one memo for every filter). The grid is virtualised with
TanStack Virtual over precomputed justified rows.

## Tests

- `npm test`: Node's test runner on `tests/*.test.ts` for the pure utilities.
- `cargo test --lib`: backend unit tests in `src-tauri/src/tests.rs`. Tests marked `#[ignore]` are manual
  benchmarks and diagnostics that need real files or models.
