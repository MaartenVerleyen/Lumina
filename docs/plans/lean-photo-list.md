# A lean photo list for the phone

Opening a server library sends its whole photo list (`scan_folder`). For the large library on cachy (89,156 photos)
that list is 111 MB of JSON, 19 MB as sent (gzip). On a phone that hurts twice:

- **The download.** 19 MB over Tailscale on mobile data is tens of seconds (Amelie's 13r on 18 November: 26 s
  between the list's answer and the next request). It happens on every new device, after every server upgrade
  (the server forgets which list a device has when it restarts), and in a phone's browser on every open.
- **Memory.** A browser holds the text at two bytes a character (about 240 MB) and the photos made from it (about
  140 MB) at once: a peak of about 380 MB. With the copy 6.3.1 wrote to the browser's storage it was more than
  iOS lets a page have, and the iPhone's web app was closed while it loaded (6.3.6 keeps no copy of large lists
  on phones).

Most of the list is detail the phone shows for one opened photo, or not at all: face boxes and their scores (32 MB,
a quarter of the list), camera settings, the near-duplicate fingerprint.

## Who gets it

The **phone layout**: the Android app, and the web client in a phone's browser (`main.tsx` picks `PhoneApp` for
both). The desktop app and the web client on a computer keep the full list: the desktop's culling, duplicates,
trips and inspector read every field.

## What the phone does (agreed with Maarten, 18 November)

Looking at photos and videos, searching them, naming people, uploading and downloading:

- **Timeline:** thumbnails per day or month, pinch, fast scroller; All / Photos / Videos; where a photo is (this
  phone, a server); select, share, download, back up, remove from the phone.
- **Viewer:** photos and videos, zoom, Live Photos; details: date, place, caption, tags, people, size; face boxes
  to name, rename or take off; share, download, back up, open with, show in its folder.
- **Search:** captions, text in photos (OCR), tags, people, places, file names; smart search (the server);
  Recent, People, Places, Things, Map; search words for rating, flag, colour label, photo or video.
- **People:** faces to check, groups without a name, one by one, ignored faces (all from the server).
- **Albums:** the server's albums, followed albums, the phone's own folders.
- **RAW + JPG shown as one** (stays).
- **Backup and settings.**

What goes from the phone: **trips and events** (Albums), **camera details** in the viewer, near-duplicates grouped
across libraries (the phone never showed them, but All photos worked them out: about 0.25 s per load), search words
for camera, lens, RAW, damaged and sharpness.

## The lean list

**Kept, for every photo, empty or not** (`lean.rs` `KEPT`): `hash`, `name`, `path`, `thumb_path`, `size_kb`,
`width`, `height`, `thumb_ready`, `rating`, `flag`, `color_label`, `rotation`, `tags`, `people`, `ai_caption`,
`ocr_text`, `captured_at`, `location`, `latitude`, `longitude`, `pair_raw_path`, `media_type`, `duration_ms`,
`video_codec` (whether a video plays as it is or needs the server's converted copy), `live_video_hash`,
`live_photo_hash`.

**Left out** (`DETAILS`): `faces`, `camera_model`, `lens_model`, `focal_length`, `aperture`, `shutter_speed`, `iso`,
`sharpness`, `dhash`, `duplicate_group`, `damaged`, `in_basket`, `staged_target`, `subfolder`, `live_video_path`.

Empty values are sent, not left out (agreed 18 November): a browser keeps photos that all have the same fields far
more compactly than photos it has to add fields to, and the phone's code reads them as it always has. A photo of
the lean list simply has no details until they are fetched.

Measured on cachy's large library (a copy of the list, 18 November):

| | Text | Sent (gzip) | Sent (brotli) | Photos in memory | Peak while loading |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Today's full list | 111 MB | 18.9 MB | 13.4 MB | 140 MB | ~380 MB |
| Lean list | 57 MB | 7.1 MB | 5.0 MB | 73 MB | ~190 MB |
| (Lean without empty values, not chosen) | 30 MB | 6.1 MB | 4.5 MB | 53 MB, or 134 MB with them put back | |

Captions are on 52,000 of the 89,000 photos so far; the rest add about 3 MB of text, 0.3 MB sent.

## What comes per photo

`get_photo_details(hashes)` answers the left-out fields per photo (`{hash: {faces: [...], subfolder: ..., ...}}`),
for the photos the account may see. The phone asks for them:

- when the viewer shows a photo (its faces, for the boxes and naming a face; a Live Photo's clip file), for that
  photo and the ones on either side;
- for "Show in its folder" (`subfolder`).

Face review and the People tab already take their faces from the server (`find_similar_faces`,
`get_unknown_face_clusters`, ...). After naming a face the phone keeps the faces the command answered
(`withFaces`), as now.

## Download: as little as possible

1. **The lean list:** 19 MB → 7 MB.
2. **Brotli** (quality 5, about 0.4 s for the lean list) for clients that take it (browsers over HTTPS, the apps'
   reqwest with its `brotli` feature), made once per state of the list, only when someone asks for the whole list:
   7 MB → 5 MB. Differences stay gzip: they are small.
3. **Most opens download nothing.** The phone app keeps its list and is sent only what changed (a few KB after a
   caption or a name) or "still the same". A phone's browser keeps the lean list too (the 6.3.6 limit is raised
   for it).
4. **Upgrades don't force a full download.** The server keeps which list states it handed out in its data folder,
   so after a restart it can still send a device only what differs.

## Milestones

1. **Server (done, 18 November):** the lean list next to the full one (`listing.rs`: one more JSON per photo, its
   own tags ending in `l`, the same differences), asked for with `lean: true` in `scan_folder`'s arguments, also
   for guests' lists; `get_photo_details(hashes)`; brotli for whole lists. Tests:
   `the_lean_list_leaves_details_out_and_has_tags_of_its_own`, `whole_lists_are_sent_in_brotli_when_the_client_takes_it`,
   `lean_photos_match_the_shared_cases`, `every_field_of_a_photo_is_known`.
2. **The phone layout asks for the lean list** (the phone app and the web client on a phone): the viewer and "Show
   in its folder" fetch details; trips, camera details, the phone's near-duplicate grouping and the dropped search
   words go; the places in shared code the phone runs that read a left-out field are checked one by one. The
   phone's kept lists (`offline.rs`, IndexedDB) keep the lean form. Checked against the test library, then on the
   8T, the 13r and the iPhone.
3. **The server keeps its list states across restarts (done, 18 November):** per library, `listing-state/<mark>.json`
   in the data folder holds each form's photos in order with a fingerprint of their JSON and the state they last
   changed in (not the JSON: about 4 MB for 110,000 photos), written when a list is first made and then at most
   once a minute; `listing-state/run` keeps the tags' run. After a restart the first list made marks only the
   photos whose fingerprint differs as changed, and keeps the old tag when none does; states go on a million
   above the last one written, so a tag handed out after that write is never given to another state. Test:
   `a_restart_keeps_what_clients_have`.
