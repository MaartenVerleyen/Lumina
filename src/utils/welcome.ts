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
