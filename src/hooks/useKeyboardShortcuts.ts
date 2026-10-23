import { useEffect, RefObject } from "react";
import { PhotoItem } from "../types/lumina";

interface UseKeyboardShortcutsParams {
  activeHash: string | null;
  activePhoto: PhotoItem | null;
  selectedHashes: Set<string>;
  isLoupeOpen: boolean;
  setIsLoupeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCommitModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsDrawingFace: React.Dispatch<React.SetStateAction<boolean>>;
  setDrawnBox: React.Dispatch<
    React.SetStateAction<{ x: number; y: number; w: number; h: number } | null>
  >;
  setActiveBulkPopover: React.Dispatch<
    React.SetStateAction<"tag" | "person" | "move" | "location" | "time" | null>
  >;
  gridColumns: number;
  navigateByOffset: (offset: number, extendSelection: boolean) => void;
  autoAdvance: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  handleSetFlag: (flag: "pick" | "reject" | null) => Promise<void>;
  handleBatchStageMove: (targetSub: string | null) => Promise<void>;
  handleBatchRate: (rating: number) => Promise<void>;
  handleSetColorLabel: (color: "red" | "yellow" | "green" | "blue" | null) => Promise<void>;
  handleRotateSelection: (deltaDegrees: number) => Promise<void>;
  handleAiAnalyzeSingle: () => Promise<void>;
  setViewMode: React.Dispatch<React.SetStateAction<"grid" | "map" | "compare">>;
  setCompareZoom: React.Dispatch<React.SetStateAction<number>>;
  setComparePan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  handleToggleBasketSelection: () => Promise<void>;
}

export function useKeyboardShortcuts({
  activeHash,
  activePhoto,
  selectedHashes,
  isLoupeOpen,
  setIsLoupeOpen,
  setIsCommitModalOpen,
  setIsDrawingFace,
  setDrawnBox,
  setActiveBulkPopover,
  gridColumns,
  navigateByOffset,
  autoAdvance,
  searchInputRef,
  handleSetFlag,
  handleBatchStageMove,
  handleBatchRate,
  handleSetColorLabel,
  handleRotateSelection,
  handleAiAnalyzeSingle,
  setViewMode,
  setCompareZoom,
  setComparePan,
  handleToggleBasketSelection,
}: UseKeyboardShortcutsParams) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      const tag = document.activeElement?.tagName.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;

      if (e.key === "ArrowRight") {
        e.preventDefault();
        navigateByOffset(1, e.shiftKey);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigateByOffset(-1, e.shiftKey);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        navigateByOffset(isLoupeOpen ? 1 : gridColumns, e.shiftKey);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        navigateByOffset(isLoupeOpen ? -1 : -gridColumns, e.shiftKey);
      } else if (e.key === " ") {
        e.preventDefault();
        if (activeHash) setIsLoupeOpen((prev) => !prev);
      } else if (e.key === "Escape") {
        setIsLoupeOpen(false);
        setIsCommitModalOpen(false);
        setIsDrawingFace(false);
        setDrawnBox(null);
        setActiveBulkPopover(null);
      } else if (e.key.toLowerCase() === "p" && selectedHashes.size > 0) {
        e.preventDefault();
        handleSetFlag("pick");
        if (autoAdvance) navigateByOffset(1, false);
      } else if (e.key.toLowerCase() === "u" && selectedHashes.size > 0) {
        e.preventDefault();
        handleSetFlag(null);
      } else if (e.key.toLowerCase() === "x" && selectedHashes.size > 0) {
        e.preventDefault();
        handleSetFlag("reject");
        handleBatchStageMove("_Trash");
        if (autoAdvance) navigateByOffset(1, false);
      } else if (["1", "2", "3", "4", "5", "0"].includes(e.key) && selectedHashes.size > 0) {
        handleBatchRate(Number(e.key));
        if (autoAdvance && e.key !== "0") navigateByOffset(1, false);
      } else if (e.key === "6" && selectedHashes.size > 0) {
        handleSetColorLabel("red");
      } else if (e.key === "7" && selectedHashes.size > 0) {
        handleSetColorLabel("yellow");
      } else if (e.key === "8" && selectedHashes.size > 0) {
        handleSetColorLabel("green");
      } else if (e.key === "9" && selectedHashes.size > 0) {
        handleSetColorLabel("blue");
      } else if (e.key === "[" && selectedHashes.size > 0) {
        handleRotateSelection(-90);
      } else if (e.key === "]" && selectedHashes.size > 0) {
        handleRotateSelection(90);
      } else if (e.key.toLowerCase() === "a" && activePhoto) {
        handleAiAnalyzeSingle();
      } else if (e.key.toLowerCase() === "g" && !isLoupeOpen) {
        setViewMode("grid");
      } else if (e.key.toLowerCase() === "m" && !isLoupeOpen) {
        setViewMode("map");
      } else if (e.key.toLowerCase() === "c" && !isLoupeOpen) {
        setCompareZoom(1);
        setComparePan({ x: 0, y: 0 });
        setViewMode((prev) => (prev === "compare" ? "grid" : "compare"));
      } else if (e.key.toLowerCase() === "b" && selectedHashes.size > 0) {
        e.preventDefault();
        handleToggleBasketSelection();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeHash,
    activePhoto,
    selectedHashes,
    isLoupeOpen,
    gridColumns,
    navigateByOffset,
    autoAdvance,
  ]);
}
