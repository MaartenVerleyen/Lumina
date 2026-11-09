// When the welcome tour opens by itself, and which "What's new" notes it shows.
// Pure functions (tested in tests/welcome.test.ts); the storage around them lives in WelcomeTour.tsx.

export interface ReleaseNote {
  title: string;
  text: string;
}

export interface ReleaseNotes {
  version: string;
  items: ReleaseNote[];
}

// Newest first. Add an entry for every release that should greet updating users with "What's new".
export const RELEASE_NOTES: ReleaseNotes[] = [
  {
    version: "5.5.1",
    items: [
      { title: "Who is this? names what you see", text: "Naming a group gives the name to the faces shown; the rest of a big group comes back as faces to check for that person. Larger opens a group with big faces and shows the photo each one is in." },
      { title: "Face review keeps its place", text: "Back from One by one, the grid is where you left it; another person starts at the top." },
      { title: "One by one shows every face", text: "Photos show straight away and sharpen as they load, the next ones load ahead, and a face from a video shows as a large face instead of a broken image." },
    ],
  },
  {
    version: "5.5.0",
    items: [
      { title: "A tidier header", text: "One AI button for finding faces and writing captions (it shows how far a job is), and a gear for Settings, the Simple or Advanced view, shortcuts and the tour. Click the library's name for the Library menu. Layout and photo details are under View." },
      { title: "One name for each thing", text: "Pinned photos (search is:pinned), AI caption for the A key, Library backup for saving ratings and names, and Apply changes for moves and rejected photos. Counts say 1 photo or 3 photos." },
      { title: "Clearer deleting", text: "A rejected photo shows its X and Apply changes in the header. Empty _Trash only counts what is really in the _Trash folder, and nothing is deleted for good until you empty it." },
      { title: "Working on a selection", text: "With several photos selected, the panel on the right says its changes go to all of them. The selection bar fits on one row, with the rest under More, and the right-click menu has stars, labels and rotate." },
      { title: "Faces", text: "In Who is this?, click a face that is someone else to leave it out before you name the group. Face review's close button stays at the top right." },
    ],
  },
  {
    version: "5.4.0",
    items: [
      { title: "A calmer look", text: "One accent colour instead of many, grey icons, labels in plain sentence case instead of capitals, and quieter buttons and badges, so your photos stand out. The phone app gets the same treatment." },
      { title: "Plainer words", text: "Buttons and menus say what they do: Find faces, Find more of Anna, Keep this, trash the rest, Place on the map." },
      { title: "Shutter speeds read normally", text: "Some cameras store 1/60 s in a way Lumina showed as 0.0166666666666666s. It shows as 1/60s again, also for photos already in your library." },
    ],
  },
  {
    version: "5.3.0",
    items: [
      { title: "Back works on the phone", text: "The phone's back button closes what you opened last (a photo's details, the photo, a person, an album) instead of closing the app, just like the arrow at the top left. From another tab it goes back to Photos." },
      { title: "People has its own tab", text: "The phone app's People tab shows the faces to check first, then everyone. A person's photos say when more faces might be them: tap Check to confirm them right there." },
    ],
  },
  {
    version: "5.2.0",
    items: [
      { title: "Check suggested faces on the phone", text: "Search → People shows how many faces Lumina thinks are someone you named (+3 on their photo). Tap it, tick the faces that are them and confirm, or say they aren't, so they aren't suggested again." },
      { title: "Name faces in groups", text: "\"Without a name\" shows faces that look like the same person, grouped. Name a group and every face in it gets the name; tap a face that is someone else to leave it out, or say it's nobody you know." },    ],
  },
  {
    version: "5.1.2",
    items: [
      { title: "Name faces on the phone", text: "In a photo's details on the phone, tap a face to say who it is: type a name or pick someone you named before. Faces without a name say \"Who's this?\". Tap a named face to see all photos of that person, or to take off a wrong name." },
    ],
  },
  {
    version: "5.1.1",
    items: [
      { title: "The phone app opens", text: "The Android app from 5.1.0 closed straight away when you opened it. This one opens. Nothing changes on Windows, Linux and the Mac." },
    ],
  },
  {
    version: "5.1.0",
    items: [
      { title: "Lumina on your phone", text: "Lumina for Android: your phone's photos and your server's library in one timeline, each photo once. An amber mark shows what isn't backed up yet, a cloud what is only on the server. Pinch to change the size, drag the handle on the edge to jump through the years, long-press and drag to select. Install the APK from the release; the app tells you when there is a newer one." },
      { title: "The phone backs itself up", text: "Turn on Backup and the phone sends its new photos and videos to your server by itself, also with the app closed: on Wi-Fi only and while charging if you like, and only the folders you choose (the camera's to start with). Back up now, or back up just a selection. A card shows how far it is." },
      { title: "Free up space", text: "Photos the server has can leave the phone: Lumina asks the server first, then Android asks you. They stay on the server and in Lumina, and in the phone's bin for 30 days." },
      { title: "Search and albums on the phone", text: "Search by people, places, things or what's in a photo (smart search). Albums shows your server's albums and the phone's own folders, each with whether it is backed up. Follow an album shared with you and its photos come into your phone's gallery, new ones by themselves." },
      { title: "Without a connection", text: "The phone keeps the last list of your server's photos and the thumbnails you looked at, so your library opens without a connection too. Keep all thumbnails of a library to look through all of it offline." },
    ],
  },
  {
    version: "5.0.0",
    items: [
      { title: "A home server", text: "Lumina now also runs as a server on a Linux PC at home (in Docker, with the GPU). It keeps your library, finds faces, makes smart search work and writes captions by itself, and everyone in the house reaches it from Lumina on their computer, or from a web browser, over Tailscale. Your photos still never leave your own machines." },
      { title: "Accounts and sharing", text: "Each person signs in with an account of their own: look only, upload, edit, or run the server. Share an album or a smart album with someone, and they see just that, also from the web. Who changed what is kept with each photo." },
      { title: "Your server in the app", text: "Settings → Servers connects Lumina to a server. Open its libraries next to the folders on this PC, upload by dropping files on the window, download originals, and see which photos are on this PC already. Video plays straight from the server." },
      { title: "All photos", text: "One view of every photo you may see: the folders on this PC and the libraries of your servers together, each photo once. A mark shows which photos aren't backed up yet, and which are only on the server or only shared with you. Rate, flag and tag anywhere: the change goes to where the photo lives, and the copy on this PC follows." },
      { title: "Back up now", text: "One click sends the photos that are only on this PC to your server, with their ratings, tags, albums and the names of the people in them. The server finds the faces itself and puts the names on." },
      { title: "Follow a shared album", text: "When someone shares an album with you, follow it: its photos come into a folder of yours with who is in them and their tags, and new photos follow by themselves. They are yours to keep, also when the album stops being shared." },
      { title: "People everywhere", text: "The same person in two libraries shows as one. Give someone from another library a name of your own (their \"Me\" can be your \"Maarten\"), keep two people with the same name apart, and Lumina suggests when two people look like one." },
      { title: "Linux and Mac", text: "Lumina is also built for Linux (AppImage and .deb) and for Apple Silicon Macs. The Mac app works with a Lumina server for now." },
      { title: "Fixes", text: "RAW files from Nikon, Sony, Canon (CR3) and others show their real size. Removing the name from a face keeps the face. Library Health can forget photos whose files are gone, and the Library menu can forget a folder (its files stay)." },
    ],
  },
  {
    version: "4.3.0",
    items: [
      { title: "Getting ready for Lumina 5", text: "Lumina's engine was reorganised so it can also run on a home server, for Lumina 5. Nothing changes in how you use it. On first start Lumina notes which library each photo belongs to, once; your ratings, people, albums and faces stay as they are." },
      { title: "Batch AI in the engine", text: "Batch AI now runs inside Lumina's engine instead of the window, so the window has less to do while captions come in." },
      { title: "Fixes", text: "A folder opened as C:/Photos and as C:\\Photos is one library, no longer indexed twice." },
    ],
  },
  {
    version: "4.2.0",
    items: [
      { title: "Videos", text: "Videos join your library: in the grid with their length, on the map and in trips, played in full screen with Space to pause. Lumina reads when and where they were recorded and which phone or camera made them. Switch between all, photos and videos on the Photos, People and Map tabs." },
      { title: "Every video plays", text: "MTS, AVI and other older formats get a playable copy on request. Lumina downloads ffmpeg for this once and keeps the copies in its cache." },
      { title: "Live Photos", text: "An iPhone Live Photo's short clip hides behind its photo, even when it sits in another folder. Hover LIVE in full screen, or hold L, to play it. Trashing or moving the photo takes the clip along." },
      { title: "Search and faces in videos", text: "Smart search looks at several moments of each video, so \"sheep in a field\" finds the video where they appear halfway. Scan Faces finds the people in videos too, each person once per video. Scan everything, only photos, only videos or only what is shown." },
      { title: "You see it working", text: "Sorting or filtering a large library shows a spinner over the grid, and a new sort order starts at the top." },
      { title: "Fixes", text: "Removed photos no longer turn up in smart search, and a rescan no longer reports an internal error behind the scenes." },
    ],
  },
  {
    version: "4.1.0",
    items: [
      { title: "Duplicates without bursts", text: "Find duplicates no longer lists burst shots or photos taken a moment apart as the same photo. Photos whose names don't show they are one shot must also look the same in detail, so a child who moved or a dog that turned its head keeps both pictures." },
      { title: "iPhone edits paired right", text: "An iPhone edit (IMG_E1234) is matched with its own original, not with the next photo." },
      { title: "Developed photos in the right place", text: "A RAW developed twice or exported under a new name joins the burst frame it was made from, not a neighbouring frame that looks alike." },
    ],
  },
  {
    version: "4.0.3",
    items: [
      { title: "Find duplicates", text: "Organize → Find duplicates lists exact copies spread over your folders, and the same photo saved again as another file. Lumina keeps the largest, oldest copy with the most info, moves your ratings, people and albums onto it, and stages the rest for _Trash." },
      { title: "A safer Empty _Trash", text: "Emptying _Trash never deletes a photo for good behind your back. Lumina checks that the Recycle Bin can hold everything and asks first if it can't. It shows its progress, can be cancelled, and takes .xmp sidecars along." },
      { title: "Google Takeout dates", text: "Photos from a Google Photos export get the date Google recorded for them, even when the export was split into parts. Without one, a year in the folder name beats the day the files were copied. Existing photos are corrected on the next scan." },
      { title: "WhatsApp photos", text: "Photos received through WhatsApp get a whatsapp tag and their own filter in the sidebar." },
      { title: "Fewer false screenshots", text: "Phone photos that happen to have a screen's size are no longer marked as screenshots. Wrong marks are removed once, automatically." },
      { title: "Indexing you can interrupt", text: "A large library is saved as it is indexed, so a cancelled or interrupted first index carries on where it stopped. The progress window shows files per second and the time left." },
      { title: "Faster with large libraries", text: "Collections, switching tabs and resizing the side panes are much quicker with tens of thousands of photos. Collections shows the first 12 trips of each year, with Show all for the rest." },
      { title: "Fixes", text: "The review count no longer runs over a person's name in a narrow People pane, and the splash screen shows the right version." },
    ],
  },
  {
    version: "4.0.1",
    items: [
      { title: "Star your people", text: "Star the people who matter most (People → ⋯ → Star). They come first in the lists, and Best of focuses on photos of them instead of friends' photos or pictures received through WhatsApp." },
      { title: "Jump through time", text: "Sorted by date, move the mouse to the right edge of the grid: the whole timeline slides out. Click a year, or click and drag to go month by month." },
      { title: "Clear filters faster", text: "An × on the date filter clears just the date, and Clear all filters shows all photos again in one click." },
      { title: "Ignore faces", text: "In Who is this?, ignore a whole group or a single face without naming anyone. Undo is one click away." },
      { title: "Better photo dates", text: "Photos without a date inside the file now get the date in their name (IMG_20230615…, WhatsApp) or the date they were last modified, no longer the day they were copied to this PC. Existing photos are corrected on the next scan." },
      { title: "Smarter similar shots", text: "Photos are only grouped as similar when the smart search index agrees, so unrelated photos no longer end up in one stack." },
      { title: "Fixes", text: "Grid months in the right order, Best of covers that match the photos inside, review counts that update at once, week labels on the timeline, and the person menu in Face Review no longer hidden or overlapped." },
    ],
  },
  {
    version: "4.0.0",
    items: [
      { title: "Import photos", text: "From a memory card, USB drive or folder into dated folders, skipping photos you already have. Lumina offers it when a camera card is connected." },
      { title: "Closed eyes and soft focus", text: "Photos where someone blinks or the face is out of focus are marked, with quick filters. Keep best now prefers open eyes and sharp faces." },
      { title: "Highlights", text: "The best 10, 20 or 50 photos of any trip, album or folder, and a Best of for every year in Collections." },
      { title: "On this day", text: "Photos taken on today's date in earlier years, in a strip above the grid." },
      { title: "Search in plain words", text: "Type \"lily and emma in antwerpen\" or \"kerst vorig jaar\": Lumina picks out the people, dates and places." },
      { title: "Share as a web page", text: "Turn a selection, album or trip into a web gallery to open or upload anywhere, without location data." },
      { title: "Backup and restore", text: "Back up your ratings, people, captions and albums, automatically if you like, and restore them on a new PC." },
      { title: "One Settings page", text: "Every option in one place, with Ctrl+, from anywhere." },
      { title: "Automatic updates", text: "Lumina checks for new versions and installs them with one click." },
    ],
  },
  {
    version: "3.6.0",
    items: [
      { title: "Tabs", text: "Photos, Map, People and Collections each have their own tab. Ctrl+1 to 4 switches between them." },
      { title: "People tab", text: "All your people in one pane, with profile pictures. Right-click someone to rename, merge or hide them." },
      { title: "Combine people", text: "Find photos of several people at once: (emma or lucas) and noah, or anna and not bob." },
      { title: "Collections", text: "Albums, smart albums and trips as cards. Add photos to an album from the right-click menu." },
      { title: "Faster captions", text: "One click switches on Ollama's flash attention, about 10 to 15% faster." },
      { title: "A tidier window", text: "A slimmer sidebar, View and Organize menus, and Lumina remembers your layout." },
    ],
  },
];

// Compares dotted version numbers ("3.10.0" > "3.9.2"). Missing parts count as 0, anything after "-" is ignored.
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// The version a user came from: "" for a fresh install, "unknown" for someone who used Lumina before
// it remembered versions, otherwise the last version that ran.
export function previousVersionOf(lastRun: string | null, existingUser: boolean): string {
  if (lastRun) return lastRun;
  return existingUser ? "unknown" : "";
}

// Notes newer than `previous`, up to and including `current`, newest first.
// A user who came from an unknown version only sees the current release's notes.
export function notesSince(previous: string, current: string, notes: ReleaseNotes[] = RELEASE_NOTES): ReleaseNotes[] {
  if (!previous) return [];
  return notes.filter(
    (n) =>
      compareVersions(n.version, current) <= 0 &&
      (previous === "unknown" ? compareVersions(n.version, current) === 0 : compareVersions(n.version, previous) > 0)
  );
}

// The tour opens by itself after an install or update, until the user ticks "Don't show again" (or finishes
// the tour) for this version. The next update brings it back.
export function shouldShowWelcome(current: string, hiddenFor: string | null): boolean {
  return hiddenFor !== current;
}
