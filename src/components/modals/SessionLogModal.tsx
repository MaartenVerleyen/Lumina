import { useDialogFocus } from "../../hooks/useDialogFocus";
import { useState } from "react";
import { Download, FileText, Trash2, X } from "lucide-react";
import { SessionLogEntry } from "../../types/lumina";

interface SessionLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  logs: SessionLogEntry[];
  onClearLogs: () => void;
}

export default function SessionLogModal({
  isOpen,
  onClose,
  logs,
  onClearLogs,
}: SessionLogModalProps) {
  const [filter, setFilter] = useState<string>("ALL");
  const [search, setSearch] = useState<string>("");
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);

  if (!isOpen) return null;

  const filteredLogs = logs.filter((l) => {
    if (filter !== "ALL" && l.category !== filter) return false;
    if (search && !l.message.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleExportText = () => {
    const text = logs
      .map((l) => `[${l.timestamp}] [${l.category}] ${l.message} ${l.details ? `(${l.details})` : ""}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lumina-session-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9990] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Session activity log"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-[#12141c] border border-zinc-800 rounded-2xl w-full max-w-2xl max-h-[80vh] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-emerald-400" />
            <h3 className="text-sm font-bold text-zinc-100">Session Activity Log ({logs.length})</h3>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="p-3 bg-zinc-950 border-b border-zinc-800/80 flex items-center justify-between gap-3 text-xs">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter log actions..."
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-zinc-200 focus:outline-none focus:border-emerald-500 font-mono text-[11px]"
          />

          <div className="flex bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 text-[10px]">
            {["ALL", "ERROR", "TRIAGE", "DISK", "AI", "FACE", "PERF"].map((cat) => (
              <button
                key={cat}
                onClick={() => setFilter(cat)}
                className={`px-2 py-0.5 rounded transition ${
                  filter === cat ? "bg-emerald-500/15 text-emerald-300 font-bold" : "text-zinc-400"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <button
            onClick={handleExportText}
            className="p-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg text-zinc-300 transition"
            title="Download Log as .txt"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClearLogs}
            className="p-1.5 bg-zinc-900 hover:bg-red-950/60 border border-zinc-800 text-zinc-400 hover:text-red-300 rounded-lg transition"
            title="Clear Log"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Log Entries List */}
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5 font-mono text-[11px]">
          {filteredLogs.length === 0 ? (
            <div className="text-center text-zinc-500 py-8">No matching session events recorded.</div>
          ) : (
            filteredLogs.map((l) => (
              <div
                key={l.id}
                className="p-2 rounded bg-zinc-950/60 border border-zinc-900 flex items-start gap-2.5"
              >
                <span className="text-zinc-500 shrink-0">{l.timestamp}</span>
                <span
                  className={`px-1.5 py-0.2 rounded text-[9px] font-bold shrink-0 ${
                    l.category === "TRIAGE"
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : l.category === "DISK"
                      ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                      : l.category === "AI"
                      ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
                      : l.category === "PERF"
                      ? "bg-fuchsia-500/10 text-fuchsia-400 border border-fuchsia-500/20"
                      : l.category === "ERROR"
                      ? "bg-red-500/10 text-red-400 border border-red-500/20"
                      : "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                  }`}
                >
                  {l.category}
                </span>
                <div className="flex-1 min-w-0 break-words">
                  <span className="text-zinc-200">{l.message}</span>
                  {l.details && <span className="text-zinc-500 ml-1.5">({l.details})</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}