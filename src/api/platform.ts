// What this app can do on the computer it runs on, beyond the engine: file and folder pickers, opening links,
// the updater, well-known folders, files dropped on the window. The desktop app has all of them; the web
// client has none: these stand-ins keep a browser from calling Tauri, and the flags let the UI hide what
// needs them. Components import them from here only.
import * as dialog from "@tauri-apps/plugin-dialog";
import * as opener from "@tauri-apps/plugin-opener";
import * as updater from "@tauri-apps/plugin-updater";
import * as app from "@tauri-apps/api/app";
import * as paths from "@tauri-apps/api/path";
import * as webview from "@tauri-apps/api/webview";
import { inDesktopApp } from "./index";

export type { Update } from "@tauri-apps/plugin-updater";

export const platform = {
  // Native dialogs to pick files and folders on this computer
  fileDialogs: inDesktopApp,
  // Libraries on this computer's own drives (scan, open in Explorer, import from a card, export, back up)
  localFiles: inDesktopApp,
  // Updates through the built-in updater (a server updates with its image)
  updater: inDesktopApp,
  // The library's background work runs in this app (face scans and their upgrades, eyes and focus, the smart
  // search index). A server's own pipeline does all of that, so its web client never starts them.
  libraryJobs: inDesktopApp,
};

const noComputer = () => Promise.reject("Not available in the browser");

// In a browser a picker is "cancelled": callers already handle a null answer
export const open: typeof dialog.open = inDesktopApp ? dialog.open : ((async () => null) as unknown as typeof dialog.open);
export const save: typeof dialog.save = inDesktopApp ? dialog.save : async () => null;
export const openUrl: typeof opener.openUrl = inDesktopApp
  ? opener.openUrl
  : async (url) => {
      window.open(String(url), "_blank", "noopener,noreferrer");
    };
export const check: typeof updater.check = inDesktopApp ? updater.check : async () => null;
export const getVersion: typeof app.getVersion = inDesktopApp ? app.getVersion : async () => __APP_VERSION__;
export const documentDir: typeof paths.documentDir = inDesktopApp ? paths.documentDir : noComputer;
export const pictureDir: typeof paths.pictureDir = inDesktopApp ? paths.pictureDir : noComputer;
export const join: typeof paths.join = inDesktopApp ? paths.join : noComputer;

// Files dropped on the window: the desktop opens a dropped folder; a browser has no paths to open
type WebviewLike = Pick<ReturnType<typeof webview.getCurrentWebview>, "onDragDropEvent">;
export function getCurrentWebview(): WebviewLike {
  if (inDesktopApp) return webview.getCurrentWebview();
  return { onDragDropEvent: async () => () => {} };
}
