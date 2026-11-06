# Lumina on Android: the app's screens

Status: agreed (2026-11-05); being built in the steps below. Part of phase 5
(`docs/plans/android.md`); it comes before milestone 4 (free up space and offline) there.

## Why

Milestones 1–3 made the phone app work: it signs in, shows the phone's photos with the server's, plays videos,
shares and backs up in the background. But its screens are still the web client's simple phone layout: no marks
for what is backed up, no selection, no settings, nothing of the phone's own folders. On a phone, people compare
it with Google Photos and the phone's own gallery. This brief describes the app as it should look and feel.

## Decisions (Maarten, 2026-11-05)

1. A brief first, then building in steps, each checked on the phone.
2. All four matter: the gallery (like Google Photos), the viewer, search and explore, albums with the phone's
   own folders.
3. Still not in this round (from `android.md`): rating, tagging and naming from the phone.
4. **The screens stay web (React in the app's WebView), with Android's own touches**, not written again
   natively (Kotlin, Jetpack Compose). Web keeps one implementation: the search language, All
   photos, the server connection and the viewer are shared with the desktop and the web client, and the app
   gets Android's look and feel where it shows: Material 3 colours and shapes, haptics, the back gesture, the
   share sheet, system dialogs, notifications. Compose would feel a little more native in scrolling and
   transitions, but means writing and keeping a second app; the grid and viewer would have to be done twice.
5. **The web client on a phone** gets the same screens where it can, minus what only the app can do (the
   phone's photos, backup, haptics). One phone layout to keep, and the web client gets better on phones too.

## The screens

Four tabs at the bottom, as Android apps do: **Photos**, **Search**, **Albums**, **Library**. The app opens
on Photos. Android's back gesture closes what is open (viewer, sheet, selection, search) before leaving the app.

### Photos

```
┌──────────────────────────────────────┐
│ Lumina                    (◔)  [M]   │  (◔) backup ring: progress while backing up,
├──────────────────────────────────────┤      a check when all is backed up,
│ Today                                │      amber dot when some aren't
│ ▢ ▢ ▢ ▢                              │  [M] account: servers, settings
│ ▢ ▢ᐧ                                 │  ᐧ  amber: only on this phone
│ Yesterday                            │  ☁  cloud: only on the server
│ ▢ ▢ ▢ ▢                     ┃ Nov    │  (no mark: on both)
│ ▢☁▢ ▢ ▢                     ┃ 2026   │  ┃  fast scroller: drag to scrub through
│ Sat 1 Nov                   ┃        │     the years, a bubble shows the month
│ ▢ ▢ ▶0:12                   ┃        │
├──────────────────────────────────────┤
│  Photos   Search   Albums   Library  │
└──────────────────────────────────────┘
```

- **One timeline** of everything: the phone's photos and the server's (All photos), newest first, under a
  heading per day (per month when zoomed out). A photo on the phone and on the server shows once.
- **Marks** as on the desktop: amber for "only on this phone", a cloud for "only on the server", nothing for
  both. A photo that is uploading shows a small progress ring until it is on the server.
- **Pinch** to change the grid: 3, 4, 5 columns with day headings, 7 and 9 with month headings (as Google Photos
  does). The size is remembered.
- **Fast scroller** on the right edge while scrolling: drag it to jump through years, with a bubble for the month.
- **Select** by long-press (a short vibration), then drag across photos to select more, tap to add or take off; a
  day's heading selects the whole day. The header turns into the selection bar:
  `✕  12 selected        Share  Back up  ⋮` (⋮: Download to this phone, Remove from this phone in milestone 4).
- **Pull down** to refresh (the phone's list and the server's).
- **The backup ring** in the header opens Backup (below). The app tells you when something needs you: signed out
  of the server, access to the photos taken away, the server full.

### Viewer

```
┌──────────────────────────────────────┐
│ ←                         ↗  ⓘ  ⋮   │   tap: show or hide the bars
│                                      │   swipe left/right: next, previous
│                                      │   swipe down: back to the grid (the photo
│              [ photo ]               │     shrinks into its place)
│                                      │   pinch, double-tap: zoom
│                                      │   swipe up: details
│ ▢▢▢▣▢▢▢▢  filmstrip                  │
└──────────────────────────────────────┘
```

**Details** (swipe up or ⓘ), as a sheet over the photo:

```
Sat 1 Nov 2026, 14:32
On this phone and on cachy            ← where it is (or "Only on this phone · back up now")
📍 Ghent, Belgium        [small map]
📷 OnePlus KB2003 · f/1.8 · 1/120 · ISO 200 · 12 MP · 3.4 MB
👤 Emma  Lucas  (faces, tap: their photos)
🏷 beach, sunset, dog
“A dog running on the beach at sunset”  ← the server's caption
```

- Videos play in the viewer with Android-looking controls; seeking as now (from the phone, or from the server's
  video stream).
- ⋮: Share, Download to this phone (server-only photos), Back up now (phone-only photos), Open with… (another app),
  Show in its album/folder.

### Search

```
┌──────────────────────────────────────┐
│ 🔍 Search your photos                │
├──────────────────────────────────────┤
│ People                         All > │
│ (◉)(◉)(◉)(◉)(◉)                      │  faces, named first
│ Places                         All > │
│ [Ghent] [Paris] [Alps]               │  a photo per place, from the map
│ Things                               │
│ [beach] [dog] [snow] [food]          │  the server's most used tags
│ Recent                               │
│ "dog in the snow"   person:emma      │
└──────────────────────────────────────┘
```

- Typing searches with the search language (as the desktop: `beach`, `person:emma`, `rating:>=4`, dates,
  places); a sentence is a smart search on the server. Suggestions as you type (people, places, tags).
- Under smart-search results: "120 photos only on this phone aren't searched by what's in them until they're
  backed up." Without a connection: "Smart search needs a connection to cachy".
- **Places** opens the map (as the Map tab today), **People** the people grid.

### Albums

```
┌──────────────────────────────────────┐
│ Albums                          +    │
├──────────────────────────────────────┤
│ On cachy                             │
│ [▢ Summer 2026] [▢ Birthdays]        │  server albums and smart albums,
│ [▢ Shared: Grandma's] ...            │  shared ones marked
│ On this phone                        │
│ [▢ Camera    ☁✓] [▢ WhatsApp  ☁✗]    │  the phone's folders, with whether
│ [▢ Screenshots ☁✗] [▢ Download ☁✗]  │  each is backed up
└──────────────────────────────────────┘
```

- **The phone's folders** (Camera, WhatsApp Images, Screenshots, Download, ...) from the media store, each with
  its count and whether it is backed up. Opening one shows its photos with the same grid.
- **Backup per folder:** the camera is backed up by default; other folders are switched on per folder (WhatsApp
  and screenshots are often not wanted on the server). The backup then only takes those folders.
- **Followed albums** (milestone 5) show here with a "following" mark.

### Library

- **Backup** (a page of its own, not a sheet): on/off, server, folders, Wi-Fi only, while charging, videos;
  "10,393 of 11,351 backed up", what is uploading now, the last backup, Back up now; failures with their reason.
- **Free up space** (milestone 4).
- **Servers:** signed in as whom, sign in to another, sign out.
- **On this phone:** thumbnail cache size (and Keep all thumbnails, milestone 4), downloads folder.
- **About:** version, update check (milestone 6).

## How it feels

- **Material 3, dark** (Lumina's colours), Android's fonts and shapes: rounded cards, bottom sheets with a handle,
  ripples on tap.
- **Haptics:** long-press to select, reaching the end of a pinch, a finished backup.
- **Transitions:** a photo opens from its place in the grid and goes back there; sheets slide.
- **Fast:** the grid scrolls at 60 fps through 70,000 photos; the app opens on the last list it had (milestone 4
  keeps it) and updates when the new one is in.

## How it is built (for review)

- New components in `src/components/phone/` replace `src/components/mobile/` (which the web client's phone
  layout uses today; with decision 2 it moves over too). The state stays `useLibraryState` and All photos
  (`src/api/allPhotos.ts`): marks come from where each photo's copies are (`copies`, `also_in`), as on the
  desktop.
- **The phone's folders** are the `folder` the media store gives (already in each phone photo's `subfolder`).
  Backup per folder: the folders are kept with the backup's settings (`Backup.kt`), and `phone_backup.rs` takes
  only those.
- **Haptics and the back gesture:** small plugin commands (`haptic`) and the WebView's history (as the viewer's
  back already works).
- **Pinch and the fast scroller** in the grid (`MobileGrid` grown up), with the virtual list it has.
- **Upload progress per photo:** `phone_backup` progress already names the files in flight; the grid shows a
  ring on those.

## Steps (each checked on Maarten's phone)

1. **Photos:** marks, day and month headings, pinch, fast scroller, selection with Share and Back up, the backup
   ring, pull to refresh.
2. **Viewer:** swipe down to close, details sheet, filmstrip, the ⋮ actions.
3. **Library and Backup page:** servers, backup with per-folder choice, settings moved out of the sheet.
4. **Albums:** server albums and the phone's folders.
5. **Search:** the explore page, suggestions, the smart-search notes.

Then `android.md` milestone 4 (free up space and offline) goes on with these screens.

## Done when

- Maarten's phone shows one timeline with the right marks, and pinching, scrubbing and selecting feel like a
  phone's gallery.
- A photo opens, swipes, zooms, shows its details and closes with a swipe down.
- The phone's folders show with their backup state, and backing up only the camera works.
- Search finds people, places and things from the explore page, and smart search says what it can't search.

## What was built (2026-11-06, all five steps, checked on Maarten's phone over USB; waiting for his review)

- **Photos** (`PhoneGrid.tsx`): headings per day (per month at 7 and 9 columns); marks (amber only on this phone,
  a cloud only on the server, violet shared with you) and a spinner on photos uploading; pinch through 3, 4, 5, 7
  and 9 columns, around the photo under the fingers, remembered; the fast scroller with a month bubble;
  long-press (with a vibration) and drag to select, a day's heading selects the day; pull to refresh. Selection
  bar: Share (several at once), Download to this phone for server-only photos, Back up for phone-only ones; the
  back gesture ends a selection.
- **Viewer** (`PhoneViewer.tsx`): a filmstrip; details with where the photo is (with Back up now or Download),
  file, camera, faces with their names, caption and tags; ⋮: Share, Download to this phone (into
  `Pictures/Lumina` through the media store), Back up now, Open with…, Show in its folder.
- **Backup and Settings** (Maarten's review: one Library tab held too much): the header's backup ring opens the
  Backup page (`BackupScreen.tsx`: progress, Back up now, the conditions, the phone's folders each switched on or
  off, the camera's by default; `phone_media` keeps each photo's folder, the pass and the counts follow the
  choice); the account button (the user's initial) opens Settings (`SettingsScreen.tsx`: servers, the thumbnails
  and server cache kept on the phone, About). Both are pages over the tabs, closed with the back gesture; the
  tabs are Photos, Search and Albums.
- **Albums** (`AlbumsScreen.tsx`): the server's albums as cards with covers, trips and events in a row, the
  phone's folders with their backup state; a folder opens as its own grid.
- **Search** (`SearchScreen.tsx`): the field with smart search, recent searches, People (All opens the grid of
  faces), Places (the map, and cities by count), Things (the most used tags, each with its own cover). Results
  show in Photos; a smart search says how many photos only on this phone it couldn't look into. All photos no
  longer asks the phone's own engine (it has no library, and its smart search waited for models it hasn't got).
- **Back up for a selection** (fixed after Maarten's try): the debug-only test limit no longer cuts a selection
  short; selections add up (a second one while the first runs is kept, `phone-backup-only.json`), and a selection's
  pass never turns into a whole backup. Back up now is expedited (Android starts it at once). A long-press lifted
  without moving no longer takes the photo off again (the click after the touch), and the chips stay while
  selecting so the grid doesn't move under the finger. **Progress:** a card over the bottom of the screen while a
  backup runs ("Backing up · 3 of 12" with a bar), waits (for Wi-Fi, or "Can't reach cachy; trying again") or has
  just ended ("Backed up 12"), opening Backup on a tap; the grid reloads afterwards, so the marks go.
- **Where the phone's photos were taken:** the app asks for Android's media location permission (granted with
  the photos' on Maarten's phone, without a dialog) and reads the originals (`MediaStore.setRequireOriginal`):
  without it Android strips the location, which also changes the bytes, so the content ids and the backed-up
  files were of the stripped copies. Each photo's EXIF (place, camera, lens, exposure) is kept with its content
  id (`phone_media.meta`) and read again once for photos read before. Checked with a geotagged test photo
  ("Gent, BE"); Maarten's own camera photos have no GPS (the camera saves none), so they show no place.
