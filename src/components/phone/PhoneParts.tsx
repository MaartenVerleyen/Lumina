import { ArrowLeft } from "lucide-react";

// Pieces the phone app's own pages share (Backup, Settings): a page over the tabs, its sections, switches

export function Page({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface text-zinc-200">
      <header className="shrink-0 bg-panel/95 border-b border-zinc-800/80 px-2" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.25rem)" }}>
        <div className="h-12 flex items-center gap-1">
          <button onClick={onBack} className="p-2 rounded-full text-zinc-300 active:bg-white/10" aria-label="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="text-[15px] font-semibold text-zinc-100">{title}</div>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-6" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1.5rem)" }}>
        {children}
      </div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mx-3 mt-4 rounded-2xl bg-raised/70 border border-zinc-800 px-4 py-3">
      {title && <h2 className="text-xs text-zinc-500 pb-1">{title}</h2>}
      {children}
    </section>
  );
}

export function Switch({ on }: { on: boolean }) {
  return (
    <span className={`shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors ${on ? "bg-emerald-600" : "bg-zinc-700"}`}>
      <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${on ? "translate-x-4" : ""}`} />
    </span>
  );
}

export function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className="w-full flex items-center justify-between gap-3 py-2.5 text-left text-sm text-zinc-200">
      <span>{label}</span>
      <Switch on={on} />
    </button>
  );
}
