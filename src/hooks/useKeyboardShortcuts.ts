import { useEffect, useRef, RefObject } from "react";
import { PhotoItem } from "../types/lumina";

interface UseKeyboardShortcutsParams {
  activeHash: string | null;
  activePhoto: PhotoItem | null;
  selectedHashes: Set<string>;
  isLoupeOpen: boolean;
  setIsLoupeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsDrawingFace: React.Dispatch<React.SetStateAction<boolean>>;
  setDrawnBox: React.Dispatch<
    React.SetStateAction<{ x: number; y: number; w: number; h: number } | null>
  >;
  setActiveBulkPopover: React.Dispatch<
    React.SetStateAction<"tag" | "person" | "move" | "location" | "time" | null>
  >;
  // A dialog (commit, health, face review, ...) is open: grid shortcuts must not act on photos behind it
  isBlockingModalOpen: boolean;
  closeBlockingModals: () => void;
  navigateByOffset: (offset: number, extendSelection: boolean) => void;
  // Up/down in the grid: the visually nearest photo in the row above/below
  navigateVertical: (direction: 1 | -1, extendSelection: boolean) => void;
  autoAdvance: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  handleSetFlag: (flag: "pick" | "reject" | null) => Promise<void>;
  handleRejectToTrash: () => Promise<void>;
  handleBatchRate: (rating: number) => Promise<void>;
  handleSetColorLabel: (color: "red" | "yellow" | "green" | "blue" | null) => Promise<void>;
  handleRotateSelection: (deltaDegrees: number) => Promise<void>;
  handleAiAnalyzeSingle: () => Promise<void>;
  setViewMode: React.Dispatch<React.SetStateAction<"grid" | "map" | "compare">>;
  setCompareZoom: React.Dispatch<React.SetStateAction<number>>;
  setComparePan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  handleToggleBasketSelection: () => Promise<void>;
}

// Typing into a field (including contenteditable) must never trigger triage shortcuts
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === "input" || tag === "select" || tag === "textarea" || el.isContentEditable;
}

function isActivatableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === "button" || tag === "a" || el.getAttribute?.("role") === "button";
}

export function useKeyboardShortcuts(params: UseKeyboardShortcutsParams) {
  // The listener is registered once and always reads the latest props, so it never acts on stale
  // state (e.g. an outdated AI model or selection).
  const latest = useRef(params);
  latest.current = params;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const p = latest.current;
      const key = e.key.toLowerCase();

      if (isEditableTarget(e.target)) return;

      if (p.isBlockingModalOpen) {
        if (e.key === "Escape") p.closeBlockingModals();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && key === "k") {
        e.preventDefault();
        p.searchInputRef.current?.focus();
        return;
      }
      // Ctrl/Cmd/Alt combinations belong to the app-level handlers (undo, session log) or the OS
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const hasSelection = p.selectedHashes.size > 0;
      // Holding a key down must not keep flagging/trashing photos as auto-advance moves on
      if (e.repeat && !e.key.startsWith("Arrow")) return;

      if (e.key === "ArrowRight") {
        e.preventDefault();
        p.navigateByOffset(1, e.shiftKey);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        p.navigateByOffset(-1, e.shiftKey);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (p.isLoupeOpen) p.navigateByOffset(1, e.shiftKey);
        else p.navigateVertical(1, e.shiftKey);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (p.isLoupeOpen) p.navigateByOffset(-1, e.shiftKey);
        else p.navigateVertical(-1, e.shiftKey);
      } else if (e.key === " ") {
        // Let Space activate a focused button as usual
        if (isActivatableTarget(e.target)) return;
        e.preventDefault();
        if (p.activeHash) p.setIsLoupeOpen((prev) => !prev);
      } else if (e.key === "Escape") {
        p.setIsLoupeOpen(false);
        p.setIsDrawingFace(false);
        p.setDrawnBox(null);
        p.setActiveBulkPopover(null);
      } else if (key === "p" && hasSelection) {
        e.preventDefault();
        p.handleSetFlag("pick");
        if (p.autoAdvance) p.navigateByOffset(1, false);
      } else if (key === "u" && hasSelection) {
        e.preventDefault();
        p.handleSetFlag(null);
      } else if (key === "x" && hasSelection) {
        e.preventDefault();
        p.handleRejectToTrash();
        if (p.autoAdvance) p.navigateByOffset(1, false);
      } else if (["1", "2", "3", "4", "5", "0"].includes(e.key) && hasSelection) {
        p.handleBatchRate(Number(e.key));
        if (p.autoAdvance && e.key !== "0") p.navigateByOffset(1, false);
      } else if (e.key === "6" && hasSelection) {
        p.handleSetColorLabel("red");
      } else if (e.key === "7" && hasSelection) {
        p.handleSetColorLabel("yellow");
      } else if (e.key === "8" && hasSelection) {
        p.handleSetColorLabel("green");
      } else if (e.key === "9" && hasSelection) {
        p.handleSetColorLabel("blue");
      } else if (e.key === "[" && hasSelection) {
        p.handleRotateSelection(-90);
      } else if (e.key === "]" && hasSelection) {
        p.handleRotateSelection(90);
      } else if (key === "a" && p.activePhoto) {
        p.handleAiAnalyzeSingle();
      } else if (key === "g" && !p.isLoupeOpen) {
        p.setViewMode("grid");
      } else if (key === "m" && !p.isLoupeOpen) {
        p.setViewMode("map");
      } else if (key === "c" && !p.isLoupeOpen) {
        p.setCompareZoom(1);
        p.setComparePan({ x: 0, y: 0 });
        p.setViewMode((prev) => (prev === "compare" ? "grid" : "compare"));
      } else if (key === "b" && hasSelection) {
        e.preventDefault();
        p.handleToggleBasketSelection();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
