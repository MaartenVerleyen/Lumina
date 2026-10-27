import { useEffect, useRef, useState } from "react";
import { loadLayout, LAYOUT_KEY, SavedLayout } from "./layout";
import type { LibraryState } from "../hooks/useLibraryState";

// Pane widths, collapsed panes and sidebar sections, the open tab, zoom and sort: restored at start and
// saved (debounced) whenever they change. Also the mouse handling that drags the pane dividers.
export function usePaneLayout(lib: LibraryState) {
  // Pane sizes and collapsed parts come back as they were left (see the layout effect below)
  const [savedLayout] = useState(loadLayout);
  const [leftWidth, setLeftWidth] = useState<number>(savedLayout.leftWidth);
  const [rightWidth, setRightWidth] = useState<number>(savedLayout.rightWidth);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState<boolean>(savedLayout.leftCollapsed);
  const [isRightCollapsed, setIsRightCollapsed] = useState<boolean>(savedLayout.rightCollapsed);
  const [collapsedSections, setCollapsedSections] = useState<string[]>(savedLayout.collapsedSections);
  const draggingPaneRef = useRef<"left" | "right" | null>(null);

  useEffect(() => {
    lib.setZoomLevel(savedLayout.zoom);
    lib.setSortBy(savedLayout.sort);
    lib.setViewMode(savedLayout.tab);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const layout: SavedLayout = {
        tab: lib.viewMode === "compare" ? "grid" : lib.viewMode,
        zoom: lib.zoomLevel,
        sort: lib.sortBy,
        leftWidth,
        rightWidth,
        leftCollapsed: isLeftCollapsed,
        rightCollapsed: isRightCollapsed,
        collapsedSections,
      };
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
      } catch {}
    }, 400);
    return () => clearTimeout(timer);
  }, [lib.viewMode, lib.zoomLevel, lib.sortBy, leftWidth, rightWidth, isLeftCollapsed, isRightCollapsed, collapsedSections]);

  // Pane Resize Listeners
  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!draggingPaneRef.current) return;
      const maxAllowed = Math.floor(window.innerWidth * 0.78);
      if (draggingPaneRef.current === "left") {
        setLeftWidth(Math.max(160, Math.min(maxAllowed, e.clientX)));
      } else if (draggingPaneRef.current === "right") {
        setRightWidth(Math.max(260, Math.min(maxAllowed, window.innerWidth - e.clientX)));
      }
    }
    function handleMouseUp() {
      if (draggingPaneRef.current) {
        draggingPaneRef.current = null;
        document.body.style.cursor = "";
      }
    }
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return {
    leftWidth,
    rightWidth,
    isLeftCollapsed,
    setIsLeftCollapsed,
    isRightCollapsed,
    setIsRightCollapsed,
    collapsedSections,
    setCollapsedSections,
    draggingPaneRef,
  };
}
