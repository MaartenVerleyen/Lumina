import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

// A folder (or file) dropped on the window from Explorer opens as the library; `isDraggingOverWindow`
// drives the full-window drop overlay.
export function useWindowFileDrop(handleLoadFolderPath: (path: string) => void) {
  const [isDraggingOverWindow, setIsDraggingOverWindow] = useState<boolean>(false);

  // Global Tauri Drag & Drop Folder/File Listener: registered once (re-registering every render leaked
  // listeners, so one drop could start several concurrent folder loads)
  const loadFolderRef = useRef(handleLoadFolderPath);
  loadFolderRef.current = handleLoadFolderPath;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over" || event.payload.type === "enter") {
            setIsDraggingOverWindow(true);
          } else if (event.payload.type === "drop") {
            setIsDraggingOverWindow(false);
            const droppedPath = event.payload.paths?.[0];
            if (droppedPath) {
              loadFolderRef.current(droppedPath);
            }
          } else {
            setIsDraggingOverWindow(false);
          }
        })
        .then((fn) => {
          // If the component unmounted before registration finished, unregister immediately
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {}
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  return isDraggingOverWindow;
}
