import { useEffect, useState } from "react";
import { open } from "../../api/platform";
import { Download, FolderOpen, X } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";

export interface ExportSettings {
  destDir: string;
  longEdge: number; // 0 = full size
  quality: number;
  stripGps: boolean;
}

interface ExportModalProps {
  isOpen: boolean;
  count: number;
  defaultDir: string;
  onClose: () => void;
  onExport: (settings: ExportSettings) => void;
}

const PRESETS: { label: string; hint: string; longEdge: number; quality: number }[] = [
  { label: "Full size", hint: "Best quality, for printing or archiving", longEdge: 0, quality: 92 },
  { label: "Sharing (2048 px)", hint: "Mail, messaging, cloud albums", longEdge: 2048, quality: 88 },
  { label: "Social (1080 px)", hint: "Instagram, Facebook", longEdge: 1080, quality: 85 },
];

const SETTINGS_KEY = "lumina_export_settings";

function loadSettings(defaultDir: string): ExportSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (saved && typeof saved.destDir === "string") return { ...saved, destDir: saved.destDir || defaultDir };
  } catch {}
  return { destDir: defaultDir, longEdge: 2048, quality: 88, stripGps: true };
}

// Export the selection as JPEGs (resized, rotated, optionally without GPS) to a folder
export default function ExportModal({ isOpen, count, defaultDir, onClose, onExport }: ExportModalProps) {
  const [settings, setSettings] = useState<ExportSettings>(() => loadSettings(defaultDir));
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);

  useEffect(() => {
    if (isOpen) setSettings(loadSettings(defaultDir));
  }, [isOpen, defaultDir]);

  if (!isOpen) return null;

  const update = (patch: Partial<ExportSettings>) => setSettings((s) => ({ ...s, ...patch }));

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: settings.destDir || undefined });
    if (typeof picked === "string") update({ destDir: picked });
  };

  const start = () => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
    onExport(settings);
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9995] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Export photos"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Typing in the dialog must not reach the grid shortcuts
          e.stopPropagation();
          if (e.key === "Escape") onClose();
        }}
        className="bg-raised border border-zinc-800 rounded-2xl w-full max-w-md p-5 shadow-2xl flex flex-col gap-4 text-xs"
      >
        <div className="flex items-center justify-between">
          <span className="font-bold text-sm text-zinc-100 flex items-center gap-2">
            <Download className="w-4 h-4 text-emerald-400" />
            Export {count} photo{count === 1 ? "" : "s"}
          </span>
          <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Size</span>
          {PRESETS.map((p) => (
            <label
              key={p.label}
              className={`flex items-center gap-2.5 p-2 rounded-lg border cursor-pointer ${
                settings.longEdge === p.longEdge
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-100"
                  : "border-zinc-800 text-zinc-300 hover:bg-zinc-900"
              }`}
            >
              <input
                type="radio"
                name="export-size"
                checked={settings.longEdge === p.longEdge}
                onChange={() => update({ longEdge: p.longEdge, quality: p.quality })}
                className="accent-emerald-500"
              />
              <span className="flex-1">
                <span className="font-medium">{p.label}</span>
                <span className="block text-[11px] text-zinc-500">{p.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <label className="flex items-center gap-3">
          <span className="text-zinc-300 w-24">JPEG quality</span>
          <input
            type="range"
            min={60}
            max={100}
            value={settings.quality}
            onChange={(e) => update({ quality: Number(e.target.value) })}
            className="flex-1 accent-emerald-500"
          />
          <span className="font-mono text-zinc-300 w-8 text-right">{settings.quality}</span>
        </label>

        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.stripGps}
            onChange={(e) => update({ stripGps: e.target.checked })}
            className="mt-0.5 accent-emerald-500"
          />
          <span className="text-zinc-300">
            Remove GPS location
            <span className="block text-[11px] text-zinc-500">
              Recommended when sharing. Capture date and camera are kept.
            </span>
          </span>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Folder</span>
          <div className="flex gap-1.5">
            <input
              value={settings.destDir}
              onChange={(e) => update({ destDir: e.target.value })}
              placeholder="Choose a folder"
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-[11px] select-text focus:outline-none focus:border-emerald-500"
            />
            <button
              onClick={chooseFolder}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 flex items-center gap-1"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Choose…
            </button>
          </div>
          <span className="text-[11px] text-zinc-500">
            Originals are never changed. Existing files are not overwritten (a _2 is added).
          </span>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg">
            Cancel
          </button>
          <button
            onClick={start}
            disabled={!settings.destDir.trim() || count === 0}
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg font-semibold"
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
