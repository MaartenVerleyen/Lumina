# Lumina on Android

Status: proposal for Maarten to read and agree to before work starts (2026-11-05). Phase 5 of Lumina 5.

## Why

The household's phones take most of the photos. Today they reach Lumina only through the web client, and
nothing backs them up. The Android app puts the phone's camera roll next to the server's library, backs it
up by itself, and frees up space once the server has the photos.

## Decisions (Maarten, 2026-11-05)

1. **Android only.** Both household phones are Android; no iPhone app.
2. **Tested on a real phone** plugged in by USB (USB debugging on), not an emulator.
3. **Installed as an APK** from the GitHub release, by hand the first time; the app checks GitHub for a newer
   APK itself. No Google Play.
4. **What the app does:** browse and search the server's library (tags, smart search, people, places, dates);
   show the phone's own photos with it in All photos; back the phone up by itself; free up space; follow albums
   shared with you; keep thumbnails for when there is no connection. **Not in this round:** rating, tagging and
   naming from the phone (the app shows them; the desktop and the web client change them).

## The words used below

- **The phone's photos**: everything Android's media store lists from the camera and other apps (camera roll,
  screenshots, WhatsApp, downloads), photos and videos.
- **Backed up**: the server has the photo (matched by Lumina's content id, as on the desktop).

## What Maarten's phone shows

The app opens on **All photos**: the phone's 4,000 photos and cachy's 60,000 in one grid, each photo once.
The marks are the desktop's: amber for "only on this phone", a cloud for "only on the server", no mark for
both. The phone's photos are listed straight from Android's media store, so a photo taken a minute ago is
there at once (with an amber mark until it is backed up).

Four tabs at the bottom, as in the web client's phone layout today: **Photos**, **People**, **Albums**, **Map**,
and a search field above the grid.

- **Search** runs on the server for the server's photos: `beach`, `person:emma`, `rating:>=4`, "dog in the
  snow" (smart search), places and dates. The phone's own photos that aren't backed up yet are found by date
  and place only (the phone runs no face or smart-search models); once backed up, the server knows them too.
  A smart search says so when it matters, under the results: "120 photos only on this phone aren't searched by
  what's in them until they're backed up."
- **People** and **Albums** are the server's (with names of your own, as on the desktop).
- **Opening a photo** shows it full screen; swipe for the next, pinch to zoom, play a video. **Share** sends it
  to another app (the original, downloaded first when it is only on the server).
- **Settings → Servers** signs in, as on the desktop.

## Backing up

**Settings → Backup** on the phone:

```
Back up this phone to   cachy                     [ on ]
  Only on Wi-Fi                                    [ on ]
  Only while charging                              [ off ]
  Videos too                                       [ on ]
Last backup: today 14:02 · 4,000 of 4,000 backed up
                                         [ Back up now ]
```

- With backup on, Android runs Lumina's backup in the background (WorkManager) whenever its conditions hold,
  also when the app is closed and after a restart. It looks at what is new since the last time, asks the server
  which photos it lacks, and uploads those, resumable, two at a time, with the same protocol as the desktop
  (BLAKE3-checked). A notification shows the progress and can stop it.
- Photos land on the server in `uploads/<your name>/`, as uploads from the desktop do. The server makes
  thumbnails, finds faces and captions them by itself.
- The first backup of 4,000 photos takes a while; it carries on over several nights and charges if it must.
- **Back up now** runs it at once (still only on Wi-Fi when that is on, unless you say "use mobile data").

## Free up space

**Settings → Free up space** (or the selection's menu):

```
1,850 photos on this phone are backed up on cachy (14.2 GB).
Remove them from this phone? They stay on cachy, and in Lumina.
                                          [ Remove from phone ]
```

- Only photos the server has, checked with the server just before (its content id and file size), are offered.
- Android asks you to confirm the deletion itself (one system dialog for the whole batch). The photos go to the
  phone's own trash where Android has one (30 days), else they are deleted.
- In All photos they keep showing, as cachy's photos (a cloud mark), and open from the server.

## Following a shared album

As on the desktop: an album shared with you has **Follow…**, and its photos are downloaded into a folder on the
phone (`Pictures/Lumina/<album>`), where the gallery app shows them too; new photos follow by themselves (in
the background, with the backup's conditions). A photo taken out of the album stays; when sharing stops the
follow ends and the photos stay.

The phone has no Lumina library of its own, so a followed photo's people and tags stay on the server's copy:
the app shows them while the album is shared with you. To keep them after that, follow the album into a server
library of yours from the desktop instead.

## Without a connection

- The app keeps the last list of the server's library and the thumbnails it showed (a size you choose in
  Settings, 1 GB by default, oldest first out). Without a connection All photos opens from those, with a note;
  photos not in the cache show a placeholder.
- **Keep all thumbnails** fills the cache with every thumbnail of the library (about 30 KB each: 60,000 photos
  is about 1.8 GB) while on Wi-Fi.
- Search works on what the list holds (tags, people, dates, places). Smart search needs the server: without a
  connection it says "Smart search needs a connection to cachy" instead of showing no results.

## How it is built (for review)

- **The same app, built for Android.** Tauri 2 builds Lumina for Android from this repository
  (`src-tauri/gen/android`, made by `tauri android init`). The window is the web client's phone layout
  (`src/components/mobile/`) grown into the app's: All photos, Backup and Settings screens.
- **A client only.** The phone runs no Lumina engine (no faces, smart search or captions of its own; that is
  the server's work, and Phase 4 is for later). The Rust side on Android keeps what a client needs: the server
  connection (`remote.rs`), uploads and downloads (`transfer.rs`, `transfers.rs`), `client.db` and follows. A
  Cargo feature leaves out the engine on Android (ONNX Runtime, ffmpeg, the folder watcher), as the Mac app is
  client-only today (`platform.fullApp`).
- **The phone's photos** come from a small Kotlin plugin over Android's MediaStore: the list (id, name, size,
  date, place, kind), thumbnails (`loadThumbnail`, cached in the app's folder) and a file handle to read a
  photo. Lumina's content id (BLAKE3 of the size and the first and last 64 KB) is worked out in Rust from that
  handle, so it is exactly the desktop's and the server's; ids are kept in `client.db` by MediaStore id and
  date, so each photo is read once.
- **Background backup** is a Kotlin WorkManager worker with the conditions above. It calls the same Rust upload
  code through one JNI function (`backup_pass`), so the upload protocol stays one implementation; the worker
  only lists what is new and shows the notification.
- **Sign-in:** the session token is kept encrypted with a key in Android's Keystore (the desktop uses the
  system's credential store, which Android hasn't got).
- **Media from the server** goes through the `lumina-remote` protocol as on the desktop. If Android's WebView
  stalls on videos from it (as WebKitGTK did on Linux), the app serves them from 127.0.0.1 as the Linux app
  does.
- **Free up space** uses Android's own delete request (`MediaStore.createDeleteRequest`), which shows the
  system's confirmation.
- **Updates:** the app looks for a newer release on GitHub once a day and offers to download its APK; Android
  then asks to install it. The APK is signed with an Android key of its own, kept like the update key (never in
  the repository; a GitHub secret for the build).
- **Builds:** the release workflow (`.github/workflows/desktop.yml`) gets an Android job: a signed APK (arm64)
  on every release. On this PC, `npm run tauri android dev` runs the app on the phone over USB; that needs the
  Android SDK, NDK and a JDK here (about 6 GB; Android Studio not needed).
- **Phone and server versions:** the app works with a server of the same major version (5.x).

## Milestones

1. **The app on the phone:** Android build (client only), sign in to cachy, browse and search the server's
   library in the phone layout, open photos and play videos, share a photo to another app. Checked on Maarten's
   phone over USB.
2. **The phone's photos:** the camera roll listed from MediaStore with thumbnails and content ids, All photos
   on the phone with its marks and the Where filter, opening and sharing the phone's own photos.
3. **Backup:** Settings → Backup, Back up now, and the background backup (Wi-Fi, charging, videos), resumable,
   with the notification; marks change as photos reach the server.
4. **Free up space and offline:** removing backed-up photos from the phone; the cached list and thumbnails
   without a connection, Keep all thumbnails.
5. **Following shared albums** onto the phone.
6. **Release:** a signed APK on every release from the workflow, and the update check in the app.

## What needs Maarten

- An Android phone with USB debugging on (Settings → About phone → tap Build number seven times → Developer
  options → USB debugging), plugged into this PC when the app is tried.
- Agreeing to install the Android SDK, NDK and a JDK on this PC (about 6 GB).
- An Android signing key for releases: made once on this PC, backed up like the update key, and added as a
  GitHub secret.

## Done when

- Maarten's phone shows All photos with the phone's photos and cachy's, the marks right, search finding the
  server's photos by tag, person and smart search.
- A photo taken with the phone is on cachy by the next morning without opening the app (Wi-Fi, charging), and
  its mark goes.
- Free up space removes only photos cachy has, after Android's confirmation, and they still open from cachy.
- With flight mode on, the app opens and shows the library from its cache.
- A followed album's new photo arrives on the phone by itself.
- The release has an APK that installs on the phone, and the next release offers itself as an update.

## What was built

### Milestone 1 (2026-11-05, checked on Maarten's OnePlus 8T over USB, against cachy over Tailscale)

- `src-tauri/gen/android` (made by `tauri android init`), built on this PC with a portable JDK 17, the
  Android SDK (platform 36, build tools 36.1) and NDK 29 in `%LOCALAPPDATA%\Android` (`JAVA_HOME`,
  `ANDROID_HOME`, `NDK_HOME` set for the user). Windows needs Developer Mode for the build's symbolic link.
  `npx tauri android build --debug --target aarch64 --apk`, then `adb install -r` the universal APK.
- Android builds use rustls instead of OpenSSL (`reqwest`, `tokio-tungstenite`), and no `keyring`: the session
  token is a file in the app's private folder for now (`remote.rs` token_get/set/delete; Keystore encryption
  comes with the camera-roll plugin). `face_ort` has a CPU entry for Android only so it builds; the phone runs
  no models.
- `tauri.android.conf.json`: one window (the desktop's splash screen is a window of its own), and video from
  127.0.0.1. `onAndroid` (src/api) picks the phone layout, leaves out folders on this device and the desktop
  updater.
- `MainActivity.kt` keeps the web view clear of the status and navigation bars (Android draws edge to edge)
  and gives them Lumina's dark background. Lumina's launcher icon and Android's start screen (themes,
  `values-v31`), and a dark loading screen with the mark in `index.html` until the app has started.
- Server videos go through the app's own video server on 127.0.0.1 (`media_server.rs`, as on Linux), so
  skipping ahead in a long video starts at once; `network_security_config.xml` allows plain HTTP to 127.0.0.1
  only (any address in debug builds, for `tauri android dev`).
- Share: `LuminaPlugin.kt` (Android's share sheet through the FileProvider) and `share_photo`, which downloads
  the original into the app's cache first; a Share button in the phone layout's full-screen view.

### Milestone 2 (2026-11-05, checked on the same phone: 11,379 photos and videos with cachy's 102)

- `LuminaPlugin.kt` lists the media store (photos and videos, asking for access once), makes thumbnails
  (`loadThumbnail`, kept in the app's cache) and opens files for Rust to read. Tauri runs a plugin's commands on
  the UI thread, so the work goes to threads of its own: thumbnails newest first (after a fast scroll the rows
  on screen asked last), files on their own pool so a playing video never waits for thumbnails.
- `phone.rs`: the phone's photos as a source of All photos ("This phone", paths `phone:p:<id>` / `phone:v:<id>`).
  Content ids are read in the background from the file (`imaging::content_hash_of_file`, the desktop's and the
  server's id) and kept in `client.db` (`phone_media`, by media store id, date and size); until then a photo shows
  under a stand-in id. All 11,379 took a few minutes the first time; a start after that lists in about 1.6 s.
- The `lumina-phone` protocol serves thumbnails (from the cache straight away once made) and originals; the
  phone's videos play from the app's video server on 127.0.0.1 (`/phone`), as Android's player doesn't read the
  app's protocols. A phone video plays directly (its codec isn't read; the phone made or received it).
- Share sends a phone photo straight from the media store; the phone layout opens All photos itself and shows
  "Loading the library…" until it has.
- Still to do: the session token's Keystore encryption (with the background backup, milestone 3).
