import { createContext, useContext, useEffect, useState } from "react";
import { inDesktopApp, onAndroid } from "../api";

// The web client on a phone gets its own simple layout (src/components/phone); the full layout needs a
// big screen and a mouse. A phone held sideways is wide but short, so that counts as a phone too. Someone
// who wants the full layout anyway can switch, and the choice is remembered in this browser.
const PHONE_SCREEN = "(max-width: 767px), (pointer: coarse) and (max-height: 500px)";
const FULL_LAYOUT_KEY = "lumina-full-layout";

export interface PhoneLayout {
  // The screen is phone-sized (never in the desktop app)
  phoneScreen: boolean;
  // The phone layout is showing
  phone: boolean;
  setPreferFull: (full: boolean) => void;
}

function storedPreferFull(): boolean {
  try {
    return localStorage.getItem(FULL_LAYOUT_KEY) === "1";
  } catch {
    return false;
  }
}

export function usePhoneLayoutState(): PhoneLayout {
  // The Android app is always on a phone
  const query = (inDesktopApp && !onAndroid) || typeof window === "undefined" ? null : window.matchMedia(PHONE_SCREEN);
  const [phoneScreen, setPhoneScreen] = useState(() => onAndroid || (query?.matches ?? false));
  const [preferFull, setPreferFullState] = useState(storedPreferFull);
  useEffect(() => {
    if (!query) return;
    const update = () => setPhoneScreen(onAndroid || query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setPreferFull = (full: boolean) => {
    try {
      if (full) localStorage.setItem(FULL_LAYOUT_KEY, "1");
      else localStorage.removeItem(FULL_LAYOUT_KEY);
    } catch {}
    setPreferFullState(full);
  };
  return { phoneScreen, phone: phoneScreen && !preferFull, setPreferFull };
}

export const PhoneLayoutContext = createContext<PhoneLayout>({ phoneScreen: false, phone: false, setPreferFull: () => {} });

export function usePhoneLayout(): PhoneLayout {
  return useContext(PhoneLayoutContext);
}
