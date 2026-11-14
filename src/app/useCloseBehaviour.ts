import { useEffect, useRef } from "react";
import { callLocal, inDesktopApp, onAndroid, subscribeLocal } from "../api";
import { confirmWithCheck } from "../confirm";
import { updateSettings, useSettings } from "../settings";
import type { BackgroundJob } from "../components/layout/BottomStatusBar";
import { plural } from "../utils/plural";

// Closing the desktop app's window: the settings go to the app's Rust side (window_close.rs), which keeps
// Lumina in the tray or asks this window first. The question names the work that would stop.
export function useCloseBehaviour(jobs: BackgroundJob[], onError: (message: string) => void) {
  const { askBeforeClosing, closeToTray } = useSettings();
  const desktop = inDesktopApp && !onAndroid;

  useEffect(() => {
    if (!desktop) return;
    callLocal("set_close_behaviour", { ask: askBeforeClosing, toTray: closeToTray }).catch((err) => {
      // No tray on this computer: closing closes (and asks, if that is on)
      if (closeToTray) {
        updateSettings({ closeToTray: false });
        onError(`Lumina can't stay in the tray here: ${err}`);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, askBeforeClosing, closeToTray]);

  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => {
    if (!desktop) return;
    let asking = false;
    const off = subscribeLocal("window-close-requested", async () => {
      // A second click on the close button while the question is open
      if (asking) return;
      asking = true;
      try {
        // A server's own work goes on without this app
        const running = jobsRef.current.filter((j) => !j.id.startsWith("server-scan:"));
        const work =
          running.length > 0
            ? `${plural(running.length, "job")} still running will stop: ${running.map((j) => j.label).join(", ")}. They carry on the next time Lumina opens.`
            : "Nothing is running in the background.";
        const { ok, checked } = await confirmWithCheck(
          `${work}\n\nTo keep Lumina working with its window closed, turn on "Keep running in the tray" in Settings → General.`,
          "Don't ask again",
          { title: "Close Lumina?", okLabel: "Close", cancelLabel: "Cancel", kind: running.length > 0 ? "warning" : "info" }
        );
        if (!ok) return;
        if (checked) updateSettings({ askBeforeClosing: false });
        await callLocal("quit_app");
      } finally {
        asking = false;
      }
    });
    return () => {
      off.then((f) => f());
    };
  }, [desktop]);
}
