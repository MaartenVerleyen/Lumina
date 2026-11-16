# Speed and reliability: review and plan

A review of the engine, the server, the desktop client and the phone app for speed, reliability and bugs
(2026-11-16, on 6.2.2), with a plan in phases. Nothing here is implemented yet.

## What the review covered, and what it didn't

Read closely: the database setup (`db.rs`, `libraries.rs`), listing a library (`scan.rs` `load_index`,
`list_library_photos`), people and face suggestions (`people.rs`, `face_review.rs`, `face_engine.rs`), smart
search (`clip.rs`), the edit commands (`library.rs`), the whole server HTTP layer (`http/mod.rs`, `rpc.rs`,
`media.rs`, `events.rs`, `upload.rs`, `scope.rs`, `host.rs`), the pipeline and serve loop (`pipeline.rs`,
`main.rs`), the watcher, the phone backup (`phone_backup.rs`), the server media cache (`remote.rs`), live
updates and the offline lists.

Only skimmed or not read: the scan's main loop and thumbnails (`scan.rs` 1010–1460, `thumbs.rs`, `decode.rs`),
moves and trash (`files.rs`), import, captions (`ai.rs`), the transfer queues (`transfers.rs`, `follows.rs`),
the Kotlin plugin, and most desktop UI components. Phase 5 covers them.

Nothing was measured: every speed finding comes from reading the code. The only numbers are from cachy's log
and file listing: `get_people` took 2.1 s, `library.db` is 1.19 GB, and the service held 8.5 GB of memory
(14 GB at its peak; this may include file cache). Phase 0 gets real numbers before anything is changed.

## Findings

### Reliability and bugs

| # | What happens | Where | Weight |
| :-- | :--- | :--- | :--- |
| R1 | **The server forgets file changes that arrive during an update.** After each update pass and each job the serve loop throws away every waiting watcher event (`changes.resubscribe()`), to skip its own. Files copied in, or uploads that land, while a long pass runs (captions can take hours) get indexed by the upload itself but get no faces, smart search or captions until something else changes. | `lumina-server/src/main.rs:174,183` | High |
| R2 | **"The server already has it" is answered from the database row, not the file.** A row is kept when its file is gone (on purpose, so ratings come back). The upload check counts such a row as present, so a photo whose file was lost on the server is never backed up again, and the phone shows it as backed up. | `scan.rs:780` `find_by_content`, `upload.rs` `check` | High |
| R3 | **The phone trusts its own "backed up" list forever.** Once a hash is in `phone_backup` it is never asked about again, so a server restored from an older backup, or a deleted file, is not noticed. | `phone_backup.rs:207-226` | Medium |
| R4 | **Uploads are not flushed to disk before they count as done.** `file.flush()` on a file does nothing; there is no `sync_all` before the file moves into the library and the phone marks it backed up. A power cut right after can leave a short or empty file. | `upload.rs:320`, `finish` | Medium |
| R5 | **Two chunks at the same offset both get written.** The offset check and the append are not locked together: a retry that overlaps the first try doubles the chunk. BLAKE3 catches it at the end, and the whole upload starts over. | `upload.rs:312-320` | Low |
| R6 | **Edits answer "done" when the write failed.** Flag, colour, rotation, basket, place, time shift and others ignore the errors of their transaction and commit (`let _ = tx.commit()`, 16 places). When the database is busy for more than 5 s (a scan writing), the window shows the change and the database doesn't have it. | `library.rs:87-339`, also `face_review.rs:578,646`, `files.rs:1057` | Medium |
| R7 | **The pipeline can wait forever.** Each step waits for a "done" event on a channel of 1,024 events. If that event is missed (the receiver fell behind) the server's pipeline stops for good, with no jobs until a restart. Unlikely, but nothing guards against it. | `pipeline.rs:20` `wait_for` | Medium |
| R8 | **A slow client loses change events without knowing.** When a socket falls behind, events are dropped silently, so that window keeps old ratings and names. On the client, a failed `get_photos` also drops the photos it was fetching. | `events.rs:184`, `useLiveUpdates.ts:23` | Medium |
| R9 | **The phone's Backup page can say "Counting the photos on this phone…" forever.** Every error of the status call is swallowed and the page has no error or permission state. This matches what happened on the fresh install. | `usePhoneBackup.ts:75`, `BackupScreen.tsx:282` | Medium |
| R10 | **Cache files are written in place.** A thumbnail from a server, the phone's backup state files, RAW previews and face crops are written directly; an app killed mid-write (Android does this) leaves a half file that is then shown or read as if whole. | `remote.rs:640,666`, `phone_backup.rs:122,352,795`, `decode.rs:521`, `face_scan.rs:296` | Low–medium |
| R11 | **The server only handles Ctrl+C.** `systemctl stop` sends SIGTERM, which ends the process at once, mid-write. SQLite survives this; half-made files don't (R10). During an update pass Ctrl+C isn't seen either. | `main.rs:156` | Low |
| R12 | A failed index after an upload leaves the file in the library with no row and no upload record; a retry uploads it again as "name (2).jpg". | `upload.rs` `finish` | Low |

### Speed: opening a library from a server

This is what a phone or browser waits for (the "no pictures for a long time" report). For each open of a
51,000-photo library the server does all of this, with nothing kept between requests:

| # | What happens | Where |
| :-- | :--- | :--- |
| S1 | `list_libraries` checks on disk whether every file of every library exists, only to count them. | `rpc.rs:215`, `libraries.rs:173` |
| S2 | The listing reads the photos table four times with `current_path LIKE … ESCAPE`, which can't use the path index (the column isn't NOCASE), then checks on disk for every photo: the file, its thumbnail, and for RAW its preview. | `scan.rs:491-660`, `681`, `703`, `717` |
| S3 | It copies every photo's smart search vector (about 100 MB for 51,000 photos) to work out duplicate groups again. | `scan.rs:688`, `clip.rs:631` |
| S4 | The answer becomes a JSON tree in memory, is walked to shorten paths, then written out and gzipped: several copies of tens of megabytes. | `rpc.rs:78,774`, `host.rs` `hide_data_dir` |
| S5 | The client downloads and parses all of it every time, also when nothing changed. | `useFolder.ts`, `offline.rs` |

### Speed: every request

| # | What happens | Where |
| :-- | :--- | :--- |
| S6 | Each request opens two or three new database connections (session check, scope, the command), each setting its pragmas and starting with an empty cache. | `db.rs:12`, `http/mod.rs:171`, `rpc.rs:741` |
| S7 | Each thumbnail request loads the user's whole scope; for a guest that reads every photo of every album shared with them. A screen of 300 thumbnails does that 300 times. | `media.rs:30`, `scope.rs:95` |
| S8 | Thumbnails are cached by the browser for an hour only, then asked for again one by one. | `media.rs:44` |
| S9 | `get_people` took 2.1 s on cachy. There is no index on `photo_people(person_name)` or `photo_faces(person_name)`, and the query filters by path. | `people.rs:9`, `db.rs:197` |
| S10 | The upload check scans the whole photos table once per file it doesn't find by hash (no index on `file_size`): 500 new photos are 500 scans. | `scan.rs:789` |
| S11 | Face suggestions are worked out again for every person after every confirm or reject ("seconds of every core", as the code says). This is the wait in the phone's face review. | `face_review.rs:98-270` |
| S12 | An open event socket checks its session in the database up to once a second during a scan. | `events.rs:141` |

### Speed: desktop and phone

| # | What happens | Where |
| :-- | :--- | :--- |
| C1 | A server thumbnail from the app's cache has no `Cache-Control`, so the web view asks again each time it scrolls back; each hit also rewrites the file's date. | `remote.rs:598-610` |
| C2 | While the server works (thumbnails, faces, captions) the window refetches photos every 250 ms and rebuilds its whole photo list each time. | `useLiveUpdates.ts:15-22` |
| C3 | The offline copy of a library goes between the web view and Rust as one JSON value of tens of megabytes, parsed and written out again on both sides. | `offline.rs:21-45` |
| C4 | The phone backup asks the database twice per photo for its content id (once to count, once to use it), and the status poll runs two counting queries every 1–2 s while the page shows. | `phone_backup.rs:185,192`, `usePhoneBackup.ts` |

## Measured (phase 0, 2026-11-16)

The ignored engine test `timing_of_a_large_library` makes a library of 50,000 made-up photos (100,000 faces,
50,000 smart search vectors, a 676 MB database, one-byte files) and times what the server does per window.
Release build, on the Windows PC, files in the system's cache (a cold disk or a busy server is slower):

| What | Time |
| :--- | ---: |
| Listing the library (S2, S3), all of it | 3.8–4.1 s |
| of which the four queries | 0.8–0.9 s |
| of which "is each file there" | 1.3 s |
| of which thumbnail checks, building and sorting the photos | about 1.5 s |
| of which duplicate groups | 0.2 s |
| of which copying the vectors | 0.05 s |
| The answer as a JSON tree, then as text: 77 MB (S4) | 0.6 s |
| The answer as text directly | 0.2 s |
| `list_libraries`: counting the files that are there (S1) | 1.4–1.5 s |
| `get_people` (S9) | 0.1 s |
| Upload check, 100 photos the server lacks (S10) | 0.2 s |
| Face suggestions for every person (S11) | 1.2–1.7 s |
| 300 new database connections with one small query each (S6) | 0.2 s |

What this changes:

- **Opening a library costs the server about 6 s** before gzip and the network (listing, JSON, and
  `list_libraries`), and nearly half of it is asking the disk about files (S1, S2). A kept listing removes
  all of it; counting from the database removes 1.4 s on its own.
- **S3 (copying vectors), S6 (connections) and S10 (upload check) are small.** They drop to "only if
  convenient".
- **`get_people` is fast here** but took 2.1 s on cachy, so that was load or a cold cache, not the query
  alone. The indexes still help; measure on cachy before and after.
- 77 MB per open is what the phone downloads (about a tenth gzipped) and parses: phase 3's "nothing changed"
  answer matters as much as the server's time.

## Phase 1 as built (branch `fix/6.2.3`)

Done: R1 (the watcher's changes have a channel of their own, `ServerHost::take_watched`; the watcher also
leaves Lumina's own cache folders alone), R2 (`scan::holds_file`; this also guards the phone's Free up space,
which asks the same question), R3 (a full check once a week), R4 and R5, R6 (the edit commands in `library.rs`
and naming or un-naming faces), R7, R8 (the socket sends `events-reconnected`, which every client already acts
on, at most once a minute), R9, R10.

- **R9 was not a permission problem.** On a new install no server is saved in the backup's settings yet; the
  page shows the first server signed in to, but the counts were only asked for a saved one. So "Counting…"
  stayed for good. The counts are now asked for the server the page shows, and errors are shown.
- **R11 dropped.** While a pass runs the serve loop can't see a signal, so catching SIGTERM would make
  `systemctl stop` wait 90 s instead of stopping at once. With R10 a sudden stop leaves no half files.
- **R12 not done** (rare, and the next scan indexes the file).
- Not checked on a device yet: R3 and R9 (they compile for Android).

## Phase 2 as built so far (branch `speed/phase-2`)

- **A kept list per library** (`lumina-server/src/listing.rs`, S2–S4): the answer to `scan_folder` is made
  once, gzipped, and kept until something changes. Every event that passes the server's host ends it, except
  a short list of ones that change nothing (and counting progress before its last event); so does every
  command above the viewer role, whatever it says it changed, and an age of ten minutes. It has an `ETag`,
  and a client that sends it back in `If-None-Match` gets "304 Not Modified" (no client does yet: phase 3).
  Used for people who see the whole server and ask for gzip (browsers, the desktop app and the phone all
  do); a guest's list is worked out as before.
- **`list_libraries` counts from the kept list** (S1), so the disk is asked once per change, not twice per
  window.
- **Indexes** (S9, S10): `photo_people(person_name, hash)`, `photo_faces(person_name, engine, face_id, hash)`,
  `photos(file_size)`, `photos(library_id, hash)`, added on open. Measured: the upload check for 100 new
  photos went from 0.2 s to 1.5 ms; `get_people` stayed at 0.1 s.
- **Face suggestions** (S11): measured first, half the time was the queries (reading face rows drags their
  embeddings along) and a quarter was making every person's profile again. The index on faces now answers
  "whose face is which" without the rows, and a profile is kept until that person's faces change
  (`face_match::kept_profile`). Same results, 1.0 s to 0.47 s per run on the generated library. Scoring only
  the people who changed was not done: a face goes to its single best person, so every person's score counts
  for every face, and that rework would touch the matching itself.
- **Each user's scope is kept** between requests (S7; `scope::Scopes`), ended by the album, share, role and
  library events, by every command above the viewer role, and after 30 s. A role changed from the command
  line while the server runs can so take up to 30 s to count.
- **Thumbnails and face crops are kept a day** by the browser (S8), instead of an hour.

Left out on purpose: library queries by `library_id` (S2: the list is made once per change now, and on a
server with one library the query reads the same rows either way) and connection reuse (S6: 0.7 ms per
connection measured).

Checked on a running server with the test library: the list is made once, a client with its tag gets 304, an
editor's change makes a new list with a new tag, a refused edit leaves the kept one.

## Phase 3 as built (branch `speed/phase-2`)

- **S5, the app keeps a library's list with the server's tag** (`remote.rs` `rpc_text`, `offline.rs`
  `KeptList`): the answer to `scan_folder` is written to the offline file as it came, with its `ETag` next to
  it. The next request sends the tag; on 304 the kept file is the answer. The desktop app and the phone
  both go through this. A guest's list has no tag and is fetched whole, as before.
- **C3:** the window no longer sends a library's list back to be kept (the app has it already), and
  `offline_load` hands the file over as text.
- **C1:** cached server thumbnails carry `Cache-Control` for a day; the "last used" date is written at most
  once a day per file.
- **C2:** a single change still shows after 250 ms; changes that keep coming are fetched every 1.5 s. A
  change to photos this window doesn't show no longer redraws it. Patching by index was left out: mapping
  50,000 photos takes about a millisecond, the redraw is the cost.
- **C4:** the phone backup looks up each photo's id once; the Backup page asks for the counts every 5 s
  when nothing is running (1 s while it is).

Not done: the web client. A browser would have to hold the list's text (tens of megabytes) in memory to
answer a 304 from; that waits for phase 4. Not checked in the running apps yet: the kept list on the
desktop and the phone (its parts are tested, the server side was checked with curl).

## Phase 4 as built (branch `speed/phase-2`)

Built without the revision column the plan below describes: nothing in the database changed, and nothing in
the window.

- **The server tells lists apart** (`listing.rs`, `Track`): each list it makes is compared with the one
  before, photo by photo (a fingerprint of each photo's JSON). It holds the JSON of photos that changed
  since, up to 32 MB per library.
- **A client names its list and says it takes differences** (`If-None-Match` with `X-Lumina-Differences: 1`):
  the answer is `{"changed": [{"after", "photo"}], "removed": [...]}` with the tag of the list it starts
  from in `X-Lumina-Differences`. Older apps and the web client don't send the header and get the whole list.
- **The app works them into its kept list** (`lumina-core/src/list_changes.rs`, `remote.rs` `rpc_text`) and
  hands the window the result: 52 ms for a 72 MB list with 200 changed photos (release build). When they
  don't fit, it asks for the whole list.
- **The whole list is sent** after a server restart, when photos changed places (a date edit that reorders
  the list), when more than 32 MB changed (a pass over every photo), and when the differences are over half
  the list's size.

What this leaves: the server still makes the whole list after every change (about 4 s for 50,000 photos,
once, for all clients). A revision per photo in the database would remove that too; it is the larger change
and can still be done behind the same protocol.

Checked on a running server with the test library: one rating changed gave 1 KB of differences in place of
the 32 KB list. Not checked in the running apps.

## A revision per photo, as built (branch `speed/phase-2`)

What phase 4 left: the server made the whole list again after every change. Now it reads only the photos
that changed.

- **The database** (`lumina-core/src/revision.rs`, run by `db::migrate`): `photos.rev`, a counter in the
  one-row table `revision`, an index on `rev`, and triggers on `photos`, `photo_tags`, `photo_people` and
  `photo_faces` that give a photo the next revision when something a listing shows changes. Writing the
  same values again (a scan that finds nothing new) moves nothing; neither does a face's embedding.
- **The server's kept list** (`listing.rs`) holds each photo's JSON. After a change it asks for the photos
  with a newer revision (`revision::changed_since`), reads them again (`scan::library_photos_by_hash`), gives
  them back their library-wide links (`scan::keep_links`) and replaces them. A change that shows in no photo
  leaves the list and its tag as they were. The whole list is gzipped only when a client needs all of it.
- **The whole list is still made anew** when a photo came or went (the library's row count differs, or a
  changed photo isn't in the list), when a changed photo's name, folder, date, type, dhash or camera changed
  (the RAW pairs, Live Photos and duplicate groups come from those), after a scan or a smart search pass
  ended, when more than 5,000 photos changed, and every 30 minutes.

Measured on the generated library of 50,000 photos (release, Windows): after 20 photos were rated, counting
the rows takes 13 ms and finding and reading the changed photos 8 ms, where making the list takes 3.8 s.
Making the library itself (50,000 inserts with faces and tags) went from 30 s to 38 s with the triggers.

Costs: the server holds each library's list as JSON in memory (about 77 MB for 50,000 photos, where it held
9 MB gzipped), and every write to a listed column is followed by two small ones.

Checked on a running server with the test library: a rating changed was "1 photos read again in 5 ms", and
the kept list was byte for byte the list made from scratch. An existing database (the test server's) took
the new column and triggers at its next start.

## Fewer and faster rebuilds, as built (branch `speed/phase-2`)

The cases above where the whole list was still made, and what became of them:

- **A, kept ready in the background** (`listing::keep_ready`): a thread brings every served library's list up
  to date 2 s after something changed, and makes them when the server starts. A window that opens a
  library finds its list ready; nobody waits for a rebuild that a scan or a pass caused.
- **B, a scan no longer means a rebuild:** after a scan (and when a list is 30 minutes old) each folder is
  listed once for files that went (`LibraryList::missing_files`, 64 ms for 50,000 photos); new files have
  rows, and so revisions. A list made anew that is the same as before keeps its tag.
- **C, a faster rebuild** (`scan::Folders`, `scan::Disk`): one listing per folder where every file was asked
  about, and on Windows one listing of the thumbnails folder. 3.9 s became 2.2 s for 50,000 photos.
- **D, photos that come and go** (`lumina-core/src/library_list.rs`): the kept list takes a new photo in
  its sorted place and drops one that went, and works the links between photos out again only when something
  they come from changed (also after a smart search pass). A photo with a new name is sent to clients as
  one that went and came. Measured on 50,000 photos: a photo that came 0.34 s, one that went 0.28 s, the
  links alone 0.21 s, a rating 16 ms.

The whole list is now made anew only at the server's start, for an event this server doesn't know, when a
library was added or removed, when more than 5,000 photos changed at once, and once a day, all in the
background. The server holds each library's photos twice (as the engine's photos and as JSON): about 150 MB
for 50,000 photos.

Checked on a running server with the test library: the lists were made at start, a rating was followed 3 s
later with nobody asking, and the kept list was byte for byte the list made from scratch. In the tests a
kept list equals the list made anew after a rating, a photo that came, a file that went and a row that went.

## Phase 5: findings from the second reading

Read: the phone's backup worker (`Backup.kt`) and its pass (`phone_backup.rs`), moves and trash (`files.rs`),
the transfer queues (`transfers.rs`: how they save, run and take in downloads), the import's copy and
delete (`import.rs`), the caption batch (`ai.rs`), the thumbnail pass (`thumbs.rs`, in part), and where
the desktop window works on the whole photo list (`useLibraryView.ts`). Not read yet: the scan loop itself,
`export.rs`, `backup.rs`, `follows.rs`, `LuminaPlugin.kt`, `PhoneStore.kt`, `VirtualPhotoGrid.tsx`.

| # | Finding | Where | Effort |
| :-- | :--- | :--- | :--- |
| P1 | An import with "delete from the card" removes the original once the copy has the same size and the same first and last 64 KB. The middle of the file is never compared and the copy isn't flushed to disk first. | `import.rs` `copy_verified`, `run_import` | S |
| P2 | A move across drives copies, compares only the length, and removes the original without flushing the copy: a power cut right after can leave neither. | `files.rs` `move_file` | S |
| P3 | After a file is moved, a failed database update is ignored and the move is counted as done. The row keeps the old path and its staged move until a scan finds the file again. | `files.rs` `commit_staged_blocking` | S |
| P4 | A queue that is just finishing doesn't start again for files added in that moment: they stay "waiting" until the next upload, download or restart. | `transfers.rs` `start` | S |
| P5 | Followed photos are taken into the library after the whole download pass. If the app closes in between, the files are there but their tags and people names never arrive. | `transfers.rs` `download_pass`, `take_in` | M |
| P6 | A phone backup that finds another one running answers "busy", which Android takes as done: a selection sent with Back up waits for the next hourly run. | `Backup.kt` `doWork`, `phone_backup.rs` `pass` | S |
| P7 | With Ollama stopped, a caption batch tries every photo three times and reports each as failed, where it could stop after a few that couldn't connect. | `ai.rs` `run_caption_batch` | S |
| P8 | The thumbnail pass goes on without a database connection when it can't open one: thumbnails are written, their dhash and size never stored. | `thumbs.rs` `run_thumbnail_pass` | S |
| P9 | Every change to the photo list (one rating) works the timeline, the folder tree, the tag list, the filter and the sort out again over all photos. Not measured: needs the real window with a large library. | `useLibraryView.ts` | M |

### Fixed (uncommitted on `speed/phase-2`)

- **Trash** (Maarten's call): emptying `_Trash` takes only photos whose move there was applied. One only
  staged for `_Trash` stays in its folder, and isn't counted beforehand (`trash_targets`).
- **P1, P2:** before an original goes (an import that deletes from the card, a move to another drive) the
  whole copy is compared with it and written through to the disk (`files::copy_is_safe`). Such an import
  reads every file a second time.
- **P3:** a move the database couldn't note is reported with the file, not passed over.
- **P4:** a queue that was ending when files were added starts again for them.
- **P5:** a followed photo that landed keeps a mark (`Item::take_in`) until it is in the library with its
  tags and names; an app closed in between does it at the next run.
- **P6:** a selection's backup that found another one running is tried again by Android.
- **P7:** a caption batch stops after three photos in a row that couldn't reach Ollama.
- **P8:** a thumbnail pass that can't open the library says so in the log.
- **Found while fixing:** a follow no longer ends when the server's answer isn't a list of albums
  (`follows.rs`); a photo saved to the phone's gallery that couldn't be written whole is removed, not left
  empty and reported as saved (`PhoneStore.saveToGallery`); the phone looks each media column up once, not
  per photo; an engine test that scanned without taking the scans' turn failed now and then.

Tests: emptying the trash with one moved and one staged photo; a copy with another middle is refused.
The Kotlin changes are not compiled here (no Gradle build was run) and nothing was tried on the phone.

### Still open

- **P9** (the window works everything out again on every change), measured outside the window: the same
  work in Node, with the app's own helpers, on generated photos, after one rating changed. Drawing the grid
  again is not in these numbers.

  | Worked out again | 50,000 photos | 175,000 photos |
  | :--- | ---: | ---: |
  | Filter (none set) and sort by date | 27 ms | 119 ms |
  | Grid layout | 9 ms | 47 ms |
  | Timeline buckets | 8 ms | 36 ms |
  | Photo-by-id map | 7 ms | 36 ms |
  | Counts and best of each burst | 6 ms | 14 ms |
  | Burst stacking | 6 ms | 24 ms |
  | Folder tree | 5 ms | 22 ms |
  | All tags | 5 ms | 13 ms |
  | Together | 72 ms | 311 ms |

  The sort is the largest part, and a rating changes nothing it sorts by (unless sorted by rating).

  **Built** (`src/utils/photoChanges.ts`, `useLibraryView.ts`, the layout in `App.tsx`): the window asks
  which photos differ between the list before and the new one (`changesBetween`), and each part keeps what
  it had when none of them changed in what that part reads. The timeline, folder tree, tag list and counts
  stay as they were; the sorted and the stacked list take the changed photos' new selves in their places
  when each still passes the filters and sorts where it did; the layout stays while shapes and dates do. A
  photo that came or went, a changed filter or sort, or more than 200 photos changed at once work
  everything out as before.

  The same measurement after: 6 ms for 50,000 photos (was 72) and about 57 ms for 175,000 (was 311). What
  is left is the photo-by-id map (`core.ts`), made anew each time: other parts of the window are worked out
  again when it is a new map, so it was left alone.

  Not checked in the real window: the test follows a sorted, filtered list through 300 edits against the
  list worked out anew, but drawing was not measured and nothing was clicked through.
- A followed photo is marked as taken when it is queued, not when it lands: one whose download fails for
  good and is cleared from the list is never asked for again (`follows.rs` `sync`).
- Not read: the scan loop itself, most of `LuminaPlugin.kt`, `VirtualPhotoGrid.tsx`. Read and nothing found:
  the restore (`backup.rs`), export's writes.

## The plan

Each phase is one branch and can be one release. Effort: S is under an hour of work, M a few hours, L a day
or more.

### Phase 0: measure first (no change in behaviour)

- A large test database: either a generated one (50,000 photos, 100,000 faces, vectors; a script next to
  `scripts/test-library/`), or a copy of cachy's made with `.backup`. **The copy needs your OK** (the rule
  about real libraries); the generated one doesn't.
- A timing test for opening a library, split per step (queries, disk checks, duplicates, JSON, gzip), and
  `EXPLAIN QUERY PLAN` for `get_people` and the listing queries.
- On cachy, with your OK: request times per command from the log, and the server's own memory against file
  cache, to see whether 8.5 GB is a problem at all.
- Result: the tables above with numbers, and phases 2–3 reordered by what actually costs time.

### Phase 1: reliability (candidate for 6.2.3, with the AppImage fix that is waiting)

| Item | Change | Effort |
| :-- | :--- | :--- |
| R1 | Tell the pipeline's own "files changed" event from the watcher's (a flag in the payload), and keep watcher events that arrive during a pass as pending. | S |
| R2 | The upload check also looks for the file on disk; a row without a file counts as missing, and the upload takes over that row. | S |
| R4, R5 | `sync_all` on the last chunk and before the move; one lock per upload id around check and append. | S |
| R6 | The edit commands return their errors; the window already shows errors from `call`. | M |
| R7 | `wait_for` gets the step's "running" flag as a second way out, and logs when it leaves by that way. | S |
| R8 | The socket sends a `resync` event after it fell behind (the window then lists the library again); `useLiveUpdates` puts failed hashes back. | S |
| R9 | The Backup page shows the error and, without the media permission, a button to give it. First reproduce on the phone. | S–M |
| R10 | Write to a temporary file and rename, in the five places. | S |
| R11 | Handle SIGTERM like Ctrl+C. | S |
| R3 | A full check against the server once a week (one `content_hashes` round), dropping what the server no longer has. | M |

Tests: a server test for R1 (a file added during a pass gets its faces), R2 (row without file is "missing"),
R5 (two chunks at one offset); an engine test for R6 on a locked database.

### Phase 2: the server answers faster (no change to what clients send)

| Item | Change | Effort |
| :-- | :--- | :--- |
| S1 | Count from the database. Missing files are found by the scan, which already runs on every change. | S |
| S9, S10 | Indexes: `photo_people(person_name, hash)`, `photo_faces(person_name)`, `photos(file_size)`, `photos(library_id, hash)`. **This adds to the database layout, so it needs your OK**; indexes are safe to add on open and change no counts. | S |
| S2 | Library queries by `library_id` when the folder is a library root (it nearly always is). | M |
| S2–S4 | Keep each library's listing in memory on the server, as finished gzipped JSON with a version number, and drop it when anything in that library changes (the server already knows: `Changed`, the pipeline's events). Guests keep the filtered path. Sends an `ETag`. | L |
| S6 | Reuse connections: a small pool of read connections and one for the session check. | M |
| S7, S12 | Keep each user's scope in memory until an album, share or role changes (those events exist: `SCOPE_EVENTS`). | M |
| S8 | Thumbnails: `Cache-Control` of a day, plus `ETag` so the check after that is cheap. | S |
| S11 | Keep each person's profile between runs and score only the people whose faces changed. | L |

### Phase 3: desktop and phone

| Item | Change | Effort |
| :-- | :--- | :--- |
| S5 | The client sends the listing's `ETag` back; "nothing changed" is one small answer and the kept list opens at once. Depends on phase 2's listing cache. | M |
| C1 | `Cache-Control` on cached server thumbnails; touch the file's date at most once a day. | S |
| C2 | Collect changes for longer while the server reports work in progress (1–2 s), and patch the list by index instead of mapping all of it. | M |
| C3 | Keep offline lists as text: the web view hands over and gets back a string, not a parsed value. | S |
| C4 | Read the phone's known ids once into a map; poll the counts only when something changed. | S |

### Phase 4: only what changed (architecture: needs your decision first)

Phases 2–3 make an unchanged library open at once. A changed one is still fetched whole. The step after that:
a revision number per photo (a new column, bumped on every change), and a command "what changed since
revision N" so clients fetch a few rows instead of 51,000. This changes the database layout and how clients
talk to the server, and old clients must keep working. Worth doing only if phase 0 and phase 3 show that
whole fetches still hurt (they will on mobile data).

### Phase 5: the rest of the review

The same reading for what wasn't covered: the scan loop and thumbnails, moves and trash, import, captions,
the transfer queues and follows, the Kotlin plugin (work constraints, what Android does when it stops the
worker), and the desktop grid with a large library (render cost, filter cost per keystroke).

## Order and releases

1. Phase 0 and phase 1 together: phase 1 doesn't depend on the numbers, and fixes the two backup holes
   (R1, R2).
2. Phase 2, starting with S1 and the indexes (small, likely the biggest gain per line), then the listing
   cache.
3. Phase 3, then a decision on phase 4 with numbers in hand.

Each phase ends with `cargo test --workspace --lib`, `cargo test -p lumina-server`, `npm test`,
`npx tsc --noEmit -p .`, and a pass by hand on the test library; cachy is upgraded only when you say so.
