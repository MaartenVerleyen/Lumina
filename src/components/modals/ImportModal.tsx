import { useEffect, useState } from "react";
import { call } from "../../api";
import { open } from "../../api/platform";
import { confirmDialog } from "../../confirm";
import { FolderInput, FolderOpen, HardDrive, Loader2, RefreshCw, MemoryStick, X } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { ImportOptions, ImportPattern, ImportPreview, ImportSource } from "../../types/lumina";
import { useSettings, updateSettings } from "../../settings";

const PATTERNS: { value: ImportPattern; label: string; example: string }[] = [
  { value: "year-month", label: "Year / month", example: "2025/2025-07/IMG_1234.JPG" },
  { value: "year-month-day", label: "Year / day", example: "2025/2025-07-14/IMG_1234.JPG" },
  { value: "flat", label: "One folder", example: "IMG_1234.JPG" },
];

const gb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-emerald-500 w-3.5 h-3.5" />
      <span>
        <span className="text-zinc-200">{label}</span>
        {hint && <span className="block text-[11.5px] text-zinc-500 mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

interface ImportModalProps {
  isOpen: boolean;
  initialSource: string;
  defaultDest: (source: string) => string;
  onClose: () => void;
  onImport: (options: ImportOptions) => void;
}

// Import from a memory card, USB drive or folder: where from, where to, how to sort into folders, and a
// preview of what will be copied before anything happens
export default function ImportModal({ isOpen, initialSource, defaultDest, onClose, onImport }: ImportModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  const settings = useSettings();
  const [drives, setDrives] = useState<ImportSource[]>([]);
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [deleteAfter, setDeleteAfter] = useState(false);
  const [ejectAfter, setEjectAfter] = useState(true);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "error">("idle");
  const [previewError, setPreviewError] = useState("");

  const loadDrives = () =>
    call<ImportSource[]>("list_import_sources")
      .then(setDrives)
      .catch(() => setDrives([]));

  useEffect(() => {
    if (!isOpen) return;
    setDeleteAfter(false);
    setPreview(null);
    loadDrives().then(() => {});
    setSource(initialSource);
    setDest(defaultDest(initialSource));
  }, [isOpen]);

  // A card found after opening the dialog becomes the source when none was chosen yet
  useEffect(() => {
    if (isOpen && !source) {
      const card = drives.find((d) => d.has_dcim) ?? drives[0];
      if (card) setSource(card.path);
    }
  }, [drives]);

  useEffect(() => {
    if (!isOpen || !source) return;
    let stale = false;
    setPreviewState("loading");
    setPreview(null);
    call<ImportPreview>("preview_import", { source, pattern: settings.importPattern })
      .then((p) => {
        if (stale) return;
        setPreview(p);
        setPreviewState("idle");
      })
      .catch((err) => {
        if (stale) return;
        setPreviewError(String(err));
        setPreviewState("error");
      });
    return () => {
      stale = true;
    };
  }, [isOpen, source, settings.importPattern]);

  if (!isOpen) return null;

  const drive = drives.find((d) => d.path === source);
  const toCopy = preview ? (settings.importSkipDuplicates ? preview.new_count : preview.photos + preview.videos) : 0;

  async function chooseFolder(kind: "source" | "dest") {
    const picked = await open({ directory: true, multiple: false, title: kind === "source" ? "Import from" : "Import into" });
    if (typeof picked !== "string") return;
    if (kind === "source") setSource(picked);
    else setDest(picked);
  }

  async function start() {
    if (!source || !dest || toCopy === 0) return;
    if (deleteAfter) {
      const ok = await confirmDialog(
        `After each photo is copied and checked, Lumina deletes it from ${drive ? `the card (${drive.label})` : source}.\n\nPhotos that were skipped or could not be copied stay where they are.`,
        { title: "Import and delete from the card?", kind: "danger", okLabel: "Import and delete", cancelLabel: "Cancel" }
      );
      if (!ok) return;
    }
    onImport({
      source,
      dest_root: dest,
      pattern: settings.importPattern,
      skip_duplicates: settings.importSkipDuplicates,
      delete_after: deleteAfter,
      eject_after: Boolean(drive) && ejectAfter,
    });
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-[9985] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Import photos"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        className="bg-raised border border-zinc-800 rounded-2xl shadow-2xl w-[min(720px,100%)] max-h-full flex flex-col text-xs"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-[15px] font-semibold text-zinc-100 flex items-center gap-2">
            <FolderInput className="w-4 h-4 text-emerald-400" />
            Import photos
          </h2>
          <button onClick={onClose} className="p-1 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
          {/* From */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-zinc-500">From</h3>
              <button onClick={loadDrives} className="flex items-center gap-1 text-zinc-500 hover:text-zinc-200">
                <RefreshCw className="w-3 h-3" /> Look for cards
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {drives.map((d) => (
                <button
                  key={d.path}
                  onClick={() => setSource(d.path)}
                  className={`flex items-center gap-3 p-3 rounded-xl border text-left transition ${
                    source === d.path ? "border-emerald-500/60 bg-emerald-500/10" : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700"
                  }`}
                >
                  <MemoryStick className={`w-5 h-5 shrink-0 ${source === d.path ? "text-emerald-300" : "text-zinc-400"}`} />
                  <span className="min-w-0">
                    <span className="block text-[13px] text-zinc-100 truncate">{d.label}</span>
                    <span className="block text-zinc-500">
                      {d.path.replace(/\\$/, "")}
                      {d.has_dcim ? " · camera card" : ""}
                    </span>
                  </span>
                </button>
              ))}
              <button
                onClick={() => chooseFolder("source")}
                className={`flex items-center gap-3 p-3 rounded-xl border text-left transition ${
                  source && !drive ? "border-emerald-500/60 bg-emerald-500/10" : "border-dashed border-zinc-700 hover:border-zinc-500"
                }`}
              >
                <FolderOpen className="w-5 h-5 shrink-0 text-zinc-400" />
                <span className="min-w-0">
                  <span className="block text-[13px] text-zinc-100">{source && !drive ? "Folder" : "A folder…"}</span>
                  <span className="block text-zinc-500 truncate">{source && !drive ? source : "Phone backup, download, old disk"}</span>
                </span>
              </button>
            </div>
            {drives.length === 0 && (
              <p className="text-zinc-500">
                No memory card found. Insert one (or connect a camera or phone that shows up as a drive), or pick a folder.
              </p>
            )}
          </section>

          {/* To */}
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-zinc-500">Into</h3>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-[11.5px] text-zinc-300 truncate">
                {dest || "Choose a folder"}
              </div>
              <button onClick={() => chooseFolder("dest")} className="px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200">
                Change…
              </button>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-zinc-400">Sort into</span>
              <div className="flex bg-zinc-950 border border-zinc-800 rounded-lg p-0.5">
                {PATTERNS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => updateSettings({ importPattern: p.value })}
                    className={`px-3 py-1 rounded-md transition ${
                      settings.importPattern === p.value ? "bg-emerald-500/20 text-emerald-300 font-semibold" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <span className="font-mono text-[11px] text-zinc-500">{PATTERNS.find((p) => p.value === settings.importPattern)?.example}</span>
            </div>
          </section>

          {/* Options */}
          <section className="flex flex-col gap-2.5">
            <h3 className="text-xs font-medium text-zinc-500">Options</h3>
            <Toggle
              checked={settings.importSkipDuplicates}
              onChange={(v) => updateSettings({ importSkipDuplicates: v })}
              label="Skip photos that are already in your library"
            />
            <Toggle
              checked={deleteAfter}
              onChange={setDeleteAfter}
              label={drive ? "Delete from the card after a checked copy" : "Delete the originals after a checked copy"}
              hint="Each copy is compared with the original before anything is deleted."
            />
            {drive && <Toggle checked={ejectAfter} onChange={setEjectAfter} label="Eject the card when done" />}
          </section>

          {/* Preview */}
          {source && (
            <section className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 flex flex-col gap-2">
              {previewState === "loading" && (
                <span className="flex items-center gap-2 text-zinc-400">
                  <Loader2 className="w-4 h-4 animate-spin" /> Reading {drive ? "the card" : "the folder"}…
                </span>
              )}
              {previewState === "error" && <span className="text-red-300">{previewError}</span>}
              {preview && (
                <>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <HardDrive className="w-4 h-4 text-emerald-400 self-center" />
                    <span className="text-[14px] font-semibold text-zinc-100">
                      {toCopy === 0
                        ? "Nothing new to import"
                        : `${toCopy.toLocaleString()} ${settings.importSkipDuplicates ? "new " : ""}${preview.videos > 0 ? "photos and videos" : toCopy === 1 ? "photo" : "photos"}`}
                    </span>
                    {toCopy > 0 && <span className="text-zinc-400">{gb(preview.new_bytes)}</span>}
                  </div>
                  <div className="text-zinc-400">
                    {preview.photos.toLocaleString()} photos{preview.videos > 0 ? ` and ${preview.videos} videos` : ""} found
                    {preview.duplicates > 0 && ` · ${preview.duplicates} duplicate${preview.duplicates === 1 ? "" : "s"} (already in your library or on the card twice)`}
                    {preview.first_date && preview.last_date && (
                      <> · taken {preview.first_date === preview.last_date ? fmtDay(preview.first_date) : `${fmtDay(preview.first_date)} – ${fmtDay(preview.last_date)}`}</>
                    )}
                  </div>
                  {settings.importPattern !== "flat" && preview.folders.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {preview.folders.slice(0, 8).map((f) => (
                        <span key={f} className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-zinc-300">
                          {f}
                        </span>
                      ))}
                      {preview.folders.length > 8 && <span className="text-zinc-500 self-center">+{preview.folders.length - 8} more</span>}
                    </div>
                  )}
                  {preview.videos > 0 && <span className="text-zinc-500">Videos are copied too; Lumina doesn't show them yet.</span>}
                </>
              )}
            </section>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-zinc-800">
          <button onClick={onClose} className="px-3.5 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
            Cancel
          </button>
          <button
            onClick={start}
            disabled={!source || !dest || !preview || toCopy === 0}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {toCopy > 0 ? `Import ${toCopy.toLocaleString()}` : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
