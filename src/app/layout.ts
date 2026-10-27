import { SortOption, ViewMode } from "../types/lumina";

// Layout remembered between sessions (one localStorage entry; anything missing or invalid falls back)
export interface SavedLayout {
  tab: ViewMode;
  zoom: number;
  sort: SortOption;
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  collapsedSections: string[];
}

export const LAYOUT_KEY = "lumina_layout";
export const DEFAULT_LAYOUT: SavedLayout = {
  tab: "grid",
  zoom: 0.45,
  sort: "NAME_ASC",
  leftWidth: 250,
  rightWidth: 380,
  leftCollapsed: false,
  rightCollapsed: false,
  collapsedSections: [],
};

export function loadLayout(): SavedLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    const num = (v: unknown, min: number, max: number, fallback: number) =>
      typeof v === "number" && v >= min && v <= max ? v : fallback;
    return {
      tab: ["grid", "map", "people", "collections"].includes(raw.tab) ? raw.tab : DEFAULT_LAYOUT.tab,
      zoom: num(raw.zoom, 0, 1, DEFAULT_LAYOUT.zoom),
      sort: typeof raw.sort === "string" && raw.sort ? raw.sort : DEFAULT_LAYOUT.sort,
      leftWidth: num(raw.leftWidth, 160, 2000, DEFAULT_LAYOUT.leftWidth),
      rightWidth: num(raw.rightWidth, 260, 2000, DEFAULT_LAYOUT.rightWidth),
      leftCollapsed: raw.leftCollapsed === true,
      rightCollapsed: raw.rightCollapsed === true,
      collapsedSections: Array.isArray(raw.collapsedSections)
        ? raw.collapsedSections.filter((x: unknown) => typeof x === "string")
        : [],
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}
