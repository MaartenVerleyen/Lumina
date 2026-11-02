// What this app can do on the computer it runs on, beyond the engine: file and folder pickers, opening links,
// the updater, well-known folders, files dropped on the window. The desktop app has all of them; a web
// client (Lumina 5) has none of these and hides what needs them, so components import them from here only.
export { open, save } from "@tauri-apps/plugin-dialog";
export { openUrl } from "@tauri-apps/plugin-opener";
export { check, type Update } from "@tauri-apps/plugin-updater";
export { getVersion } from "@tauri-apps/api/app";
export { documentDir, pictureDir, join } from "@tauri-apps/api/path";
export { getCurrentWebview } from "@tauri-apps/api/webview";

export const platform = {
  // Native dialogs to pick files and folders on this computer
  fileDialogs: true,
  // Libraries on this computer's own drives (scan, open in Explorer, import from a card)
  localFiles: true,
  // Updates through the built-in updater
  updater: true,
};
