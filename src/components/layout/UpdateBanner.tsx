import { Download, Sparkles, X } from "lucide-react";
import type { Updater } from "../../hooks/useUpdater";

const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

// Bottom-left card when a new version is available: Update now (download, install, restart) or Later
export default function UpdateBanner({ updater }: { updater: Updater }) {
  const { state } = updater;
  if (state.kind !== "available" && state.kind !== "downloading" && state.kind !== "installing") return null;
  if (state.kind === "available" && updater.dismissed) return null;
  const update = state.update;
  // The release notes are short lines; the first few are enough here (the welcome tour shows all after the update)
  // Lines look like "- **Title.** text" (written by scripts/release.ps1)
  const notes = (update.body || "")
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((l) => {
      const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(l);
      return m ? { title: m[1], text: m[2] } : { title: "", text: l };
    });

  return (
    <div className="fixed left-4 bottom-12 z-[9970] w-80 rounded-2xl bg-raised border border-emerald-500/30 shadow-2xl shadow-black/60 p-4 flex flex-col gap-3 text-xs lumina-tour-enter">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/25 grid place-items-center shrink-0">
          <Sparkles className="w-4 h-4 text-emerald-300" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-zinc-100">Lumina {update.version} is available</div>
          <div className="text-zinc-500">You have {update.currentVersion}</div>
        </div>
        {state.kind === "available" && (
          <button onClick={updater.dismiss} className="text-zinc-500 hover:text-white" aria-label="Later">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {notes.length > 0 && state.kind === "available" && (
        <ul className="flex flex-col gap-1 text-zinc-400 leading-snug">
          {notes.map((n) => (
            <li key={n.title + n.text} className="flex gap-2">
              <span className="mt-[6px] w-1 h-1 rounded-full bg-emerald-400 shrink-0" />
              <span>
                {n.title && <b className="font-semibold text-zinc-200">{n.title} </b>}
                {n.text}
              </span>
            </li>
          ))}
        </ul>
      )}

      {state.kind === "available" && (
        <div className="flex justify-end gap-2">
          <button onClick={updater.dismiss} className="px-3 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
            Later
          </button>
          <button
            onClick={updater.install}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
          >
            <Download className="w-3.5 h-3.5" />
            Update now
          </button>
        </div>
      )}

      {state.kind === "downloading" && (
        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-[width]"
              style={{ width: state.total > 0 ? `${Math.min(100, (state.downloaded / state.total) * 100)}%` : "15%" }}
            />
          </div>
          <span className="text-zinc-400">
            Downloading {mb(state.downloaded)}
            {state.total > 0 ? ` of ${mb(state.total)}` : ""} MB…
          </span>
        </div>
      )}

      {state.kind === "installing" && (
        <span className="text-zinc-300">Installing. Lumina closes and starts again by itself in a moment.</span>
      )}
    </div>
  );
}
