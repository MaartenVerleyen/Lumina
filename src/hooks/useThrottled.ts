import { useEffect, useRef, useState } from "react";

// While `active`, follows `value` at most once every `ms` (always ending on the latest value);
// otherwise returns `value` as it is.
export function useThrottled<T>(value: T, active: boolean, ms: number): T {
  const [shown, setShown] = useState(value);
  const lastUpdate = useRef(0);
  useEffect(() => {
    if (!active) {
      setShown(value);
      return;
    }
    const wait = Math.max(0, lastUpdate.current + ms - performance.now());
    const timer = setTimeout(() => {
      lastUpdate.current = performance.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, active, ms]);
  return active ? shown : value;
}
