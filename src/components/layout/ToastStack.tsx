import { AlertCircle, Sparkles, X } from "lucide-react";
import type { Toast } from "../../hooks/useLibraryState";

interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  onOpenSessionLog: () => void;
}

// Bottom-right notification stack: newest at the bottom, errors link to the Session Log for details
export default function ToastStack({ toasts, onDismiss, onOpenSessionLog }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed bottom-10 right-5 z-[9990] flex flex-col gap-2 max-w-md pointer-events-auto"
      aria-live="polite"
    >
      {toasts.map((t) =>
        t.kind === "error" ? (
          <div
            key={t.id}
            role="alert"
            className="px-4 py-2.5 bg-red-950/95 border border-red-500/50 text-red-200 rounded-xl shadow-2xl backdrop-blur-md text-xs flex items-start justify-between gap-3 animate-in fade-in slide-in-from-bottom-2"
          >
            <div className="flex items-start gap-2 min-w-0">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-px" />
              <div className="min-w-0">
                <span className="break-words">{t.message}</span>
                <button
                  onClick={onOpenSessionLog}
                  className="block mt-1 text-[11px] text-red-300 underline underline-offset-2 hover:text-white"
                >
                  Open Session Log
                </button>
              </div>
            </div>
            <button
              onClick={() => onDismiss(t.id)}
              className="text-red-400 hover:text-white shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div
            key={t.id}
            role="status"
            className="px-4 py-2.5 bg-raised/95 border border-emerald-500/40 text-emerald-200 rounded-xl shadow-2xl backdrop-blur-md text-xs flex items-start justify-between gap-3 animate-in fade-in slide-in-from-bottom-2"
          >
            <div className="flex items-start gap-2 min-w-0">
              <Sparkles className="w-4 h-4 text-emerald-400 shrink-0 mt-px" />
              <div className="min-w-0">
                <span className="break-words">{t.message}</span>
                {t.action && (
                  <button
                    onClick={() => {
                      onDismiss(t.id);
                      t.action!.run();
                    }}
                    className="block mt-1.5 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
            </div>
            <button
              onClick={() => onDismiss(t.id)}
              className="text-zinc-400 hover:text-white shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )
      )}
    </div>
  );
}
