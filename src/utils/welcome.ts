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
