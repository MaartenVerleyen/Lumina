# One view: every photo you may see, wherever it is

Status: proposal for Maarten to read and agree to before work starts (2026-11-04).

## Why

A household has one server, a desktop, a laptop and two phones, and parents and parents-in-law who get
shared albums. Each device should show, in one place, the photos on the server that its account may see
and the photos on the device itself, and make clear which photos aren't backed up yet. Parents and
parents-in-law manage their own library and see albums shared with them next to it.

Today the app opens one library at a time: a folder on this computer, or one library of one server. That
stays (decision 5), and next to it comes **All photos**: one view of several sources at once.

## Decisions (Maarten, 2026-11-04)

1. At backup, a photo's ratings, flag, label, tags, caption, people names and albums go to the server with
   it. From then on the server's copy is the one that counts.
2. Which local folders count as "this device's photos" is a list in Settings. Every folder opened on this
   device is on it by default and can be taken off.
3. People names and tags travel with the photos: whoever sees a photo (a guest, another device) sees who
   is in it and its tags, and a downloaded copy takes them along. Everyone can still name people and tag
   photos in their own library, and give a person from someone else's library a name of their own:
   cachy's "Me" shows as "Maarten" for Dad, merged with Dad's own "Maarten", with all photos of both.
   That name is Dad's alone; cachy's "Me" doesn't change.
4. Guests don't back up to someone else's server. Instead a guest can **follow** a shared album: its
   photos are downloaded into a library of their own (a folder on their computer, or a library on a server
   where they may upload), and new photos in the album follow by themselves. When the album stops being
   shared, the guest loses the album but keeps the photos they downloaded.
5. Opening one library on its own stays as it is.
6. A photo on the server has its rating, flag, label and tags on the server. Changing them from any device
   (by someone who may edit) changes the server's values. The basket is per device: putting photos in it
   on the laptop doesn't put them in the desktop's basket, or in anyone else's.

## The words used below

- **Source**: one place photos come from. A local folder on this device (`D:\Photos`), or a library on a
  server as this account sees it (cachy's `/photos`; for a guest only what is shared with them).
- **Copy**: a photo in one source. The same photo in two sources is two copies of one photo: photos are
  matched by their id, the content hash, as everywhere in Lumina.
- **Home**: the copy whose ratings, people and albums are shown, and where edits go.
  - The server's copy, when the photo is on a server library this account may edit (editor or admin).
  - Otherwise the copy in this device's library.
  - A photo only on a server this account may not edit (a guest's shared album, a viewer's library) has
    no home you can edit: it is read-only, as it is today.
- **Backed up**: the photo is on a server library this account may upload to (uploader or higher).

## The household, as an example

- **cachy**, the server, library `/photos`: 60,000 photos.
- **Maarten's desktop**: `D:\Photos` (40,000 photos, 38,500 of them also on cachy); signed in to cachy as
  `maarten` (admin).
- **The laptop**: `C:\Users\Partner\Pictures` (3,000 photos, none on cachy yet); signed in as an editor.
- **The phones**: later (phase 5). The camera roll is then the phone's local source, with the same view.
- **Dad**: Lumina on their own desktop with `C:\Users\Dad\Pictures` (8,000 photos); guest on cachy; the
  album "Kids 2026" (120 photos) is shared with them.
- **The parents-in-law**: the web client or a phone; guests; "Kids 2026" is shared with them too.

## All photos

### What Maarten's desktop shows

All photos on the desktop is cachy's `/photos` plus `D:\Photos`: 60,000 + 40,000 copies, which are
61,500 photos, because the 38,500 photos in both places show once.

Every tile carries a small mark of where it is:

| Mark | Meaning | Count on Maarten's desktop |
| :--- | :--- | :--- |
| Not backed up (amber) | only in a local folder | 1,500 |
| On the server only (cloud) | only on cachy | 21,500 |
| No mark | in both places | 38,500 |

The left sidebar gets a **Where** filter next to the existing ones: All · Not backed up · On this PC ·
Server only. "Not backed up" with **Back up now** above the grid is the main reason for the view: one
click and the 1,500 photos go to cachy (see Backup below).

The laptop shows the same server photos plus its own 3,000, all 3,000 marked "Not backed up" until the
laptop backs up.

The folder tree shows each source as a top-level entry:

```
This PC
  D:\Photos
    2024 ...
cachy
  /photos
    uploads/maarten ...
```

Opening a folder in the tree filters All photos to it, as the folder tree does today within a library.

### What Dad's desktop shows

All photos on Dad's desktop is `C:\Users\Dad\Pictures` plus what cachy shares with Dad: 8,000 + 120.
Dad may upload nowhere, so there are no "Not backed up" marks (decision 4). The shared photos carry a
**Shared by maarten** mark, and in Collections "Kids 2026" is listed under *Shared with you*.

Dad can rate, tag and name people in their own 8,000 photos as today. The 120 shared photos show
maarten's people and tags, but can't be changed: the rating stars, flags and tag fields are greyed out,
with "Shared by maarten: you can look, not change". Dad can put them in the basket (it's Dad's own, on
Dad's device) and give the people in them names of Dad's own (see People).

If Dad follows "Kids 2026" (below), the 120 photos are also in Dad's library, with maarten's people and
tags. Then they are Dad's own copies: Dad can rate and tag them, and those ratings stay in Dad's library.
The mark changes to **In your library · from Kids 2026**.

### What the web client shows

The web client has no local folders: All photos is every library of the server this account may see,
in one grid. For a household with one library that is the same as opening it; with two libraries (say a
second one for scanned slides) it shows both.

### Choosing the sources (Settings → All photos)

```
In All photos
  [x] D:\Photos                      (this PC)
  [x] E:\Scans                       (this PC)
  [ ] C:\Temp\import-test            (this PC)
  [x] cachy · /photos
```

Every folder opened on this device is added ticked; untick a scratch folder to leave it out. Server
libraries the account may see are added ticked too.

### Which data a tile shows

The home's. For a photo in both places on Maarten's desktop that is cachy's copy: if the laptop rated it
4 stars on cachy yesterday and `D:\Photos` still says 2, the tile shows 4.

The local copy is kept in step with the server, one way: while All photos is open, a photo whose home is
the server copies the server's rating, flag, label, tags and caption into the local library when they
differ, quietly. So opening `D:\Photos` on its own (decision 5) also shows 4 stars, and nothing is lost
when the server is unreachable. Faces and people are not copied this way (see People).

### Editing

Each edit goes to the home of each photo. For a photo on the server that is the server, from whichever
device the edit is made (decision 6): a rating given on the laptop is cachy's rating, and the desktop and
the phones show it within seconds.

- Maarten selects 30 photos: 20 in both places, 10 not backed up, and gives them 5 stars. The 20 go to
  cachy (and, from the step above, into `D:\Photos` too), the 10 to `D:\Photos`. One undo undoes both.
- Dad selects 10 own photos and 5 shared ones and adds the tag `birthday`. The 10 get it; for the 5 Lumina
  says "5 photos are shared with you and can't be changed".
- The basket is kept on the device (in `client.db`; in the web client in the browser), for photos of any
  source, and never sent to a server. Dad can collect 20 of their own photos and 5 shared ones in it.
- Moves, renames and the `_Trash` work only within one source. In All photos they work for a selection
  from one source; for a mixed selection Lumina asks to open that library on its own.

### Search, map, timeline, trips

These work on the photo list in the window and work across sources unchanged: `rating:>=4 person:Emma`
finds Emma's best photos on this PC and on cachy together.

Smart search (CLIP) runs inside each source's engine. All photos asks every source and merges the
results by score; the server and the desktop use the same model, so the scores compare. A photo found in
two sources counts once, with its best score.

### Collections

Albums stay albums of their source and are listed per source:

```
Albums
  On cachy:     Holiday 2025 · Kids 2026 · ...
  On this PC:   Wedding (local)
Shared with you
  Kids 2026 (from maarten)            ← on Dad's desktop
Smart albums
  On cachy:     Photos of Emma ...
```

Adding a selection to an album adds the photos that are in that album's source; for the rest Lumina offers
to back them up first (household) or says which can't be added (guests).

## People

### Names travel with the photos

A photo shows who is in it and its tags wherever it is seen (decision 3):

- On Dad's desktop the 120 shared photos show maarten's people ("Me", "Emma", ...) and tags; `person:Emma`
  finds them, and the People list has them under *From cachy*.
- When Dad follows the album, the downloaded copies take the names and tags along: Dad's Lumina finds the
  faces itself, and each name goes to the face found at the same place in the photo (as at backup). While
  the album is shared, names and tags maarten adds later are added to Dad's copies too; Dad's own names
  and tags are never taken away.

### A name of your own for someone else's person

Everyone can give a person from a library they don't edit a name of their own:

- On Dad's desktop, cachy's "Me" is Maarten. Dad opens "Me" and chooses **Call this person… → Maarten**.
  Dad already has a "Maarten" in their own library, so the two show as one: one **Maarten** in Dad's
  People list, with Dad's 300 photos of Maarten and the 40 shared ones. `person:Maarten` finds all 340.
- Downloaded copies of followed photos get "Maarten" instead of "Me" in Dad's library.
- Nothing changes on cachy: Maarten's person is still "Me" for maarten and every other account. Only Dad
  sees "Maarten".
- The name is kept on cachy with Dad's account (`person_names (user, person, shown_as)`), so Dad's
  desktop, phone and the web client all show "Maarten". cachy learns only what Dad calls "Me".
- **Use their name again** undoes it.
- A guest who uses only the web client (the parents-in-law) can do the same: "Me" can become "Maarten"
  or "Son" for them.

### Within the household

On Maarten's desktop, cachy's people and the people in `D:\Photos` mostly have the same names: "Emma" on
cachy and "Emma" on this PC show as one Emma (same name, same person). Different names stay apart until
someone gives one a name of their own, as Dad does. After a backup the local names are on cachy too
(decision 1), so this mostly sorts itself out.

Within one library a person is their name, as today: two people can't share a name there, and renaming
one to a name that exists merges them. Across sources the same name shows as one person, unless it isn't:
if cachy's "Emma" and the laptop's "Emma" are two different children, **Not the same person** keeps them
apart in All photos as "Emma (cachy)" and "Emma (this PC)". Neither library changes; the choice is kept
like a name of your own (with the account on the server). Renaming one of them works too.

Naming a face goes to the photo's home, as editing does: on Maarten's desktop, a face in a photo that is
in both places is named on cachy.

Lumina can suggest names: both engines use the same face model, so a person whose faces look like a
person in another source gets "Looks like Maarten on this PC: call them Maarten?". That is a later
milestone.

## Backup

**Back up now** (in the Where filter, and on a selection) uploads the photos that aren't backed up to the
server, with the existing upload queue (`src-tauri/src/transfers.rs`: resumable, retried, BLAKE3-checked).
They land in `uploads/<user>/` as uploads do today.

With each photo goes what Lumina knows about it (decision 1): rating, flag, label, tags, caption, the
names of its albums and the people named in it with their face boxes.

- **Ratings, flag, label, tags, caption**: set on the server copy when the upload finishes, unless the
  server copy already had them (the same photo uploaded earlier from another device: the server's values
  stay).
- **Albums**: the photo goes into the server album of the same name; the album is made if it doesn't
  exist. "Wedding (local)" becomes "Wedding" on cachy.
- **People**: the server finds the faces itself. Each named face is matched to a face the server found at
  the same place (box overlap) and gets its name. If the server has no person of that name, one is made.
  Faces the server doesn't find keep no name, and the photo is listed in the backup report.
- After the backup the photo is in both places and its home is the server.

Example: the laptop backs up its 3,000 photos. The upload sends 2,950 files (50 were already on cachy from
the desktop: those send no file and keep cachy's ratings). The server makes thumbnails, finds faces and
captions them as for any upload; once a photo's faces are found, the names from the laptop are put on.
All photos on the laptop then shows no amber marks.

## Following a shared album (guests)

A guest can **Follow** an album shared with them (Collections → Shared with you → Follow):

```
Follow "Kids 2026"
  Into:  ( ) C:\Users\Dad\Pictures\Kids 2026        (a folder on this PC)
         ( ) On dads-server · /photos/Kids 2026     (a library where you may upload)
  The photos are yours to keep, also if the album stops being shared.
```

- Lumina downloads the album's photos into that folder (photos Dad already has, by hash, are skipped) and
  adds them to Dad's library: they appear in All photos as Dad's own copies, with their own ratings.
- When maarten adds photos to the album, Dad's devices get `albums-changed`, see new photos, and download
  them. When the app isn't running, it catches up at the next start.
- A photo taken out of the album stays in Dad's library.
- When maarten stops sharing the album with Dad, Dad loses the album: it goes from *Shared with you*, the
  shared copies go from All photos, and the follow ends. The downloaded photos stay in Dad's folder and
  library as Dad's own, with the people and tags they had, and Dad's own ratings.
- Into a server library: Dad's desktop downloads from cachy and uploads to Dad's server, with the same two
  queues. This happens while Dad's desktop app runs; a server never logs in to another server.
- What follows a photo: the file, its people names (as Dad calls them) and its tags. maarten's ratings,
  flags and labels stay maarten's; the caption and faces are made by Dad's own Lumina.
- **Unfollow** stops new downloads; what was downloaded stays.

The follows are kept per device in `client.db`: (server, album id, destination).

## What stays as it is

- Opening one library (a folder, or a server library) works as today, with its own folder tree, albums and
  people (decision 5). The Library menu gets **All photos** at the top.
- The server's API changes little: All photos calls the same RPCs per source. New on the server are only
  the metadata that comes with an upload, and "set these values unless set" for backup.
- Photos are never modified; moves stay the staged-move flow within one library.

## How it is built (for review)

This changes how the frontend talks to the engine, so it needs Maarten's agreement first:

- Today `src/api` sends every call to the open library (`setOpenLibrary(root, server)`). All photos keeps
  a list of open sources instead. Every photo carries the source of each copy and its home, and calls
  about photos are split per home (`callFor(sources, command, args)`), so each engine gets its own part.
- `useFolder` loads every source (`scan_folder` per local folder and per server library, as now) and
  merges the lists by hash. Events come per source already (local engine; `remote-event` per server).
- The local engine keeps one database per device as now; `client.db` gets `album_follows` and the
  device's basket. The server gets `person_names` (a user's own names for people they can't edit), and
  the basket leaves the server's photos table (today one basket is shared by every editor).
- Uploads carry a small JSON of metadata (rating, flag, label, tags, caption, albums, named face boxes);
  the server stores it with the upload and applies it once the photo is scanned.

## Milestones

1. **All photos, looking and the simple edits:**
   - the sources list in Settings, and the merged grid with the three marks and the Where filter;
   - the folder tree per source;
   - search, map, timeline and smart search across sources;
   - rating, flag, label and tags sent to each home, and the server → local copy of those values;
   - the basket per device;
   - read-only shared photos for guests, with their people and tags.
2. **Backup:** Back up now, with the metadata, album mapping and face names; the backup report.
3. **Collections and People across sources:** albums per source, adding to albums per home, people with
   the same name shown as one, a name of your own for someone else's person, naming faces per home.
4. **Following shared albums,** into a local folder or a server library, with people and tags; what
   happens when sharing stops.
5. **Suggested names** by face likeness; the rest of the per-home editing (captions, face boxes,
   duplicates across sources).

The phone app (phase 5) then adds the camera roll as a local source, with this same view.

## What was built

### Milestone 1 (2026-11-04, checked on Windows against cachy)

- `src/api/allPhotos.ts` (pure: merge, split per home, copying values back, marks; `tests/allPhotos.test.ts`)
  and the routing in `src/api/index.ts`: the open library `ALL_PHOTOS` sends a photo edit (`hashes`) to the
  engine of each photo's home, a copy on this PC follows edits of a server home, and photos without a home
  are left alone with a note (`READ_ONLY_EVENT`) and fetched again. `get_people`, `semantic_status` and
  `semantic_search` ask every source and merge; a command about one folder (`rootFolder`, moves) says to open
  the library on its own. Media come from the engine of the copy the window shows.
- This PC's folders are checked on disk when All photos opens, one after another, as a single folder is.
  Scans now take turns per library (`scan::ScanTurn`): a scan with `keepOthers` stops only an earlier scan of
  the same library, so the folders' thumbnail passes run side by side; opening one folder still stops them
  all. The watcher follows every folder on this PC in the view (`watch_libraries`); a change checks only that
  folder on disk and lists the others from the database (`list_local_library`).
- The Where filter sits in the toolbar next to the media filter (Everywhere · Not backed up · On this PC ·
  Only on the server), as the "On this PC" filter of a server library does.
- People of several sources with the same name show as one already (milestone 3 adds names of your own and
  naming per home). Collections shows a note instead of albums until milestone 3.
- The basket is the device's for every library (`client.db`; the browser's local storage in the web
  client); the first start moves the local libraries' basket in. The server no longer has
  `set_photo_basket`; its `in_basket` column is left as it is, unused.
- Settings → All photos lists the sources with a switch each. The Library menu opens All photos (desktop
  app; the web client's entry comes with milestone 3).
- Checked: 94 photos here and 96 on cachy give 99 (91 in both); the Where counts add up; a rating given in
  All photos lands on cachy and in `C:\LuminaTest\Library`; a rating set on cachy reaches the copy here
  within seconds; the basket stays on this PC; smart search "rocket launch" finds the same 12 photos;
  People shows cachy's people with their faces; the local library opened alone is as before.

### Milestone 2 (2026-11-04, checked on Windows against a lumina-server on 127.0.0.1)

- **Back up now** sits next to the Where filter in All photos when a server this account may upload to is in
  the view. It backs up every photo that isn't backed up, or, with more than one photo selected, those of the
  selection (a Live Photo's clip goes with its photo). With several such servers a list picks the server.
- The desktop's upload queue (`transfers.rs`, `back_up`) takes the photos by id and uploads their originals
  (a RAW's own file, not its preview). Each file carries its values on this PC (`photo_meta::collect`: rating,
  flag, label, caption, tags, album names, named faces with box and video frame, people without a face). Once
  the file is on the server, or was there already, the queue sends the values (`apply_backup_values`), also
  after a restart or a lost connection.
- The server (`photo_meta::apply`) sets the rating, flag, label and caption only where its copy has none, adds
  tags (none are taken away), puts the photo in the album of the same name (made if missing, names compared
  without case), and uses its own spelling of a person's name. A name goes to the unnamed face found at the
  same place (box overlap at least 0.3, same frame in a video). Faces not looked for yet: the names wait in
  `backup_faces`, and the server's update puts them on after its face scan (`apply_waiting_faces`), with
  `photos-changed` and `people-changed`.
- Only an editor's values go along (`apply_backup_values` is an editor command); an account that may upload
  but not edit backs up the files, and the button says the values stay on this PC.
- The backup report is the notice when the queue finishes: uploaded, already on the server, failed, and for
  how many photos the values went along, how many names wait for the faces, and photos with a named face
  the server didn't find. All photos then lists its sources again, so the marks change.
- Checked: four photos of the test library (two JPEGs and a NEF with a named face each, a video with a named
  face in frame 0, one photo rated 4 with a tag and in an album, one flagged) backed up to a new server: the
  values and the album landed, the server's AI tags stayed with the ones from this PC, the NEF arrived as
  itself, the four names went on after the server's face scan (the video's on frame 0 only), and "Not backed
  up" dropped from 94 to 90.

## Done when

- On Maarten's desktop, All photos counts 61,500 photos for the example above. The Where filter's counts
  add up, and Back up now leaves "Not backed up" empty.
- A rating given in All photos on a photo in both places shows on the laptop within seconds, and in
  `D:\Photos` opened on its own.
- On Dad's desktop the shared photos show maarten's people and tags and can't be changed. Calling "Me"
  "Maarten" makes `person:Maarten` find both, on Dad's desktop and in the web client, and changes
  nothing for anyone else.
- Following "Kids 2026" downloads its 120 photos once, with their people and tags. A photo added to the
  album arrives on its own; one taken out stays; when sharing stops, the album goes and the photos stay.
- The basket on the laptop is empty on the desktop.
