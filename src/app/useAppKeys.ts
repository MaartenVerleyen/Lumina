import { useEffect, useRef } from "react";
import { isEditableTarget } from "../hooks/useKeyboardShortcuts";
import type { LibraryState } from "../hooks/useLibraryState";

// App-level keys that work everywhere: Ctrl+P palette, Ctrl+, settings, Ctrl+1…4 tabs, Ctrl+Z / Ctrl+Y, ? and Ctrl+L.
// Registered once; App writes the latest state into the returned ref on every render.
export function useAppKeys(lib: LibraryState) {
  // Global Undo/Redo (`Ctrl+Z` / `Ctrl+Y`), Shortcuts (`?`), and Session Log (`Ctrl+L`) Listener.
  // Registered once; reads the latest handlers through a ref.
  const extraKeysRef = useRef({ lib, isBlockingModalOpen: false, isDialogOpen: false, togglePalette: () => {}, openSettings: () => {} });
  useEffect(() => {
    function handleExtraKeys(e: KeyboardEvent) {
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      // Ctrl+P opens the command palette (and never the WebView's print dialog), even from a text field
      if (mod && key === "p" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        extraKeysRef.current.togglePalette();
        return;
      }
      // Ctrl+, opens Settings (not on top of another dialog)
      if (mod && e.key === "," && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!extraKeysRef.current.isDialogOpen) extraKeysRef.current.openSettings();
        return;
      }
      // Ctrl+1…4: Photos, Map, People, Collections (not while a dialog is open)
      if (mod && !e.shiftKey && !e.altKey && ["1", "2", "3", "4"].includes(e.key)) {
        if (extraKeysRef.current.isDialogOpen) return;
        e.preventDefault();
        const tabs = ["grid", "map", "people", "collections"] as const;
        extraKeysRef.current.lib.setViewMode(tabs[Number(e.key) - 1]);
        return;
      }
      if (isEditableTarget(e.target)) return;
      const { lib: l, isBlockingModalOpen: blocked } = extraKeysRef.current;

      if (mod && key === "z" && !e.shiftKey) {
        // Undo/redo would change photos behind an open dialog (Face Review has its own Ctrl+Z)
        if (blocked) return;
        e.preventDefault();
        l.handleUndo();
      } else if (mod && (key === "y" || (e.shiftKey && key === "z"))) {
        if (blocked) return;
        e.preventDefault();
        l.handleRedo();
      } else if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        l.setIsShortcutsModalOpen((prev) => !prev);
      } else if (key === "l" && mod) {
        e.preventDefault();
        l.setIsSessionLogModalOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleExtraKeys);
    return () => window.removeEventListener("keydown", handleExtraKeys);
  }, []);

  return extraKeysRef;
}
