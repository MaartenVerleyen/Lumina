import { useCallback, useEffect, useRef, useState } from "react";

// Where photos can be dropped. Drop targets are plain elements marked with
// data-drop-kind / data-drop-value / data-drop-label (sidebar folders, filters, people chips).
export type DropKind = "folder" | "person" | "trash" | "pick" | "basket";
export interface DropTarget {
  kind: DropKind;
  value: string;
  label: string;
}

export interface DragState {
  count: number;
  x: number;
  y: number;
  thumbHash: string;
  target: DropTarget | null;
}

const START_DISTANCE = 6;
const HOVER_CLASS = "lumina-drop-hover";

function dropTargetAt(x: number, y: number): { el: HTMLElement; target: DropTarget } | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-kind]");
  if (!el) return null;
  const kind = el.dataset.dropKind as DropKind;
  return {
    el,
    target: { kind, value: el.dataset.dropValue ?? "", label: el.dataset.dropLabel ?? el.dataset.dropValue ?? kind },
  };
}

// Drag photos from the grid onto targets in the app. WebView2 can't do HTML5 drag-and-drop here (Tauri's
// window-level file drop takes it over), so this follows the pointer itself: press on a photo, move a few
// pixels, and a ghost follows the pointer until it is released.
export function usePhotoDrag(
  // The photos a drag starting on `hash` carries (the selection, or just that photo)
  hashesForDrag: (hash: string) => string[],
  onDrop: (hashes: string[], target: DropTarget) => void
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const pendingRef = useRef<{ hash: string; x: number; y: number; hashes: string[] | null } | null>(null);
  const hoverElRef = useRef<HTMLElement | null>(null);
  const latest = useRef({ hashesForDrag, onDrop });
  latest.current = { hashesForDrag, onDrop };

  const setHover = (el: HTMLElement | null) => {
    if (hoverElRef.current === el) return;
    hoverElRef.current?.classList.remove(HOVER_CLASS);
    el?.classList.add(HOVER_CLASS);
    hoverElRef.current = el;
  };

  const finish = useCallback(() => {
    pendingRef.current = null;
    setHover(null);
    setDrag(null);
    document.body.style.cursor = "";
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending) return;
      if (!pending.hashes) {
        if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < START_DISTANCE) return;
        pending.hashes = latest.current.hashesForDrag(pending.hash);
        document.body.style.cursor = "grabbing";
      }
      const hit = dropTargetAt(e.clientX, e.clientY);
      setHover(hit?.el ?? null);
      setDrag({
        count: pending.hashes.length,
        x: e.clientX,
        y: e.clientY,
        thumbHash: pending.hash,
        target: hit?.target ?? null,
      });
    }

    function onUp(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending) return;
      if (pending.hashes) {
        const hit = dropTargetAt(e.clientX, e.clientY);
        // The click that follows a drag must not select or open anything
        const swallow = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
        if (hit) latest.current.onDrop(pending.hashes, hit.target);
      }
      finish();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && pendingRef.current?.hashes) finish();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [finish]);

  // Grid cards call this on pointerdown; nothing happens until the pointer actually moves
  const onCardPointerDown = useCallback((hash: string, e: React.PointerEvent) => {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
    pendingRef.current = { hash, x: e.clientX, y: e.clientY, hashes: null };
  }, []);

  return { drag, onCardPointerDown };
}
