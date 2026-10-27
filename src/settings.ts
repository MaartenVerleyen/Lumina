import { useSyncExternalStore } from "react";
import type { ImportPattern } from "./types/lumina";
import type { CheckLevel, CullingSettings } from "./utils/culling";

// Lumina's settings in one place: typed, validated, saved as one localStorage entry and readable from any
// component with useSettings(). Window layout (pane sizes, open tab) is remembered separately (app/layout.ts).

export type GridStyle = "justified" | "square";
export type CardDetails = "hover" | "always";

export interface Settings {
  simpleMode: boolean;
  gridStyle: GridStyle;
  cardDetails: CardDetails;
  autoAdvance: boolean;
  checkForUpdates: boolean;
  // Import: folder layout, offer to import when a camera card is connected, skip photos already in the library
  importPattern: ImportPattern;
  offerImportOnCard: boolean;
  importSkipDuplicates: boolean;
  // Rescan quietly when photos in the open library change outside Lumina
  watchLibrary: boolean;
  // Culling warnings: closed eyes and a soft main face
  eyesCheck: CheckLevel;
  focusCheck: CheckLevel;
}

export const DEFAULT_SETTINGS: Settings = {
  simpleMode: false,
  gridStyle: "justified",
  cardDetails: "hover",
  autoAdvance: true,
  checkForUpdates: true,
  importPattern: "year-month",
  offerImportOnCard: true,
  importSkipDuplicates: true,
  watchLibrary: true,
  eyesCheck: "normal",
  focusCheck: "normal",
};

const SETTINGS_KEY = "lumina_settings";
// Before Lumina 3.7 a few settings had their own keys; they are read once and then folded into SETTINGS_KEY
const LEGACY_KEYS = ["lumina_simple_mode", "lumina_grid_style", "lumina_card_details"];

const oneOf =
  <T extends string>(...allowed: T[]) =>
  (v: unknown): v is T =>
    typeof v === "string" && (allowed as string[]).includes(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

const VALIDATORS: { [K in keyof Settings]: (v: unknown) => v is Settings[K] } = {
  simpleMode: isBool,
  gridStyle: oneOf("justified", "square"),
  cardDetails: oneOf("hover", "always"),
  autoAdvance: isBool,
  checkForUpdates: isBool,
  importPattern: oneOf("year-month", "year-month-day", "flat"),
  offerImportOnCard: isBool,
  importSkipDuplicates: isBool,
  watchLibrary: isBool,
  eyesCheck: oneOf("off", "normal", "high"),
  focusCheck: oneOf("off", "normal", "high"),
};

// Saved settings over the defaults, field by field: an unknown or invalid value falls back to its default.
// `legacy` reads the old per-setting keys, used only when nothing has been saved yet.
export function parseSettings(raw: unknown, legacy: (key: string) => string | null = () => null): Settings {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (raw == null) {
    const simple = legacy("lumina_simple_mode");
    if (simple !== null) saved.simpleMode = simple === "true";
    const grid = legacy("lumina_grid_style");
    if (grid !== null) saved.gridStyle = grid;
    const details = legacy("lumina_card_details");
    if (details !== null) saved.cardDetails = details;
  }
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(VALIDATORS) as (keyof Settings)[]) {
    const value = saved[key];
    if (VALIDATORS[key](value)) (out as Record<keyof Settings, unknown>)[key] = value;
  }
  return out;
}

// localStorage can throw (private mode, blocked storage): settings then last until Lumina closes
function load(): Settings {
  try {
    const text = localStorage.getItem(SETTINGS_KEY);
    return parseSettings(text ? JSON.parse(text) : null, (k) => localStorage.getItem(k));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let current: Settings | null = null;
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  if (!current) current = load();
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  } catch {}
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings);
}

export function cullingOf(s: Settings): CullingSettings {
  return { eyes: s.eyesCheck, focus: s.focusCheck };
}
