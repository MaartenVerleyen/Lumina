import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { notesSince, previousVersionOf, shouldShowWelcome, ReleaseNotes } from "../utils/welcome";

const LAST_VERSION_KEY = "lumina_last_version";
const PREVIOUS_VERSION_KEY = "lumina_previous_version";
const HIDDEN_FOR_KEY = "lumina_welcome_hidden_for";
// Settings an earlier Lumina leaves behind: their presence means this is an update, not a fresh install
const EXISTING_USER_KEYS = ["lumina_active_folder", "lumina_recent_folders", "lumina_layout"];

// localStorage can throw (private mode, blocked storage): the tour then simply opens every launch
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

interface WelcomeState {
  isOpen: boolean;
  version: string;
  notes: ReleaseNotes[];
  hidden: boolean;
}

// The welcome tour: opens by itself after a fresh install or an update (with "What's new" for updates),
// until the user ticks "Don't show again" for this version. It can always be reopened from the Help menu.
export function useWelcomeTour() {
  const [state, setState] = useState<WelcomeState>({ isOpen: false, version: "", notes: [], hidden: false });

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .catch(() => "")
      .then((version) => {
        if (cancelled || !version) return;
        // Remember where an update came from until the next version change, so "What's new" survives restarts
        const lastRun = read(LAST_VERSION_KEY);
        if (lastRun !== version) {
          const existingUser = EXISTING_USER_KEYS.some((k) => read(k) !== null);
          write(PREVIOUS_VERSION_KEY, previousVersionOf(lastRun, existingUser));
          write(LAST_VERSION_KEY, version);
        }
        const notes = notesSince(read(PREVIOUS_VERSION_KEY) ?? "", version);
        const hiddenFor = read(HIDDEN_FOR_KEY);
        setState({ isOpen: shouldShowWelcome(version, hiddenFor), version, notes, hidden: hiddenFor === version });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = () => setState((s) => ({ ...s, isOpen: true }));

  const close = (dontShowAgain: boolean) => {
    write(HIDDEN_FOR_KEY, dontShowAgain ? state.version : null);
    setState((s) => ({ ...s, isOpen: false, hidden: dontShowAgain }));
  };

  return { ...state, open, close };
}
