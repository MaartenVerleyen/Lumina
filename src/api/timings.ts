// How long the app's own steps take, where they can be read: on the phone in Android's log (adb logcat -s Lumina,
// through phone_log), so a slow screen on a real phone can be measured without a debugger. Elsewhere nothing is
// sent unless localStorage "lumina_timings" is "1" (then the console). Only steps that took a while are noted.

let sink: ((line: string) => void) | null = null;
// The step that ran last, named with a freeze the browser reports (it can't say what froze it)
let lastStep = "";

const NOTE_FROM_MS = 20;

export function setTimingSink(send: (line: string) => void) {
  sink = send;
}

function consoleWanted(): boolean {
  try {
    return localStorage.getItem("lumina_timings") === "1";
  } catch {
    return false;
  }
}

export function note(label: string, ms: number, always = false) {
  lastStep = label;
  if (!always && ms < NOTE_FROM_MS) return;
  const line = `${label}: ${Math.round(ms)} ms`;
  if (sink) sink(line);
  else if (consoleWanted()) console.info(`[timing] ${line}`);
}

export function timed<T>(label: string, run: () => T): T {
  const started = performance.now();
  try {
    return run();
  } finally {
    note(label, performance.now() - started);
  }
}

export async function timedAsync<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    note(label, performance.now() - started);
  }
}

// From now until the screen has drawn the change (two frames later): what a tap feels like
export function untilDrawn(label: string) {
  const started = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => note(label, performance.now() - started, true)));
}

// Freezes of the window (the browser's long tasks, 50 ms or more), with the step that ran last
let watching = false;
export function watchFreezes() {
  if (watching || typeof PerformanceObserver === "undefined") return;
  watching = true;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 100) note(`freeze (after ${lastStep || "start"})`, entry.duration, true);
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // no long-task reports in this browser
  }
}
