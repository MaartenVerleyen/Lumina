import { ArrowLeft } from "lucide-react";

// Pieces the phone app's screens share, after the agreed rules (docs/plans/android.md, "The rules, as agreed"):
// a page over the tabs, its sections, switches, buttons and the four text sizes

// The four text sizes: a page's title, body text, secondary lines and captions
export const T = {
  title: "text-[17px] font-semibold text-zinc-100",
  body: "text-[15px] text-zinc-200",
  secondary: "text-[13px] text-zinc-400",
  caption: "text-[11px] text-zinc-500",
} as const;

// The three buttons: the main action (filled green), the others (grey), small links (green text). At least
// 44 px high, with a word; `icon` goes before it. `wide` fills the row.
export function Button({
  kind = "secondary",
  icon,
  wide,
  disabled,
  onClick,
  type = "button",
  children,
}: {
  kind?: "primary" | "secondary" | "text";
  icon?: React.ReactNode;
  wide?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  children: React.ReactNode;
}) {
  const look =
    kind === "primary"
      ? "bg-emerald-600 text-white font-semibold active:bg-emerald-700"
      : kind === "secondary"
        ? "bg-zinc-800 text-zinc-100 active:bg-zinc-700"
        : "text-emerald-400 active:bg-white/5";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`min-h-11 px-4 rounded-full inline-flex items-center justify-center gap-2 text-[15px] whitespace-nowrap disabled:opacity-40 transition-colors ${look} ${wide ? "w-full" : "shrink-0"}`}
    >
      {icon}
      {children}
    </button>
  );
}

// `action`: a button at the right of the header; `fill`: the content takes the whole height and scrolls itself
export function Page({
  title,
  onBack,
  action,
  fill,
  children,
}: {
  title: string;
  onBack: () => void;
  action?: React.ReactNode;
  fill?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="phone-ui fixed inset-0 z-40 flex flex-col bg-surface text-zinc-200">
      <header className="shrink-0 bg-panel/95 border-b border-zinc-800/80 px-2" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.25rem)" }}>
        <div className="h-12 flex items-center gap-1">
          <button onClick={onBack} className="p-2 rounded-full text-zinc-300 active:bg-white/10" aria-label="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className={`flex-1 min-w-0 truncate ${T.title}`}>{title}</div>
          {action}
        </div>
      </header>
      <div
        className={`flex-1 min-h-0 ${fill ? "overflow-hidden" : "overflow-y-auto overscroll-contain pb-6"}`}
        style={{ paddingBottom: `calc(env(safe-area-inset-bottom) + ${fill ? "0.5rem" : "1.5rem"})` }}
      >
        {children}
      </div>
    </div>
  );
}

// "1 photo", "51.710 photos"
export function photoCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "photo" : "photos"}`;
}

// A section's title on a tab (Albums, Search), with "All" when there is more
export function SectionTitle({ children, onAll }: { children: React.ReactNode; onAll?: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 pt-5 pb-2">
      <h2 className={`${T.body} font-semibold text-zinc-100`}>{children}</h2>
      {onAll && (
        <button onClick={onAll} className="-mr-2 min-h-11 px-2 text-[13px] text-emerald-400 active:bg-white/5 rounded-full">
          All
        </button>
      )}
    </div>
  );
}

// The one card for albums, trips, places, things and the phone's folders: a square picture, its name under it,
// and a line (a count) under that
export function Card({
  src,
  icon,
  title,
  sub,
  badge,
  onClick,
}: {
  src?: string | null;
  // In place of a picture (the Map)
  icon?: React.ReactNode;
  title: string;
  sub?: string;
  badge?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="w-full text-left active:opacity-70">
      <div className="relative aspect-square rounded-xl overflow-hidden bg-zinc-800">
        {src ? <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" /> : icon && <div className="w-full h-full flex items-center justify-center bg-emerald-900/40 text-emerald-300">{icon}</div>}
        {badge && <span className="absolute top-1.5 right-1.5 rounded-full bg-zinc-950/80 p-1">{badge}</span>}
      </div>
      <div className={`pt-1.5 truncate ${T.body}`}>{title}</div>
      {sub && <div className={`truncate tabular-nums ${T.secondary}`}>{sub}</div>}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mx-4 mt-4 rounded-2xl bg-raised/70 border border-zinc-800 px-4 py-3">
      {title && <h2 className={`pb-1 ${T.secondary}`}>{title}</h2>}
      {children}
    </section>
  );
}

export function Switch({ on, disabled }: { on: boolean; disabled?: boolean }) {
  return (
    <span className={`shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors ${on ? "bg-emerald-600" : "bg-zinc-700"} ${disabled ? "opacity-40" : ""}`}>
      <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${on ? "translate-x-4" : ""}`} />
    </span>
  );
}

// `disabled`: greyed out as a whole (a setting that only counts while another is on)
export function Toggle({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => onChange(!on)}
      disabled={disabled}
      className={`w-full min-h-11 flex items-center justify-between gap-3 py-2 text-left ${T.body} ${disabled ? "text-zinc-500" : ""}`}
    >
      <span>{label}</span>
      <Switch on={on} disabled={disabled} />
    </button>
  );
}
