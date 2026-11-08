import { HelpCircle, X } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import type { LibraryState } from "../../hooks/useLibraryState";

// The keyboard shortcuts cheat sheet (?)
export default function ShortcutsModal({ lib }: { lib: LibraryState }) {
  const shortcutsDialogRef = useDialogFocus<HTMLDivElement>(lib.isShortcutsModalOpen);
  return (
    <>
      {lib.isShortcutsModalOpen && (
        <div
          onClick={() => lib.setIsShortcutsModalOpen(false)}
          className="fixed inset-0 z-[9995] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none"
        >
          <div
            ref={shortcutsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            className="bg-raised border border-zinc-800 rounded-2xl w-full max-w-lg p-5 shadow-2xl flex flex-col gap-3 text-xs"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <span className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-emerald-400" />
                Lumina Keyboard Shortcuts
              </span>
              <button
                onClick={() => lib.setIsShortcutsModalOpen(false)}
                className="text-zinc-500 hover:text-white"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {[
                ["Space", "Open / Close Fullscreen Loupe"],
                ["P / X / U", "Pick / Reject (_Trash) / Unflag"],
                ["1 – 5 / 0", "Set Star Rating / Clear Rating"],
                ["6 / 7 / 8 / 9", "Red / Yellow / Green / Blue Label"],
                ["[ / ]", "Rotate Left / Right 90°"],
                ["B", "Pin or unpin"],
                ["A", "Run AI Vision on Active Photo"],
                ["C / G / M", "Compare / Grid / Map View"],
                ["Ctrl + 1 – 4", "Photos / Map / People / Collections"],
                ["Ctrl + Z / Y", "Undo / Redo Last Action"],
                ["Ctrl + K", "Search"],
                ["Ctrl + P", "Command Palette (every action)"],
                ["Ctrl + L", "What Lumina did (activity log)"],
                ["?", "Show these shortcuts"],
                ["Esc", "Close Dialog / Loupe"],
              ].map(([key, desc]) => (
                <div
                  key={key}
                  className="p-2 rounded-lg bg-zinc-900/70 border border-zinc-800/80 flex items-center justify-between gap-2"
                >
                  <span className="text-zinc-400">{desc}</span>
                  <kbd className="px-1.5 py-0.5 bg-zinc-950 border border-zinc-700 rounded text-emerald-300 font-mono text-[11px] shrink-0">
                    {key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
