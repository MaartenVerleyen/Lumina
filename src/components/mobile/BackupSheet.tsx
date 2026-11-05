import { useEffect, useState } from "react";
import { CloudUpload, Loader2 } from "lucide-react";
import { callLocal } from "../../api";
import { useServers } from "../../hooks/useServers";
import { formatBytes } from "../../utils/photoHelpers";

// The phone app's Backup (docs/plans/android.md, milestone 3): the phone's photos to a server, by Android in the
// background (Backup.kt) whenever the conditions hold, or now. The work itself is phone_backup.rs.

interface Settings {
  enabled: boolean;
  server: string | null;
  wifiOnly: boolean;
  charging: boolean;
  videos: boolean;
}

interface Progress {
  running: boolean;
  stage: string;
  files: number;
  done: number;
  failed: number;
  bytes_total: number;
  bytes_done: number;
  failures: [string, string][];
}

interface Status {
  progress: Progress;
  last: { at: number; uploaded: number; failed: number; outcome: string } | null;
  backed_up: number;
  total: number;
}

export function BackupButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="p-2.5 rounded-full text-zinc-300 active:bg-white/10" aria-label="Backup">
        <CloudUpload className="w-5 h-5" />
      </button>
      {open && <BackupSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function BackupSheet({ onClose }: { onClose: () => void }) {
  const { servers } = useServers();
  const signedIn = servers.filter((s) => s.signed_in);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [anyNetwork, setAnyNetwork] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const server = settings?.server ?? signedIn[0]?.id ?? null;
  const serverLabel = servers.find((s) => s.id === server)?.label ?? server;

  useEffect(() => {
    callLocal<Settings>("phone_backup_settings")
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  // How far it is, every second while the sheet is open
  useEffect(() => {
    if (!server || !settings) return;
    let stop = false;
    const tick = () =>
      callLocal<Status>("phone_backup_status", { server, videos: settings.videos })
        .then((s) => !stop && setStatus(s))
        .catch(() => {});
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [server, settings]);

  const change = async (next: Partial<Settings>) => {
    if (!settings) return;
    const updated = { ...settings, server, ...next };
    setSettings(updated);
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
      if (settings && settings.server !== server) await change({});
      await callLocal("phone_backup_now", { anyNetwork });
    } catch (e) {
      setError(String(e));
    }
  };

  const p = status?.progress;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex flex-col justify-end" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-t-2xl bg-raised border-t border-zinc-700/80 px-4 pt-4 flex flex-col gap-1"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
      >
        <div className="px-1 pb-2 font-semibold text-zinc-100">Backup</div>
        {!settings ? (
          <div className="px-1 py-4 text-sm text-zinc-400">{error ?? "Loading…"}</div>
        ) : !server ? (
          <div className="px-1 py-4 text-sm text-zinc-400">Sign in to a server first: the phone backs up to it.</div>
        ) : (
          <>
            <Toggle label={`Back up this phone to ${serverLabel}`} on={settings.enabled} onChange={(enabled) => change({ enabled })} />
            {signedIn.length > 1 && (
              <label className="flex items-center justify-between px-1 py-2 text-sm text-zinc-300">
                Server
                <select
                  value={server}
                  onChange={(e) => change({ server: e.target.value })}
                  className="bg-zinc-800 rounded-lg px-2 py-1 text-zinc-100"
                >
                  {signedIn.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className={settings.enabled ? "" : "opacity-50 pointer-events-none"}>
              <Toggle label="Only on Wi-Fi" on={settings.wifiOnly} onChange={(wifiOnly) => change({ wifiOnly })} />
              <Toggle label="Only while charging" on={settings.charging} onChange={(charging) => change({ charging })} />
            </div>
            <Toggle label="Videos too" on={settings.videos} onChange={(videos) => change({ videos })} />

            <div className="px-1 pt-3 pb-1 text-xs text-zinc-400 min-h-[3rem]">
              {p?.running ? (
                <Running p={p} />
              ) : status ? (
                <>
                  <div>
                    {status.backed_up.toLocaleString()} of {status.total.toLocaleString()} backed up
                    {status.last ? ` · last backup ${when(status.last.at)}` : ""}
                  </div>
                  {status.last && <LastOutcome last={status.last} label={serverLabel ?? ""} />}
                </>
              ) : null}
            </div>
            {error && <div className="px-1 text-xs text-red-300">{error}</div>}

            <div className="flex items-center gap-3 pt-2">
              {p?.running ? (
                <button onClick={() => callLocal("phone_backup_stop")} className="flex-1 py-3 rounded-full bg-zinc-800 text-sm font-semibold text-zinc-100">
                  Stop
                </button>
              ) : (
                <button onClick={backUpNow} className="flex-1 py-3 rounded-full bg-emerald-600 text-sm font-semibold text-white active:bg-emerald-700">
                  Back up now
                </button>
              )}
            </div>
            {settings.wifiOnly && !p?.running && (
              <label className="flex items-center gap-2 px-1 pt-2 text-xs text-zinc-400">
                <input type="checkbox" checked={anyNetwork} onChange={(e) => setAnyNetwork(e.target.checked)} />
                This time also on mobile data
              </label>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Running({ p }: { p: Progress }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-zinc-300">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
        {p.stage}
        {p.files > 0 && ` · ${p.done + p.failed} of ${p.files}`}
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

function LastOutcome({ last, label }: { last: NonNullable<Status["last"]>; label: string }) {
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

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className="flex items-center justify-between gap-3 px-1 py-2.5 text-left text-sm text-zinc-200">
      <span>{label}</span>
      <span className={`shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors ${on ? "bg-emerald-600" : "bg-zinc-700"}`}>
        <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${on ? "translate-x-4" : ""}`} />
      </span>
    </button>
  );
}
