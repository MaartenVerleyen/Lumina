import { useState } from "react";
import { useSettings, updateSettings, GridStyle, CardDetails } from "../../settings";
import type { LibraryCore } from "./core";

// Appearance and behaviour preferences (Simple/Pro mode, grid look, auto-advance), kept in the settings
// store so the Settings page and the menus always agree; plus the session's zoom and shortcuts sheet
export function usePreferences(core: LibraryCore) {
  const { addLog } = core;
  const { simpleMode, gridStyle, cardDetails, autoAdvance } = useSettings();
  const setGridStyle = (value: GridStyle) => updateSettings({ gridStyle: value });
  const setCardDetails = (value: CardDetails) => updateSettings({ cardDetails: value });
  const setAutoAdvance = (value: boolean) => updateSettings({ autoAdvance: value });
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState<boolean>(false);
  // Zoom & View State
  const [zoomLevel, setZoomLevel] = useState<number>(0.45);

  function toggleSimpleMode() {
    const next = !simpleMode;
    updateSettings({ simpleMode: next });
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
