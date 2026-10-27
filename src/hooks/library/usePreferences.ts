import { useState } from "react";
import type { GridStyle, CardDetails } from "../../components/views/VirtualPhotoGrid";
import { readSetting, writeSetting } from "./shared";
import type { LibraryCore } from "./core";

// Appearance and behaviour preferences (Simple/Pro mode, grid look, auto-advance, zoom)
export function usePreferences(core: LibraryCore) {
  const { addLog } = core;
  const [simpleMode, setSimpleMode] = useState<boolean>(() => {
    return localStorage.getItem("lumina_simple_mode") === "true";
  });
  // Grid appearance (Tools menu), remembered between sessions
  const [gridStyle, setGridStyleState] = useState<GridStyle>(() =>
    readSetting("lumina_grid_style", "justified", ["justified", "square"])
  );
  const [cardDetails, setCardDetailsState] = useState<CardDetails>(() =>
    readSetting("lumina_card_details", "hover", ["hover", "always"])
  );
  const setGridStyle = (value: GridStyle) => {
    setGridStyleState(value);
    writeSetting("lumina_grid_style", value);
  };
  const setCardDetails = (value: CardDetails) => {
    setCardDetailsState(value);
    writeSetting("lumina_card_details", value);
  };
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState<boolean>(false);
  // Auto-Advance Mode Toggle
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true);
  // Zoom & View State
  const [zoomLevel, setZoomLevel] = useState<number>(0.45);

  function toggleSimpleMode() {
    const next = !simpleMode;
    setSimpleMode(next);
    try {
      localStorage.setItem("lumina_simple_mode", String(next));
    } catch {}
    addLog("LIBRARY", `Switched UI to ${next ? "Simple Mode" : "Pro Studio Mode"}`);
  }

  return {
    simpleMode,
    toggleSimpleMode,
    gridStyle,
    setGridStyle,
    cardDetails,
    setCardDetails,
    isShortcutsModalOpen,
    setIsShortcutsModalOpen,
    autoAdvance,
    setAutoAdvance,
    zoomLevel,
    setZoomLevel,
  };
}
