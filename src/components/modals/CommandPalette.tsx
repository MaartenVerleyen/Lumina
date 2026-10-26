import { useEffect, useMemo, useRef, useState } from "react";
import { Command, CornerDownLeft } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { PaletteAction, rankActions } from "../../utils/commandSearch";

export type { PaletteAction };

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}

// Ctrl+P: find any action by name and run it with Enter
export default function CommandPalette({ isOpen, onClose, actions }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setCursor(0);
    }
  }, [isOpen]);

  const results = useMemo(() => rankActions(actions, query), [actions, query]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!isOpen) return null;

  const runAt = (index: number) => {
    const action = results[index];
    if (!action) return;
    onClose();
    // After the palette has closed and focus went back, so the action sees the app as usual
    setTimeout(action.run, 0);
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9996] bg-black/60 backdrop-blur-[2px] flex items-start justify-center pt-[12vh] px-6 select-none"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl bg-raised border border-zinc-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-zinc-800">
          <Command className="w-4 h-4 text-emerald-400 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(results.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(cursor);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Type a command… (e.g. scan faces, pick, map, export)"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[cursor] ? `palette-${results[cursor].id}` : undefined}
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none select-text"
          />
          <kbd className="px-1.5 py-0.5 bg-zinc-950 border border-zinc-700 rounded text-zinc-400 font-mono text-[11px]">
            Esc
          </kbd>
        </div>

        <div ref={listRef} id="palette-results" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-zinc-500">No command matches "{query}"</div>
          ) : (
            results.map((action, i) => (
              <div
                key={action.id}
                id={`palette-${action.id}`}
                data-index={i}
                role="option"
                aria-selected={i === cursor}
                onMouseMove={() => setCursor(i)}
                onClick={() => runAt(i)}
                className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg cursor-pointer text-sm ${
                  i === cursor ? "bg-emerald-500/15 text-emerald-100" : "text-zinc-300"
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] text-zinc-500 w-16 shrink-0 truncate">{action.group}</span>
                  <span className="truncate">{action.label}</span>
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {action.shortcut && (
                    <kbd className="px-1.5 py-0.5 bg-zinc-950 border border-zinc-700 rounded text-emerald-300 font-mono text-[11px]">
                      {action.shortcut}
                    </kbd>
                  )}
                  {i === cursor && <CornerDownLeft className="w-3.5 h-3.5 text-zinc-500" />}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
