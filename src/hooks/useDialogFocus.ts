import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open dialogs, innermost last: only the top one traps Tab
const openDialogs: HTMLElement[] = [];

// Keyboard focus for a modal dialog: moves focus into it when it opens, keeps Tab / Shift+Tab inside it,
// and gives focus back to whatever had it before when it closes. Attach the ref to the dialog panel.
export function useDialogFocus<T extends HTMLElement>(isOpen: boolean) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!isOpen || !el) return;
    const previous = document.activeElement as HTMLElement | null;
    openDialogs.push(el);

    const focusables = () =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((f) => f.offsetParent !== null);

    // Focus the panel itself (it needs tabIndex={-1}), not its first button: in the Loupe a focused button
    // would turn Space ("close") into "Open External". An [autofocus] field still wins.
    if (!el.contains(document.activeElement)) {
      const initial = el.querySelector<HTMLElement>("[autofocus]") ?? el;
      initial.focus({ preventScroll: true });
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || openDialogs[openDialogs.length - 1] !== el) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!el!.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const idx = openDialogs.lastIndexOf(el);
      if (idx >= 0) openDialogs.splice(idx, 1);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [isOpen]);

  return ref;
}
