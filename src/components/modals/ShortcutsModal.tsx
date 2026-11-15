import { HelpCircle, X } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import type { LibraryState } from "../../hooks/useLibraryState";

// Every key Lumina listens to, grouped by where it works
const SHORTCUT_GROUPS: [string, [string, string][]][] = [
  [
    "Photos",
    [
      ["P / X / U", "Pick / reject (to _Trash) / clear the flag"],
      ["1 – 5 / 0", "Stars / clear the stars"],
      ["6 / 7 / 8 / 9", "Red / yellow / green / blue label"],
      ["[ / ]", "Rotate left / right"],
      ["B", "Pin or unpin"],
      ["A", "AI caption for the photo"],
      ["Arrow keys", "Next photo (Shift: extend the selection)"],
      ["Shift / Ctrl + click", "Select a range / add to the selection"],
      ["Ctrl + A", "Select all photos shown"],
      ["Esc", "Close what is open, or clear the selection"],
    ],
  ],
  [
    "Viewing",
    [
      ["Space", "Open or close the photo full screen"],
      ["Space (video)", "Play or pause"],
      ["L (hold)", "Play a Live photo"],
      ["F (full screen)", "Show or hide face boxes"],
      ["C / G / M", "Compare / grid / map"],
      ["Ctrl + 1 – 4", "Photos / Map / People / Collections"],
    ],
  ],
  [
    "Everywhere",
    [
      ["Ctrl + Z", "Undo"],
      ["Ctrl + Y / Ctrl + Shift + Z", "Redo"],
      ["Ctrl + K", "Search"],
      ["Ctrl + P", "Command palette (every action)"],
      ["Ctrl + L", "Activity log"],
      ["Ctrl + ,", "Settings"],
      ["?", "These shortcuts"],
    ],
  ],
  [
    "Search box",
    [
      ["↑ / ↓", "Choose a suggestion"],
      ["Tab / Enter", "Use the suggestion"],
      ["Esc", "Leave the search box"],
    ],
  ],
  [
    "Checking faces",
    [
      ["Y / Enter", "Yes, this is them"],
      ["N / Delete", "No, not them"],
      ["O", "Someone else…"],
      ["← / →", "Previous / next face"],
      ["Ctrl + Z", "Undo the last answer"],
    ],
  ],
];

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
                Keyboard shortcuts
              </span>
              <button
                onClick={() => lib.setIsShortcutsModalOpen(false)}
                className="text-zinc-500 hover:text-white"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-col gap-3 max-h-[70vh] overflow-y-auto pr-1">
              {SHORTCUT_GROUPS.map(([title, keys]) => (
                <div key={title} className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-semibold text-zinc-500">{title}</span>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    {keys.map(([key, desc]) => (
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
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
