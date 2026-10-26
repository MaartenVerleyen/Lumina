import { RefObject, useEffect, useRef } from "react";

// Wheel handler that can block page scrolling: React registers `onWheel` as a passive listener, so its
// preventDefault() is ignored (and logs a warning). This attaches a native non-passive listener instead.
export function useWheel(
  ref: RefObject<HTMLElement | null>,
  onWheel: (e: WheelEvent) => void,
  active = true
) {
  const handlerRef = useRef(onWheel);
  handlerRef.current = onWheel;

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const listener = (e: WheelEvent) => {
      e.preventDefault();
      handlerRef.current(e);
    };
    el.addEventListener("wheel", listener, { passive: false });
    return () => el.removeEventListener("wheel", listener);
  }, [ref, active]);
}
