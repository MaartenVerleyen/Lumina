import { useSyncExternalStore } from "react";
import { callLocal, onAndroid } from "../../api";

// The phone app's updates (phone_update.rs): a newer release's APK on GitHub, looked for once a day

export interface Update {
  version: string;
  url: string;
  size: number;
  notes: string;
}

interface State {
  update: Update | null;
  checking: boolean;
  checkedAt: number | null;
  error: string | null;
}

const CHECKED_KEY = "lumina_update_checked";
const DAY_MS = 24 * 60 * 60 * 1000;

let state: State = { update: null, checking: false, checkedAt: null, error: null };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

// `force`: now (Check now); else at most once a day
export async function checkForUpdate(force = false) {
  if (!onAndroid || state.checking) return;
  let last = 0;
  try {
    last = Number(localStorage.getItem(CHECKED_KEY)) || 0;
  } catch {}
  if (!force && Date.now() - last < DAY_MS) return;
  set({ checking: true, error: null });
  try {
    const update = await callLocal<Update | null>("phone_update_check");
    try {
      localStorage.setItem(CHECKED_KEY, String(Date.now()));
    } catch {}
    set({ update, checking: false, checkedAt: Date.now() });
  } catch (e) {
    set({ checking: false, error: String(e) });
  }
}

export function useUpdate(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state
  );
}
