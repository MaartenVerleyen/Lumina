// The recent-folders list (start screen, command palette) kept in step with this PC's libraries: a folder Lumina
// forgot leaves it, and one located at a new place is listed there.

// One spelling per folder: no trailing separator, any case (Windows paths)
const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
export const sameFolder = (a: string, b: string) => norm(a) === norm(b);

// Only the folders that are still libraries (forgotten ones go)
export function keepKnownRecent(recent: string[], roots: string[]): string[] {
  return recent.filter((r) => roots.some((root) => sameFolder(r, root)));
}

// A library moved to `to`: listed there, once, where `from` was
export function renameRecent(recent: string[], from: string, to: string): string[] {
  const out: string[] = [];
  for (const r of recent) {
    const next = sameFolder(r, from) ? to : r;
    if (!out.some((o) => sameFolder(o, next))) out.push(next);
  }
  return out;
}

export function dropRecent(recent: string[], path: string): string[] {
  return recent.filter((r) => !sameFolder(r, path));
}
