import { useEffect, useRef, useState } from "react";
import { Cloud, CloudCheck, Loader2 } from "lucide-react";
import { callLocal, mediaUrl } from "../../api";
import { useServers } from "../../hooks/useServers";
import { formatBytes } from "../../utils/photoHelpers";
import { Button, Page, Section, Switch, T, Toggle } from "./PhoneParts";
import { refreshBackup, setBackupSettings, showBackupServer, usePhoneBackup, type BackupProgress, type BackupStatus } from "./usePhoneBackup";
import { usePhoneFolders, type PhoneFolder } from "./usePhoneFolders";
import { freeUpScan, moveToTrash, type FreeUp } from "./freeUp";

// The phone app's Backup page (docs/plans/android-app-ui.md), opened from the header's backup button: how far it
// is, Back up now, when Android backs up by itself, and which of the phone's folders

// The header's backup button: a ring filling while it uploads, a check when everything chosen is on the server,
// an amber dot when some photos aren't yet
export function BackupRing({ onClick }: { onClick: () => void }) {
  const { status } = usePhoneBackup();
  const p = status?.progress;
  const fraction = p?.running && p.bytes_total > 0 ? p.bytes_done / p.bytes_total : null;
  const all = !!status && status.total > 0 && status.backed_up >= status.total;
  return (
    <button onClick={onClick} className="relative p-2.5 rounded-full text-zinc-300 active:bg-white/10" aria-label="Backup">
      {p?.running ? (
        <svg viewBox="0 0 24 24" className="w-6 h-6 -rotate-90">
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
          {fraction === null ? (
            <circle cx="12" cy="12" r="9.5" fill="none" stroke="#34d399" strokeWidth="2.5" strokeDasharray="15 60" className="origin-center animate-spin" />
          ) : (
            <circle cx="12" cy="12" r="9.5" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${fraction * 59.7} 60`} />
          )}
        </svg>
      ) : all ? (
        <CloudCheck className="w-5 h-5 text-emerald-400" />
      ) : (
        <>
          <Cloud className="w-5 h-5" />
          {status && status.total > status.backed_up && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-amber-400" />}
        </>
      )}
    </button>
  );
}

// Whether the phone is on Wi-Fi now, as far as the web view knows (Android's WebView says)
function onWifi(): boolean {
  const type = (navigator as Navigator & { connection?: { type?: string } }).connection?.type;
  return type === undefined || type === "wifi" || type === "ethernet";
}

// Over the bottom of the screen while a backup runs (or waits to): how far it is, and the Backup page on a tap. When one
// that sent photos ends, it says so for a moment, and `onFinished` lets the grid show them as backed up.
export function BackupBanner({ onOpen, onFinished }: { onOpen: () => void; onFinished: () => void }) {
  const { settings, status } = usePhoneBackup();
  const { servers } = useServers();
  const serverLabel = servers.find((s) => s.id === settings?.server)?.label ?? settings?.server ?? "the server";
  const [done, setDone] = useState<string | null>(null);
  // A pass that ended while the app looked (by its end time: a short one can start and end between two looks)
  const lastSeen = useRef<number | null>(null);
  const lastAt = status?.last?.at ?? 0;
  useEffect(() => {
    if (!status) return;
    if (lastSeen.current !== null && lastAt > lastSeen.current && status.last) {
      const { uploaded, failed } = status.last;
      if (uploaded > 0 || failed > 0) {
        setDone([uploaded > 0 ? `Backed up ${uploaded.toLocaleString()}` : "", failed > 0 ? `${failed} failed` : ""].filter(Boolean).join(" · "));
        window.setTimeout(() => setDone(null), 5000);
        if (uploaded > 0) onFinished();
      }
    }
    lastSeen.current = lastAt;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAt, !!status]);
  const p = status?.progress;
  if (!p) return null;
  let text: string | null = null;
  let fraction: number | null = null;
  if (p.running) {
    text = p.files > 0 ? `Backing up · ${(p.done + p.failed).toLocaleString()} of ${p.files.toLocaleString()}` : p.stage || "Backing up";
    fraction = p.bytes_total > 0 ? p.bytes_done / p.bytes_total : null;
  } else if (done) {
    text = done;
  } else if (status?.waiting) {
    // Android tries again after a failed attempt: say why it waits
    const why = status.last?.outcome ?? "";
    text = why.startsWith("retry:")
      ? `Can't reach ${serverLabel}; trying again`
      : why === "signed-out"
        ? `Signed out of ${serverLabel}: sign in again in Settings`
        : settings?.wifiOnly && !onWifi()
          ? "Backup waits for Wi-Fi"
          : "Backup starting…";
  }
  if (!text) return null;
  return (
    <button
      onClick={onOpen}
      className="absolute z-20 left-2 right-2 bottom-2 text-left px-3 py-2.5 rounded-xl bg-emerald-950/95 border border-emerald-700/50 shadow-xl backdrop-blur"
    >
      <div className="flex items-center gap-2 text-xs text-emerald-100">
        {p.running || (status?.waiting && !done) ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" /> : <CloudCheck className="w-3.5 h-3.5 text-emerald-400" />}
        <span className="flex-1 truncate">{text}</span>
        {p.running && p.bytes_total > 0 && (
          <span className="text-emerald-300/80">
            {formatBytes(p.bytes_done)} of {formatBytes(p.bytes_total)}
          </span>
        )}
      </div>
      {p.running && (
        <div className="mt-1.5 h-1 rounded-full bg-emerald-900/70 overflow-hidden">
          {fraction === null ? (
            <div className="h-full w-1/3 bg-emerald-400 animate-pulse" />
          ) : (
            <div className="h-full bg-emerald-400 transition-[width] duration-500" style={{ width: `${Math.round(fraction * 100)}%` }} />
          )}
        </div>
      )}
    </button>
  );
}

// `onRemoved`: photos left the phone (Free up space), so All photos shows them from the server now
export default function BackupScreen({ onBack, onRemoved }: { onBack: () => void; onRemoved: () => void }) {
  return (
    <Page title="Backup" onBack={onBack}>
      <BackupSection />
      <FreeUpSection onRemoved={onRemoved} />
      <FoldersSection />
    </Page>
  );
}

// Photos the server has can leave the phone: they stay on the server and in Lumina, and in the phone's trash for
// 30 days
function FreeUpSection({ onRemoved }: { onRemoved: () => void }) {
  const { settings } = usePhoneBackup();
  const { servers } = useServers();
  const server = settings?.server ?? null;
  const label = servers.find((s) => s.id === server)?.label ?? server ?? "";
  const [scan, setScan] = useState<FreeUp | null>(null);
  const [state, setState] = useState<"checking" | "ready" | "removing" | "error">("checking");
  const [message, setMessage] = useState<string | null>(null);
  const check = () => {
    if (!server) return;
    setState("checking");
    setMessage(null);
    freeUpScan(server)
      .then((s) => {
        setScan(s);
        setState("ready");
      })
      .catch((e) => {
        setMessage(String(e));
        setState("error");
      });
  };
  useEffect(check, [server]);
  if (!server) return null;
  const remove = async () => {
    if (!scan) return;
    setState("removing");
    try {
      const done = await moveToTrash(scan);
      if (done) {
        setMessage(`${scan.count.toLocaleString()} removed from this phone: they stay on ${label}, and in the phone's trash for 30 days.`);
        setScan(null);
        onRemoved();
        refreshBackup();
      }
      setState("ready");
    } catch (e) {
      setMessage(String(e));
      setState("error");
    }
  };
  return (
    <Section title="Free up space">
      {state === "checking" ? (
        <div className={`flex items-center gap-2 py-2 ${T.secondary}`}>
          <Loader2 className="w-4 h-4 animate-spin" />
          Asking {label} what it has…
        </div>
      ) : scan && scan.count > 0 ? (
        <>
          <div className={`py-1 ${T.body}`}>
            {scan.count.toLocaleString()} photos on this phone are backed up on {label} ({formatBytes(scan.bytes)}).
          </div>
          <div className={`pb-3 ${T.secondary}`}>Remove them from this phone? They stay on {label}, and in Lumina.</div>
          <div className="flex">
            <Button wide onClick={() => void remove()} disabled={state === "removing"}>
              {state === "removing" ? "Waiting for Android…" : "Remove from this phone"}
            </Button>
          </div>
        </>
      ) : (
        <div className={`py-2 ${T.secondary}`}>{message ?? `Nothing to remove: no photo on this phone is backed up on ${label} yet.`}</div>
      )}
      {message && scan && <div className={`pt-2 ${T.secondary}`}>{message}</div>}
      {state === "error" && (
        <div className="-ml-4">
          <Button kind="text" onClick={check}>
            Try again
          </Button>
        </div>
      )}
    </Section>
  );
}

function BackupSection() {
  const { servers } = useServers();
  const signedIn = servers.filter((s) => s.signed_in);
  const { settings, status, error: statusError } = usePhoneBackup();
  const [anyNetwork, setAnyNetwork] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const server = settings?.server ?? signedIn[0]?.id ?? null;
  useEffect(() => showBackupServer(server), [server]);
  const serverLabel = servers.find((s) => s.id === server)?.label ?? server ?? "";

  if (!settings) return <Section title="">{error ?? statusError ?? <div className={`py-2 ${T.secondary}`}>Loading…</div>}</Section>;
  if (!server) {
    return (
      <Section title="">
        <div className={`py-2 ${T.secondary}`}>Sign in to a server in Settings: the phone backs up to it.</div>
      </Section>
    );
  }
  const change = async (next: Partial<typeof settings>) => {
    const updated = { ...settings, server, ...next };
    setBackupSettings(updated);
    try {
      await callLocal("set_phone_backup", { settings: updated });
    } catch (e) {
      setError(String(e));
    }
  };
  const backUpNow = async () => {
    setError(null);
    try {
      // The worker backs up to the server the settings name (also with the automatic backup off)
      if (settings.server !== server) await change({});
      await callLocal("phone_backup_now", { anyNetwork });
      window.setTimeout(refreshBackup, 800);
    } catch (e) {
      setError(String(e));
    }
  };
  const p = status?.progress;
  return (
    <Section title="">
      <Toggle label={`Back up this phone to ${serverLabel}`} on={settings.enabled} onChange={(enabled) => change({ enabled })} />
      {signedIn.length > 1 && (
        <label className={`flex items-center justify-between min-h-11 py-2 ${T.body}`}>
          Server
          <select value={server} onChange={(e) => change({ server: e.target.value })} className="min-h-11 rounded-full bg-zinc-800 px-4 text-[15px] text-zinc-100 outline-none">
            {signedIn.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* Every backup, also Back up now */}
      <Toggle label="Videos too" on={settings.videos} onChange={(videos) => change({ videos })} />
      {/* Only when the phone backs up by itself */}
      <Toggle label="Only on Wi-Fi" on={settings.wifiOnly} onChange={(wifiOnly) => change({ wifiOnly })} disabled={!settings.enabled} />
      <Toggle label="Only while charging" on={settings.charging} onChange={(charging) => change({ charging })} disabled={!settings.enabled} />

      <div className={`pt-3 pb-2 ${T.secondary}`}>
        {p?.running ? (
          <Running p={p} />
        ) : status ? (
          <>
            <div className={T.body}>
              {status.backed_up.toLocaleString()} of {status.total.toLocaleString()} backed up
            </div>
            {status.last ? <div>Last backup {when(status.last.at)}</div> : <div>Not backed up yet</div>}
            {status.last && <LastOutcome last={status.last} label={serverLabel} />}
          </>
        ) : statusError ? (
          <div className="text-red-300">Couldn't count the photos on this phone: {statusError}</div>
        ) : (
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Counting the photos on this phone…
          </div>
        )}
      </div>
      {error && <div className="pb-2 text-[13px] text-red-300">{error}</div>}
      <div className="flex">
        {p?.running ? (
          <Button wide onClick={() => void callLocal("phone_backup_stop")}>
            Stop
          </Button>
        ) : (
          <Button wide kind="primary" onClick={() => void backUpNow()}>
            Back up now
          </Button>
        )}
      </div>
      {settings.wifiOnly && !p?.running && <Toggle label="This time also on mobile data" on={anyNetwork} onChange={setAnyNetwork} />}
      {p && p.failures.length > 0 && !p.running && (
        <details className={`pt-2 ${T.secondary}`}>
          <summary className="text-amber-300">{p.failures.length} couldn't be backed up</summary>
          {p.failures.map(([name, why]) => (
            <div key={name} className="pt-1">
              {name}: {why}
            </div>
          ))}
        </details>
      )}
    </Section>
  );
}

// Which of the phone's folders are backed up (the camera's by default)
function FoldersSection() {
  const { settings, status } = usePhoneBackup();
  const folders = usePhoneFolders(settings?.server ?? null, status?.backed_up);
  if (!settings?.server) return null;
  const toggleFolder = (folder: string, on: boolean) => {
    const set = new Set(settings.folders);
    if (on) set.add(folder);
    else set.delete(folder);
    const updated = { ...settings, folders: [...set] };
    setBackupSettings(updated);
    void callLocal("set_phone_backup", { settings: updated }).catch(() => {});
  };
  return (
    <Section title="Folders">
      {folders === null ? (
        <div className={`py-2 ${T.secondary}`}>Loading…</div>
      ) : (
        orderFolders(folders, settings.folders).map((f) => (
          <FolderRow key={f.folder} folder={f} on={settings.folders.includes(f.folder)} onChange={(on) => toggleFolder(f.folder, on)} />
        ))
      )}
    </Section>
  );
}

// The ones backed up first, then the biggest
export function orderFolders(folders: PhoneFolder[], chosen: string[]): PhoneFolder[] {
  return [...folders].sort((a, b) => Number(chosen.includes(b.folder)) - Number(chosen.includes(a.folder)) || b.count - a.count);
}

function FolderRow({ folder, on, onChange }: { folder: PhoneFolder; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className="w-full min-h-11 flex items-center gap-3 py-2 text-left">
      <img src={mediaUrl({ kind: "thumb", hash: "", path: folder.cover })} alt="" className="w-10 h-10 rounded-lg object-cover bg-zinc-800 shrink-0" />
      <span className="flex-1 min-w-0">
        <span className={`block truncate ${T.body}`}>{folder.name}</span>
        <span className={`block ${T.secondary}`}>
          {folder.count.toLocaleString()} {folder.count === 1 ? "photo" : "photos"} · {folder.backed_up >= folder.count ? "all backed up" : `${folder.backed_up.toLocaleString()} backed up`}
        </span>
      </span>
      <Switch on={on} />
    </button>
  );
}

function Running({ p }: { p: BackupProgress }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-zinc-300">
        <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
        {p.stage}
        {p.files > 0 && ` · ${(p.done + p.failed).toLocaleString()} of ${p.files.toLocaleString()}`}
      </div>
      {p.bytes_total > 0 && (
        <>
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${Math.round((p.bytes_done / p.bytes_total) * 100)}%` }} />
          </div>
          <div>
            {formatBytes(p.bytes_done)} of {formatBytes(p.bytes_total)}
          </div>
        </>
      )}
    </div>
  );
}

function LastOutcome({ last, label }: { last: NonNullable<BackupStatus["last"]>; label: string }) {
  const parts = [last.uploaded > 0 ? `${last.uploaded} uploaded` : "", last.failed > 0 ? `${last.failed} failed` : ""].filter(Boolean);
  const why = last.outcome.startsWith("retry:")
    ? `Couldn't reach ${label}; Android tries again later`
    : last.outcome === "signed-out"
      ? `Signed out of ${label}: sign in again`
      : last.outcome.startsWith("error:")
        ? last.outcome.slice(7)
        : "";
  if (parts.length === 0 && !why) return null;
  return <div className={why ? "text-amber-300" : ""}>{[parts.join(", "), why].filter(Boolean).join(" · ")}</div>;
}

function when(seconds: number): string {
  const d = new Date(seconds * 1000);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return today ? `today ${time}` : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
