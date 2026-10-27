import { useCallback, useEffect, useRef, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";

// Updates come from the latest GitHub release (latest.json, signed with Lumina's update key). Lumina checks
// by itself a little after starting, at most about once a day, unless that is switched off in Settings.

const LAST_CHECK_KEY = "lumina_last_update_check";
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; downloaded: number; total: number }
  | { kind: "installing"; update: Update }
  | { kind: "error"; message: string };

function lastCheck(): number {
  try {
    return Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
  } catch {
    return 0;
  }
}

function rememberCheck() {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {}
}

export function useUpdater(autoCheck: boolean) {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  // "Later" hides the banner for this session; Settings still shows the update
  const [dismissed, setDismissed] = useState(false);
  const busyRef = useRef(false);

  const checkNow = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState({ kind: "checking" });
    try {
      const update = await check();
      rememberCheck();
      setState(update ? { kind: "available", update } : { kind: "latest" });
      if (update) setDismissed(false);
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    const wait = Math.max(FIRST_CHECK_DELAY_MS, lastCheck() + CHECK_INTERVAL_MS - Date.now());
    // A failed automatic check stays quiet (offline, GitHub unreachable): the next start tries again
    const timer = window.setTimeout(() => {
      checkNow().then(() => setState((s) => (s.kind === "error" ? { kind: "idle" } : s)));
    }, wait);
    return () => window.clearTimeout(timer);
  }, [autoCheck, checkNow]);

  // Downloads the new installer, then runs it: Lumina closes, updates and starts again by itself
  const install = useCallback(async () => {
    if (state.kind !== "available") return;
    const update = state.update;
    let downloaded = 0;
    let total = 0;
    setState({ kind: "downloading", update, downloaded, total });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        else if (event.event === "Progress") downloaded += event.data.chunkLength;
        if (event.event === "Finished") setState({ kind: "installing", update });
        else setState({ kind: "downloading", update, downloaded, total });
      });
    } catch (err) {
      setState({ kind: "error", message: `The update could not be installed: ${String(err)}` });
    }
  }, [state]);

  return { state, checkNow, install, dismissed, dismiss: () => setDismissed(true) };
}

export type Updater = ReturnType<typeof useUpdater>;
