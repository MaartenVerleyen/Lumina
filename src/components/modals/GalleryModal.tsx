import { useEffect, useState } from "react";
import { open, pictureDir, join } from "../../api/platform";
import { Globe, X } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";

export interface GallerySettings {
  title: string;
  destDir: string;
  captions: boolean;
  people: boolean;
  places: boolean;
  zip: boolean;
}

const SETTINGS_KEY = "lumina_gallery_settings";

function Option({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-emerald-500 w-3.5 h-3.5" />
      <span>
        <span className="text-zinc-200">{label}</span>
        <span className="block text-[11.5px] text-zinc-500 mt-0.5">{hint}</span>
      </span>
    </label>
  );
}

interface GalleryModalProps {
  target: { hashes: string[]; title: string } | null;
  onClose: () => void;
  onCreate: (settings: GallerySettings) => void;
}

// Share photos as a web page: a folder with index.html, the photos and their thumbnails
export default function GalleryModal({ target, onClose, onCreate }: GalleryModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(target !== null);
  const [s, setS] = useState<GallerySettings>({ title: "", destDir: "", captions: true, people: false, places: false, zip: false });

  useEffect(() => {
    if (!target) return;
    let saved: Partial<GallerySettings> = {};
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    } catch {}
    // The choices are remembered, the title is the set's own. Galleries go outside the library by default
    // (Pictures\Lumina Galleries), so their copies never show up as new library photos.
    if (!saved.destDir) {
      pictureDir()
        .then((pictures) => join(pictures, "Lumina Galleries"))
        .then((dir) => setS((prev) => (prev.destDir ? prev : { ...prev, destDir: dir })))
        .catch(() => {});
    }
    setS({
      title: target.title,
      destDir: saved.destDir || "",
      captions: saved.captions ?? true,
      people: saved.people ?? false,
      places: saved.places ?? false,
      zip: saved.zip ?? false,
    });
  }, [target]);

  if (!target) return null;
  const update = (patch: Partial<GallerySettings>) => setS((prev) => ({ ...prev, ...patch }));

  const create = () => {
    try {
      const { title: _title, ...remember } = s;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(remember));
    } catch {}
    onCreate(s);
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[9985] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Share as a web gallery"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        className="bg-raised border border-zinc-800 rounded-2xl shadow-2xl w-[min(560px,100%)] flex flex-col text-xs"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-[15px] font-semibold text-zinc-100 flex items-center gap-2">
            <Globe className="w-4 h-4 text-emerald-400" />
            Share as a web gallery
          </h2>
          <button onClick={onClose} className="p-1 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <p className="text-zinc-400 leading-relaxed">
            A web page with these {target.hashes.length} photos: a grid, full-screen viewing and swiping on phones. Open it
            from the folder, or upload the folder to any web host (for example Netlify Drop or GitHub Pages).
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-500">Title</span>
            <input
              autoFocus
              value={s.title}
              onChange={(e) => update({ title: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              className="bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-[13px] text-zinc-100 select-text focus:outline-none focus:border-emerald-500"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-500">Save in</span>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-[11.5px] text-zinc-300 truncate">
                {s.destDir || "Choose a folder"}
              </div>
              <button
                onClick={async () => {
                  const picked = await open({ directory: true, multiple: false, defaultPath: s.destDir || undefined });
                  if (typeof picked === "string") update({ destDir: picked });
                }}
                className="px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200"
              >
                Change…
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <span className="text-xs font-medium text-zinc-500">On the page</span>
            <Option checked={s.captions} onChange={(v) => update({ captions: v })} label="Captions" hint="The AI captions, under each photo in full-screen view." />
            <Option checked={s.people} onChange={(v) => update({ people: v })} label="People's names" hint="Off by default: only share names when the people are fine with it." />
            <Option
              checked={s.places}
              onChange={(v) => update({ places: v })}
              label="Places and a map"
              hint="Off by default: place names and a map of where the photos were taken."
            />
            <Option checked={s.zip} onChange={(v) => update({ zip: v })} label={`"Download all" link`} hint="A zip of the photos next to the page." />
          </div>
          <p className="text-zinc-500">The photos are saved at 2048 px without any metadata: no GPS, camera or original file names.</p>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-zinc-800">
          <button onClick={onClose} className="px-3.5 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!s.title.trim() || !s.destDir.trim()}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-40"
          >
            Create gallery
          </button>
        </div>
      </div>
    </div>
  );
}
