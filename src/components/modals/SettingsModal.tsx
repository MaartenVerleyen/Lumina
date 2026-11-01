import { useEffect, useState, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { confirmDialog } from "../../confirm";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Brain,
  FolderOpen,
  Info,
  LayoutGrid,
  RefreshCw,
  ScanFace,
  Search,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import type { LibraryState } from "../../hooks/useLibraryState";
import { OllamaStatus } from "../../types/lumina";
import { UNKNOWN_FACES } from "./FaceMatchReviewModal";
import luminaMark from "../../assets/lumina-mark.svg";
import { useSettings, updateSettings } from "../../settings";
import type { Updater } from "../../hooks/useUpdater";
import { defaultBackupDir } from "../../hooks/library/useBackup";

export type SettingsSection = "general" | "library" | "ai" | "faces" | "search" | "updates" | "about";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Info }[] = [
  { id: "general", label: "General", icon: LayoutGrid },
  { id: "library", label: "Library", icon: FolderOpen },
  { id: "ai", label: "AI captions", icon: Brain },
  { id: "faces", label: "Faces", icon: ScanFace },
  { id: "search", label: "Smart search", icon: Search },
  { id: "updates", label: "Updates", icon: RefreshCw },
  { id: "about", label: "About", icon: Info },
];

const REPO_URL = "https://github.com/MaartenVerleyen/Lumina";

// ---------- small building blocks ----------

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 px-1 mb-1">{title}</h3>
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 divide-y divide-zinc-800/80">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <div className="text-[13px] text-zinc-100">{label}</div>
        {hint && <div className="text-[12px] text-zinc-500 mt-0.5 leading-snug">{hint}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex bg-zinc-950 border border-zinc-800 rounded-lg p-0.5 text-[12px]">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`px-3 py-1 rounded-md transition ${
            value === o.value ? "bg-emerald-500/20 text-emerald-300 font-semibold" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition ${checked ? "bg-emerald-500" : "bg-zinc-700"}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

function Button({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded-lg text-[12px] font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed ${
        primary
          ? "bg-emerald-600 hover:bg-emerald-500 border-emerald-500 text-white"
          : "bg-zinc-900 hover:bg-zinc-800 border-zinc-700 text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={`flex items-center gap-1.5 text-[12px] ${ok ? "text-emerald-300" : "text-zinc-400"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-zinc-600"}`} />
      {children}
    </span>
  );
}

// Playable copies of videos the app converted (MTS, AVI, ...): how much room they take, and a way to free it
function VideoCacheRow() {
  const [info, setInfo] = useState<{ bytes: number; files: number; ffmpeg_installed: boolean } | null>(null);
  const load = () => invoke<{ bytes: number; files: number; ffmpeg_installed: boolean }>("video_cache_info").then(setInfo).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  const size = info ? (info.bytes >= 1024 ** 3 ? `${(info.bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(info.bytes / 1024 ** 2)} MB`) : "";
  return (
    <Row
      label="Playable copies"
      hint={
        info
          ? `${info.files} converted video${info.files === 1 ? "" : "s"} (${size}, at most 10 GB; the oldest go first). ${
              info.ffmpeg_installed ? "ffmpeg is installed." : "ffmpeg is downloaded the first time a copy is needed."
            }`
          : "Videos in formats Lumina can't play are converted on request."
      }
    >
      <Button disabled={!info || info.files === 0} onClick={() => invoke("clear_video_cache").then(load).catch(() => {})}>
        Clear
      </Button>
    </Row>
  );
}

// ---------- the dialog ----------

interface SettingsModalProps {
  isOpen: boolean;
  initialSection?: SettingsSection;
  onClose: () => void;
  lib: LibraryState;
  onOpenWelcomeTour: () => void;
  updater: Updater;
}

// One place for every setting and maintenance action, grouped by area (Ctrl+, or the Simple / Studio menu)
export default function SettingsModal({
  isOpen,
  initialSection = "general",
  onClose,
  lib,
  onOpenWelcomeTour,
  updater,
}: SettingsModalProps) {
  const settings = useSettings();
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [version, setVersion] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [flash, setFlash] = useState<{ on: boolean; canEnable: boolean } | null>(null);
  const [aiBusy, setAiBusy] = useState<"" | "starting" | "flash">("");
  const [backupDefault, setBackupDefault] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setSection(initialSection);
    getVersion().then(setVersion).catch(() => {});
    invoke<string>("get_app_data_dir").then(setDataDir).catch(() => {});
    defaultBackupDir().then(setBackupDefault).catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || section !== "ai") return;
    invoke<{ flash_attention: string | null; can_enable: boolean }>("ollama_tuning_status")
      .then((s) => setFlash({ on: ["1", "true"].includes((s.flash_attention || "").toLowerCase()), canEnable: s.can_enable }))
      .catch(() => setFlash(null));
  }, [isOpen, section]);

  if (!isOpen) return null;

  const ollama = lib.ollamaStatus;
  const models = ollama?.installed_models ?? [];
  const semantic = lib.semanticStatus;
  const hasPhotos = lib.photos.length > 0;
  const pending = Object.values(lib.pendingFaceCounts).reduce((a, b) => a + b, 0);
  const backupDir = settings.backupDir || backupDefault;
  const lastBackup = settings.lastBackupAt
    ? new Date(settings.lastBackupAt).toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

  async function startOllama() {
    setAiBusy("starting");
    try {
      await invoke("start_ollama_service");
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 800));
        const s = await invoke<OllamaStatus>("check_ollama_status").catch(() => null);
        if (s?.running) {
          lib.setOllamaStatus(s);
          break;
        }
      }
    } catch (err) {
      lib.setError(String(err));
    } finally {
      setAiBusy("");
    }
  }

  async function enableFlash() {
    const ok = await confirmDialog(
      "Ollama runs about 10–15% faster with flash attention, with the same results.\n\nLumina saves OLLAMA_FLASH_ATTENTION=1 in your Windows user settings and restarts Ollama. Anything else using Ollama pauses for a few seconds.",
      { title: "Faster captions", kind: "info", okLabel: "Turn on and restart Ollama", cancelLabel: "Not now" }
    );
    if (!ok) return;
    setAiBusy("flash");
    try {
      await invoke("enable_ollama_flash_attention");
      setFlash((f) => (f ? { ...f, on: true } : f));
      lib.setOllamaStatus(await invoke<OllamaStatus>("check_ollama_status"));
    } catch (err) {
      lib.setError(String(err));
    } finally {
      setAiBusy("");
    }
  }

  // Actions that open another dialog close Settings first
  const then = (action: () => void) => () => {
    onClose();
    action();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[9985] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="bg-raised border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex w-[min(900px,100%)] h-[min(620px,100%)]"
      >
        {/* Sections */}
        <nav className="w-52 shrink-0 bg-panel border-r border-zinc-800 p-3 flex flex-col gap-0.5">
          <div className="flex items-center gap-2 px-2.5 pt-1 pb-4 text-sm font-semibold text-zinc-100">
            <SettingsIcon className="w-4 h-4 text-emerald-400" />
            Settings
          </div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              aria-current={section === s.id ? "page" : undefined}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-left transition ${
                section === s.id ? "bg-emerald-500/10 text-emerald-200" : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60"
              }`}
            >
              <s.icon className="w-4 h-4 shrink-0" />
              {s.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
            <h2 className="text-[15px] font-semibold text-zinc-100">{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <button onClick={onClose} className="p-1 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div key={section} className="lumina-tour-enter flex-1 overflow-y-auto p-6 flex flex-col gap-6">
            {section === "general" && (
              <>
                <Group title="Appearance">
                  <Row label="Interface" hint="Simple hides the more technical tools; Studio shows everything.">
                    <Segmented
                      value={lib.simpleMode ? "simple" : "studio"}
                      options={[
                        { value: "simple", label: "Simple" },
                        { value: "studio", label: "Studio" },
                      ]}
                      onChange={(v) => (v === "simple") !== lib.simpleMode && lib.toggleSimpleMode()}
                    />
                  </Row>
                  <Row label="Grid" hint="Justified keeps every photo's shape; square lines them up in a neat grid.">
                    <Segmented
                      value={lib.gridStyle}
                      options={[
                        { value: "justified", label: "Justified" },
                        { value: "square", label: "Square" },
                      ]}
                      onChange={lib.setGridStyle}
                    />
                  </Row>
                  <Row label="Photo details on cards" hint="Tags, place and sharpness on each photo in the grid.">
                    <Segmented
                      value={lib.cardDetails}
                      options={[
                        { value: "hover", label: "On hover" },
                        { value: "always", label: "Always" },
                      ]}
                      onChange={lib.setCardDetails}
                    />
                  </Row>
                </Group>
                <Group title="Culling">
                  <Row label="Move to the next photo after a choice" hint="After P, X or a star rating the next photo is selected.">
                    <Switch checked={lib.autoAdvance} onChange={lib.setAutoAdvance} label="Auto-advance" />
                  </Row>
                  <Row
                    label="Warn about closed eyes"
                    hint="Marks photos where someone blinks. Uses the smart search models; High also catches half-closed eyes, with a few more false alarms."
                  >
                    <Segmented
                      value={settings.eyesCheck}
                      options={[
                        { value: "off", label: "Off" },
                        { value: "normal", label: "Normal" },
                        { value: "high", label: "High" },
                      ]}
                      onChange={(v) => updateSettings({ eyesCheck: v })}
                    />
                  </Row>
                  <Row label="Warn about soft focus" hint="Marks photos whose main face is not sharp, even when the background is. High also catches slight softness.">
                    <Segmented
                      value={settings.focusCheck}
                      options={[
                        { value: "off", label: "Off" },
                        { value: "normal", label: "Normal" },
                        { value: "high", label: "High" },
                      ]}
                      onChange={(v) => updateSettings({ focusCheck: v })}
                    />
                  </Row>
                  <Row label="Check this library now" hint="Measures eyes and focus for faces found earlier. New face scans do it by themselves.">
                    <Button disabled={!hasPhotos || Boolean(lib.faceQualityProgress)} onClick={() => lib.measureFaceQuality()}>
                      {lib.faceQualityProgress ? "Checking…" : "Check"}
                    </Button>
                  </Row>
                </Group>
                <Group title="Photos tab">
                  <Row label="On this day" hint="Photos taken on today's date in earlier years, above the grid.">
                    <Switch checked={settings.onThisDay} onChange={(v) => updateSettings({ onThisDay: v })} label="On this day" />
                  </Row>
                  <Row label="Live Photo clips" hint="Show the short clip of each Live Photo as a video of its own. Normally it plays from its photo.">
                    <Switch checked={settings.showLiveClips} onChange={(v) => updateSettings({ showLiveClips: v })} label="Live Photo clips" />
                  </Row>
                </Group>
                <Group title="Help">
                  <Row label="Welcome tour" hint="The short introduction from the first start.">
                    <Button onClick={then(onOpenWelcomeTour)}>Show tour</Button>
                  </Row>
                  <Row label="Keyboard shortcuts" hint="Press ? anywhere.">
                    <Button onClick={then(() => lib.setIsShortcutsModalOpen(true))}>Show shortcuts</Button>
                  </Row>
                </Group>
              </>
            )}

            {section === "library" && (
              <>
                <Group title="Open library">
                  <Row label={lib.folder ? lib.folder.split(/[\\/]/).pop() || lib.folder : "No library open"} hint={lib.folder || "Open a folder of photos to start."}>
                    {lib.folder && <Button onClick={() => lib.handleRevealInFileManager(lib.folder)}>Show in Explorer</Button>}
                    <Button primary onClick={then(lib.handleOpenFolder)}>
                      {lib.folder ? "Open another…" : "Open folder…"}
                    </Button>
                  </Row>
                  {hasPhotos && (
                    <Row label="Photos" hint={`${lib.photos.length.toLocaleString()} photos · ${lib.stagedPhotos.length} staged change(s)`} />
                  )}
                </Group>
                <Group title="Import and changes">
                  <Row label="Import photos" hint="From a memory card, USB drive or folder, sorted into dated folders.">
                    <Button primary disabled={Boolean(lib.importProgress)} onClick={then(() => lib.openImport())}>
                      Import…
                    </Button>
                  </Row>
                  <Row label="Offer to import when a camera card is connected" hint="Cards and drives with a DCIM folder.">
                    <Switch
                      checked={settings.offerImportOnCard}
                      onChange={(v) => updateSettings({ offerImportOnCard: v })}
                      label="Offer to import"
                    />
                  </Row>
                  <Row label="Pick up changes made outside Lumina" hint="Photos added, changed or removed in Explorer or by a sync app show up by themselves.">
                    <Switch checked={settings.watchLibrary} onChange={(v) => updateSettings({ watchLibrary: v })} label="Watch the library folder" />
                  </Row>
                </Group>
                <Group title="Backup and restore">
                  <Row
                    label="Back up the library"
                    hint={`Ratings, flags, people, captions, albums and settings: not the photos themselves. ${lastBackup ? `Last backup: ${lastBackup}.` : "No backup yet."}`}
                  >
                    <Button primary disabled={lib.backupBusy !== null} onClick={() => lib.backupNow()}>
                      {lib.backupBusy === "backup" ? "Backing up…" : "Back up now"}
                    </Button>
                  </Row>
                  <Row label="Backup folder" hint={<span className="font-mono text-[11.5px] break-all">{backupDir || "…"}</span>}>
                    {backupDir && <Button onClick={() => lib.handleRevealInFileManager(backupDir)}>Show</Button>}
                    <Button
                      onClick={async () => {
                        const picked = await openDialog({ directory: true, multiple: false, defaultPath: backupDir || undefined });
                        if (typeof picked === "string") updateSettings({ backupDir: picked });
                      }}
                    >
                      Change…
                    </Button>
                  </Row>
                  <Row label="Back up automatically" hint="In the background while Lumina is open. The newest 5 automatic backups are kept.">
                    <Segmented
                      value={settings.autoBackup}
                      options={[
                        { value: "off", label: "Off" },
                        { value: "daily", label: "Daily" },
                        { value: "weekly", label: "Weekly" },
                      ]}
                      onChange={(v) => updateSettings({ autoBackup: v })}
                    />
                  </Row>
                  <Row label="Restore from a backup" hint="Also for moving Lumina to a new PC: you point each library folder to where the photos are now.">
                    <Button disabled={lib.backupBusy !== null} onClick={then(lib.chooseBackupToRestore)}>
                      Restore…
                    </Button>
                  </Row>
                  <Row label="Export as a spreadsheet" hint="Ratings, flags, labels, tags, people and captions of the open library, as a CSV file.">
                    <Button disabled={!hasPhotos || lib.backupBusy !== null} onClick={lib.exportCsv}>
                      Export CSV…
                    </Button>
                  </Row>
                </Group>
                <Group title="Maintenance">
                  <Row label="Quick rescan" hint="Picks up photos added, changed or removed outside Lumina.">
                    <Button disabled={!hasPhotos || lib.isScanningFolder} onClick={then(lib.handleRescanFolder)}>
                      Rescan
                    </Button>
                  </Row>
                  <Row label="Rebuild thumbnails" hint="Reads every file again: thumbnails, similar shots and focus scores. Ratings, names and captions are kept.">
                    <Button disabled={!hasPhotos || lib.isScanningFolder} onClick={then(lib.handleRescanAndProcessFolder)}>
                      Rebuild
                    </Button>
                  </Row>
                  <Row label="Library health and XMP" hint="Cache size, and ratings and labels as XMP sidecars for Lightroom.">
                    <Button disabled={!hasPhotos} onClick={then(lib.handleOpenHealthDashboard)}>
                      Open
                    </Button>
                  </Row>
                  <Row label="Clean up the cache" hint="Removes thumbnails and previews of photos that no longer exist.">
                    <Button onClick={lib.handlePruneCache}>Clean up</Button>
                  </Row>
                </Group>
                <Group title="Videos">
                  <VideoCacheRow />
                </Group>
              </>
            )}

            {section === "ai" && (
              <>
                <Group title="Ollama">
                  <Row
                    label="Status"
                    hint="Captions, tags and text in photos are written by a vision model running in Ollama on this PC."
                  >
                    <Status ok={Boolean(ollama?.running)}>{ollama?.running ? "Running" : "Not running"}</Status>
                    {!ollama?.running && (
                      <Button primary disabled={aiBusy !== ""} onClick={startOllama}>
                        {aiBusy === "starting" ? "Starting…" : "Start Ollama"}
                      </Button>
                    )}
                  </Row>
                  <Row label="Vision model" hint={models.length === 0 ? "No model installed yet (qwen3-vl:8b is about 6 GB)." : "Used for Batch AI and the A key."}>
                    {models.length > 0 ? (
                      <select
                        value={lib.aiModel}
                        onChange={(e) => lib.setAiModel(e.target.value)}
                        className="bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1.5 text-[12px] text-zinc-200 focus:outline-none focus:border-emerald-500"
                      >
                        {models.map((m) => (
                          <option key={m.name} value={m.name}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Button primary disabled={!ollama?.running || Boolean(lib.ollamaPullProgress)} onClick={then(() => lib.handlePullDefaultAiModel())}>
                        Download qwen3-vl:8b
                      </Button>
                    )}
                  </Row>
                  <Row label="Faster captions" hint="Ollama's flash attention: about 10–15% faster, same results.">
                    {flash === null ? (
                      <Status ok={false}>Unknown</Status>
                    ) : flash.on ? (
                      <Status ok>On</Status>
                    ) : (
                      <Button disabled={!flash.canEnable || aiBusy !== "" || Boolean(lib.aiBatchProgress)} onClick={enableFlash}>
                        {aiBusy === "flash" ? "Restarting Ollama…" : "Turn on"}
                      </Button>
                    )}
                  </Row>
                </Group>
              </>
            )}

            {section === "faces" && (
              <>
                <Group title="Face recognition">
                  <Row label="People" hint={`${lib.people.length} named · ${pending} suggestion(s) to review`}>
                    <Button disabled={!hasPhotos} onClick={then(() => lib.setFaceReviewPerson(UNKNOWN_FACES))}>
                      Who is this?
                    </Button>
                    <Button
                      disabled={!hasPhotos}
                      onClick={then(() =>
                        lib.setFaceReviewPerson(
                          lib.people.find((p) => (lib.pendingFaceCounts[p.name] || 0) > 0)?.name || UNKNOWN_FACES
                        )
                      )}
                    >
                      Review matches
                    </Button>
                  </Row>
                  <Row label="Scan this library for faces" hint="Finds faces in every photo; names you gave are kept. Runs on the graphics card when it can.">
                    {lib.faceScanProgress ? (
                      <Button onClick={lib.handleCancelFaceScan}>Stop scan</Button>
                    ) : (
                      <Button primary disabled={!hasPhotos} onClick={then(lib.handleBatchScanFacesOnnx)}>
                        Scan faces
                      </Button>
                    )}
                  </Row>
                </Group>
              </>
            )}

            {section === "search" && (
              <>
                <Group title="Smart search">
                  <Row label="Smart search" hint="Find photos by describing them, in about 50 languages. The models (about 470 MB) download the first time.">
                    <Switch checked={lib.smartSearch} onChange={() => lib.toggleSmartSearch()} label="Smart search" />
                  </Row>
                  <Row
                    label="Index"
                    hint={
                      semantic
                        ? semantic.models_ready
                          ? `${semantic.indexed.toLocaleString()} of ${semantic.total.toLocaleString()} photos indexed`
                          : "The models are not downloaded yet."
                        : "Open a library to see its index."
                    }
                  >
                    {lib.semanticProgress ? (
                      <Button onClick={lib.handleCancelSemanticIndex}>Stop</Button>
                    ) : (
                      <Button
                        disabled={!hasPhotos || !semantic?.models_ready || semantic.indexed >= semantic.total}
                        onClick={() => lib.startSemanticIndex()}
                      >
                        Index now
                      </Button>
                    )}
                  </Row>
                </Group>
              </>
            )}

            {section === "updates" && (
              <>
                <Group title="Updates">
                  <Row label="Check for updates automatically" hint="Once a day, a little after Lumina starts. Nothing is installed without your OK.">
                    <Switch
                      checked={settings.checkForUpdates}
                      onChange={(v) => updateSettings({ checkForUpdates: v })}
                      label="Check for updates automatically"
                    />
                  </Row>
                  <Row
                    label={`Lumina ${version}`}
                    hint={
                      updater.state.kind === "checking"
                        ? "Checking…"
                        : updater.state.kind === "latest"
                        ? "You have the latest version."
                        : updater.state.kind === "available"
                        ? `Lumina ${updater.state.update.version} is available.`
                        : updater.state.kind === "downloading" || updater.state.kind === "installing"
                        ? `Updating to ${updater.state.update.version}…`
                        : updater.state.kind === "error"
                        ? `Could not check for updates: ${updater.state.message}`
                        : "Updates come from the Lumina releases on GitHub."
                    }
                  >
                    {updater.state.kind === "available" ? (
                      <Button primary onClick={updater.install}>
                        Update now
                      </Button>
                    ) : (
                      <Button
                        disabled={["checking", "downloading", "installing"].includes(updater.state.kind)}
                        onClick={updater.checkNow}
                      >
                        Check now
                      </Button>
                    )}
                  </Row>
                </Group>
              </>
            )}

            {section === "about" && (
              <>
                <div className="flex items-center gap-4 px-1">
                  <img src={luminaMark} alt="" className="w-12 h-12" draggable={false} />
                  <div>
                    <div className="text-lg font-semibold text-zinc-100">Lumina {version}</div>
                    <div className="text-[12px] text-zinc-500">Sort, search and cull your photo library on your own PC.</div>
                  </div>
                </div>
                <Group title="Your data">
                  <Row label="Library data" hint={dataDir || "…"}>
                    <Button disabled={!dataDir} onClick={() => lib.handleRevealInFileManager(dataDir)}>
                      Open folder
                    </Button>
                  </Row>
                  <Row label="Privacy" hint="Everything runs on this PC. Photos, names and captions are never uploaded." />
                </Group>
                <Group title="Open source">
                  <Row label="Source code and issues" hint={REPO_URL.replace("https://", "")}>
                    <Button onClick={() => openUrl(REPO_URL).catch(() => {})}>Open GitHub</Button>
                  </Row>
                  <Row
                    label="Face models"
                    hint="InsightFace buffalo_l (SCRFD, ArcFace): free for non-commercial use only."
                  />
                  <Row label="Smart search models" hint="CLIP ViT-B/32 and its multilingual text encoder: MIT and Apache 2.0. Also used to spot closed eyes." />
                  <Row label="Captions" hint="Ollama (MIT) with the model you choose; qwen3-vl is Apache 2.0." />
                  <Row label="Place names" hint="GeoNames data, CC BY 4.0. Map tiles © OpenStreetMap contributors." />
                </Group>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
