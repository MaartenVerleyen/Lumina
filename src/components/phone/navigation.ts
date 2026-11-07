import { useEffect, useRef, useState } from "react";

// The phone app's screens as one stack, kept in step with the web view's history: Android's back button (or
// swipe) goes back through the web view's history, so every screen opened is an entry and back closes the top
// one, like the arrow at the top left. The app closes only from the Photos tab with nothing open over it.

export type Tab = "photos" | "search" | "people" | "albums";

// What a grid of photos is narrowed to
export type Scope =
  | { person: string }
  | { album: number }
  | { event: string }
  | { query: string }
  | { folder: string; hashes: string[] };

export type Screen =
  // Another tab than Photos (always at the bottom of the stack, so back goes to Photos from it)
  | { kind: "tab"; tab: Tab }
  | { kind: "grid"; title: string; scope: Scope }
  | { kind: "viewer"; hash: string }
  // The details of the photo in the viewer under it
  | { kind: "details" }
  | { kind: "map" }
  | { kind: "review"; name: string }
  | { kind: "groups" }
  | { kind: "backup" }
  | { kind: "settings" }
  // Photos selected in the grid under it: back ends the selection
  | { kind: "select" };

export function useScreens() {
  const [stack, setStack] = useState<Screen[]>([]);
  const current = useRef<Screen[]>([]);
  // What to do once a jump back through several screens has arrived
  const then = useRef<(() => void) | null>(null);
  const update = (next: Screen[]) => {
    current.current = next;
    setStack(next);
  };

  useEffect(() => {
    // After a reload the history may still hold screens of the last run: back to this page's own entry
    const depth = history.state?.luminaDepth;
    if (typeof depth === "number" && depth > 0) history.go(-depth);
    else history.replaceState({ luminaDepth: 0 }, "");
    const onPop = (e: PopStateEvent) => {
      // Back onto the entry of a sheet that is no longer open (a person opened from it): one more step back
      if (e.state?.luminaSheet && openSheets === 0) return history.back();
      const at = typeof e.state?.luminaDepth === "number" ? e.state.luminaDepth : 0;
      update(current.current.slice(0, at));
      const next = then.current;
      then.current = null;
      next?.();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const push = (screen: Screen) => {
    const next = [...current.current, screen];
    history.pushState({ luminaDepth: next.length }, "");
    update(next);
  };
  const back = () => {
    if (current.current.length > 0) history.back();
  };
  // Back to the first `depth` screens, then `after`
  const backTo = (depth: number, after?: () => void) => {
    const steps = current.current.length - depth;
    if (steps <= 0) return after?.();
    then.current = after ?? null;
    history.go(-steps);
  };
  // The top screen changes in place (the viewer's photo as you swipe): back still leaves it
  const replaceTop = (screen: Screen) => update([...current.current.slice(0, -1), screen]);

  const tab: Tab = stack[0]?.kind === "tab" ? stack[0].tab : "photos";
  const openTab = (to: Tab) => {
    // The tab already shown: back to its first screen
    if (to === tab) return backTo(tab === "photos" ? 0 : 1);
    backTo(0, () => {
      if (to !== "photos") push({ kind: "tab", tab: to });
    });
  };

  return { stack, top: stack[stack.length - 1] ?? null, tab, push, back, replaceTop, openTab };
}

let openSheets = 0;

// A sheet over a screen (naming a face, the viewer's menu) is closed by back too, before the screen under it.
// For a component shown only while its sheet is open: an entry in the history of its own while mounted.
export function useBackCloses(close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const sheet = useRef({ pushed: false, mounted: false, popped: false });
  useEffect(() => {
    const s = sheet.current;
    s.mounted = true;
    if (!s.pushed) {
      s.pushed = true;
      openSheets++;
      history.pushState({ ...history.state, luminaSheet: true }, "");
    }
    const onPop = () => {
      s.popped = true;
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      s.mounted = false;
      window.removeEventListener("popstate", onPop);
      // Later, as React's development mode unmounts and mounts again at once: closed for real only if not back
      window.setTimeout(() => {
        if (s.mounted) return;
        openSheets--;
        if (!s.popped && history.state?.luminaSheet) history.back();
      }, 0);
    };
  }, []);
}
