import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Command,
  FolderOpen,
  HelpCircle,
  LayoutGrid,
  Lock,
  Map as MapIcon,
  ScanFace,
  Search,
  ShieldCheck,
  Sparkles,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { platform } from "../../api/platform";
import { ReleaseNotes } from "../../utils/welcome";
import luminaMark from "../../assets/lumina-mark.svg";
import photosShot from "../../assets/tour/photos.jpg";
import compareShot from "../../assets/tour/compare.jpg";
import searchShot from "../../assets/tour/smart-search.jpg";
import peopleShot from "../../assets/tour/people.jpg";
import textShot from "../../assets/tour/text-search.jpg";
import mapShot from "../../assets/tour/map.jpg";

type Accent = "emerald" | "indigo" | "amber" | "sky";

// Literal class names per accent, so Tailwind can see them
const ACCENTS: Record<Accent, { tile: string; glow: string; text: string }> = {
  emerald: { tile: "bg-emerald-500/10 border-emerald-500/25 text-emerald-300", glow: "from-emerald-500/20", text: "text-emerald-300" },
  indigo: { tile: "bg-indigo-500/10 border-indigo-500/25 text-indigo-300", glow: "from-indigo-500/20", text: "text-indigo-300" },
  amber: { tile: "bg-amber-500/10 border-amber-500/25 text-amber-300", glow: "from-amber-500/20", text: "text-amber-300" },
  sky: { tile: "bg-sky-500/10 border-sky-500/25 text-sky-300", glow: "from-sky-500/20", text: "text-sky-300" },
};

interface TourStep {
  id: string;
  icon: typeof Sparkles;
  accent: Accent;
  eyebrow: string;
  title: string;
  text: string;
  keys?: { keys: string[]; label: string }[];
  examples?: string[];
  image: string;
  alt: string;
}

const TOUR: TourStep[] = [
  {
    id: "photos",
    icon: LayoutGrid,
    accent: "emerald",
    eyebrow: "Photos",
    title: "Cull at keyboard speed",
    text: "Open a folder and Lumina shows every photo, grouped by month. Keep, reject and rate without reaching for the mouse.",
    keys: [
      { keys: ["P"], label: "Keep" },
      { keys: ["X"], label: "Reject" },
      { keys: ["1–5"], label: "Stars" },
      { keys: ["Space"], label: "Full screen" },
    ],
    image: photosShot,
    alt: "The Photos tab with a grid of photos and the inspector",
  },
  {
    id: "compare",
    icon: Columns2,
    accent: "amber",
    eyebrow: "Bursts",
    title: "Keep the best of every burst",
    text: "Similar shots are stacked together. Compare them side by side with synchronised zoom and a focus score under each, then keep the sharpest.",
    keys: [{ keys: ["C"], label: "Compare the selection" }],
    image: compareShot,
    alt: "Two near-identical shots side by side with their focus scores",
  },
  {
    id: "search",
    icon: Search,
    accent: "sky",
    eyebrow: "Search",
    title: "Find any photo",
    text: "Search for a person, tag, place or text inside a photo. Switch on Smart and simply describe what you're looking for, in about 50 languages.",
    examples: ["dog playing outside", "rating:>=4", "place:paris", "date:2024-06"],
    keys: [{ keys: ["Ctrl", "K"], label: "Search" }],
    image: searchShot,
    alt: "Smart search results for dog playing outside",
  },
  {
    id: "people",
    icon: ScanFace,
    accent: "emerald",
    eyebrow: "People",
    title: "Name a face once",
    text: "Scan Faces finds the people in your photos. Name someone once and Lumina suggests them in all your other photos. Review the matches in the People tab.",
    examples: ["(emma or lucas) and noah", "anna and not bob"],
    image: peopleShot,
    alt: "The People tab filtered to photos of several people",
  },
  {
    id: "ai",
    icon: Wand2,
    accent: "indigo",
    eyebrow: "AI",
    title: "Captions, tags and text",
    text: "Batch AI writes a caption and tags for each photo and reads any text in it, using a vision model that runs on your PC through Ollama.",
    keys: [{ keys: ["A"], label: "Analyse this photo" }],
    image: textShot,
    alt: "A screenshot found by its booking reference, with caption, tags and detected text",
  },
  {
    id: "places",
    icon: MapIcon,
    accent: "sky",
    eyebrow: "Map and Collections",
    title: "Trips, places and albums",
    text: "Geotagged photos appear on the map. Lumina spots your trips by itself, and Collections gathers your albums, smart albums and trips.",
    keys: [{ keys: ["Ctrl", "1–4"], label: "Switch tabs" }],
    image: mapShot,
    alt: "A map of Europe with clusters of photos",
  },
];

const SAFETY = [
  "Rejected photos wait in a _Trash folder until you empty it.",
  "Moves and renames are only staged until you commit them.",
  "Almost everything can be undone with Ctrl+Z.",
  "Your originals are never edited, and nothing is uploaded.",
];

const TIPS = [
  { icon: Command, keys: ["Ctrl", "P"], title: "Command palette", text: "Find any action by its name." },
  { icon: HelpCircle, keys: ["?"], title: "Shortcuts", text: "Every keyboard shortcut on one page." },
  { icon: Undo2, keys: ["Ctrl", "Z"], title: "Undo", text: "Changed your mind? Step back." },
  { icon: Sparkles, keys: [], title: "This tour", text: "Reopen it from the Simple / Studio menu." },
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="min-w-[22px] px-1.5 py-0.5 bg-zinc-950 border border-zinc-700 border-b-2 rounded-md text-[11px] font-mono text-zinc-200 text-center"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

// A screenshot in a window frame, bleeding off the panel's bottom-right corner
function Shot({ src, alt, className = "" }: { src: string; alt: string; className?: string }) {
  return (
    <div className={`absolute rounded-xl overflow-hidden border border-zinc-700/70 shadow-2xl shadow-black/60 bg-surface ${className}`}>
      <img src={src} alt={alt} draggable={false} className="block w-full h-auto" />
    </div>
  );
}

interface WelcomeTourProps {
  isOpen: boolean;
  version: string;
  notes: ReleaseNotes[];
  hidden: boolean;
  hasFolder: boolean;
  onClose: (dontShowAgain: boolean) => void;
  onOpenFolder: () => void;
}

// First-run and after-update welcome: a short guided tour of the app (with "What's new" first after an update)
export default function WelcomeTour({ isOpen, version, notes, hidden, hasFolder, onClose, onOpenFolder }: WelcomeTourProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  const [step, setStep] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(hidden);
  const isUpdate = notes.length > 0;
  const lastStep = TOUR.length + 1;

  useEffect(() => {
    if (!isOpen) return;
    setStep(0);
    setDontShowAgain(hidden);
  }, [isOpen]);

  // Reaching the end counts as having seen it (the box stays visible, so it can still be unticked)
  useEffect(() => {
    if (step === lastStep) setDontShowAgain(true);
  }, [step]);

  if (!isOpen) return null;

  const go = (to: number) => setStep(Math.max(0, Math.min(lastStep, to)));
  const close = () => onClose(dontShowAgain);
  const finish = (openFolder: boolean) => {
    onClose(dontShowAgain);
    if (openFolder) onOpenFolder();
  };

  // The tour's own keys; stopped here so the grid shortcuts behind it never see them
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") go(step + 1);
    else if (e.key === "ArrowLeft") go(step - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const tourStep = step >= 1 && step <= TOUR.length ? TOUR[step - 1] : null;
  const accent = ACCENTS[tourStep?.accent ?? (step === 0 && isUpdate ? "indigo" : "emerald")];

  return (
    <div className="fixed inset-0 z-[9980] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={isUpdate ? `What's new in Lumina ${version}` : "Welcome to Lumina"}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative bg-raised border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col w-[min(980px,100%)] h-[min(580px,100%)]"
      >
        <button
          onClick={close}
          className="absolute top-3 right-3 z-10 p-1.5 rounded-lg bg-black/40 hover:bg-black/70 text-zinc-400 hover:text-white transition"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          {/* Left: the words */}
          <div key={step} className="lumina-tour-enter flex flex-col p-8 pr-7 min-h-0 overflow-y-auto">
            {step === 0 && !isUpdate && (
              <>
                <img src={luminaMark} alt="" className="w-11 h-11 mb-5" draggable={false} />
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-emerald-300 mb-2">Welcome</p>
                <h2 className="text-[28px] leading-tight font-semibold text-zinc-50 mb-3">Your photos, finally sorted</h2>
                <p className="text-sm text-zinc-400 leading-relaxed mb-6">
                  Lumina helps you work through a big photo library: keep the good ones, find anything in seconds and
                  see who and where your photos are. Here's a one-minute tour.
                </p>
                <ul className="flex flex-col gap-3 text-[13px]">
                  <li className="flex gap-3 items-start">
                    <Lock className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
                    <span className="text-zinc-300">
                      {platform.localFiles
                        ? "Everything runs on this PC. Your photos are never uploaded."
                        : "Everything runs on your own Lumina server. Your photos never leave it."}
                    </span>
                  </li>
                  <li className="flex gap-3 items-start">
                    <ShieldCheck className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
                    <span className="text-zinc-300">Nothing on disk changes until you say so, and you can undo.</span>
                  </li>
                  <li className="flex gap-3 items-start">
                    <Sparkles className="w-4 h-4 mt-0.5 text-indigo-300 shrink-0" />
                    <span className="text-zinc-300">Faces, captions and smart search, powered by AI on your own GPU.</span>
                  </li>
                </ul>
              </>
            )}

            {step === 0 && isUpdate && (
              <>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-indigo-300 mb-2">Updated to {version}</p>
                <h2 className="text-[28px] leading-tight font-semibold text-zinc-50 mb-5">What's new in Lumina</h2>
                <ul className="flex flex-col gap-3.5">
                  {notes.flatMap((n) =>
                    n.items.map((item) => (
                      <li key={`${n.version}-${item.title}`} className="flex gap-3 items-start">
                        <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                        <span className="text-[13px] leading-relaxed text-zinc-400">
                          <b className="font-semibold text-zinc-100">{item.title}.</b> {item.text}
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              </>
            )}

            {tourStep && (
              <>
                <span className={`w-11 h-11 mb-5 rounded-xl border grid place-items-center ${ACCENTS[tourStep.accent].tile}`}>
                  <tourStep.icon className="w-5 h-5" />
                </span>
                <p className={`text-[11px] font-bold uppercase tracking-[0.14em] mb-2 ${accent.text}`}>{tourStep.eyebrow}</p>
                <h2 className="text-[26px] leading-tight font-semibold text-zinc-50 mb-3">{tourStep.title}</h2>
                <p className="text-sm text-zinc-400 leading-relaxed mb-5">{tourStep.text}</p>
                {tourStep.examples && (
                  <div className="flex flex-wrap gap-1.5 mb-5">
                    {tourStep.examples.map((ex) => (
                      <span key={ex} className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 font-mono text-[11.5px] text-zinc-300">
                        {ex}
                      </span>
                    ))}
                  </div>
                )}
                {tourStep.keys && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-zinc-400">
                    {tourStep.keys.map((k, i) => (
                      <span key={i} className="inline-flex items-center gap-2">
                        <Keys keys={k.keys} />
                        {k.label}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}

            {step === lastStep && (
              <>
                <span className="w-11 h-11 mb-5 rounded-xl border grid place-items-center bg-emerald-500/10 border-emerald-500/25 text-emerald-300">
                  <ShieldCheck className="w-5 h-5" />
                </span>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-emerald-300 mb-2">You're all set</p>
                <h2 className="text-[26px] leading-tight font-semibold text-zinc-50 mb-3">Safe to explore</h2>
                <p className="text-sm text-zinc-400 leading-relaxed mb-5">Try things out: Lumina is careful with your files.</p>
                <ul className="flex flex-col gap-2.5">
                  {SAFETY.map((s) => (
                    <li key={s} className="flex gap-3 items-start text-[13px] text-zinc-300">
                      <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                      {s}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* Right: the picture */}
          <div className={`relative overflow-hidden bg-panel border-l border-zinc-800 bg-gradient-to-br ${accent.glow} to-transparent`}>
            {step === 0 && !isUpdate && (
              <div key="collage" className="lumina-tour-enter absolute inset-0">
                <Shot src={mapShot} alt="" className="w-[78%] left-[30%] top-[6%] opacity-60" />
                <Shot src={peopleShot} alt="" className="w-[80%] left-[18%] top-[24%] opacity-80" />
                <Shot src={photosShot} alt="The Lumina window" className="w-[86%] left-[8%] top-[44%]" />
              </div>
            )}
            {step === 0 && isUpdate && (
              <Shot key="update" src={peopleShot} alt="The new People tab" className="lumina-tour-enter w-[125%] left-10 top-10" />
            )}
            {tourStep && (
              <Shot key={tourStep.id} src={tourStep.image} alt={tourStep.alt} className="lumina-tour-enter w-[125%] left-10 top-10" />
            )}
            {step === lastStep && (
              <div key="tips" className="lumina-tour-enter absolute inset-0 p-10 grid grid-cols-2 auto-rows-min content-center gap-3">
                {TIPS.map((t) => (
                  <div key={t.title} className="rounded-xl bg-raised/80 border border-zinc-800 p-4 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <t.icon className="w-4 h-4 text-emerald-400" />
                      {t.keys.length > 0 && <Keys keys={t.keys} />}
                    </div>
                    <b className="text-[13px] font-semibold text-zinc-100">{t.title}</b>
                    <span className="text-[12px] text-zinc-400 leading-snug">{t.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer: don't-show-again, progress, navigation */}
        <div className="flex items-center gap-4 px-6 py-3.5 border-t border-zinc-800 bg-panel">
          <label className="flex items-center gap-2 text-[12px] text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="accent-emerald-500 w-3.5 h-3.5"
            />
            Don't show again until the next update
          </label>

          <div className="flex-1 flex justify-center gap-1.5" aria-hidden="true">
            {Array.from({ length: lastStep + 1 }, (_, i) => (
              <button
                key={i}
                tabIndex={-1}
                onClick={() => go(i)}
                className={`h-1.5 rounded-full transition-all ${i === step ? "w-5 bg-emerald-400" : "w-1.5 bg-zinc-700 hover:bg-zinc-500"}`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {step === 0 ? (
              <button onClick={close} className="px-3.5 py-1.5 rounded-lg text-[13px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition">
                {isUpdate ? "Close" : "Skip tour"}
              </button>
            ) : (
              <button
                onClick={() => go(step - 1)}
                className="flex items-center gap-1 pl-2.5 pr-3.5 py-1.5 rounded-lg text-[13px] text-zinc-300 border border-zinc-800 hover:bg-zinc-800 transition"
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}
            {step < lastStep ? (
              <button
                onClick={() => go(step + 1)}
                className="flex items-center gap-1 pl-4 pr-3 py-1.5 rounded-lg text-[13px] font-semibold bg-emerald-500 hover:bg-emerald-400 text-emerald-950 transition"
              >
                {step === 0 ? (isUpdate ? "Take the tour" : "Show me around") : "Next"}
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : hasFolder ? (
              <button
                onClick={() => finish(false)}
                className="px-4 py-1.5 rounded-lg text-[13px] font-semibold bg-emerald-500 hover:bg-emerald-400 text-emerald-950 transition"
              >
                Start using Lumina
              </button>
            ) : (
              <button
                onClick={() => finish(true)}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-[13px] font-semibold bg-emerald-500 hover:bg-emerald-400 text-emerald-950 transition"
              >
                <FolderOpen className="w-4 h-4" /> Open a photo folder
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
