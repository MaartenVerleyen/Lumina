import { useEffect, useState } from "react";
import { Cloud, Download, Loader2, LogOut, Plus, Server, Smartphone, Trash2 } from "lucide-react";
import { allPhotosOnServer, callLocal } from "../../api";
import { getVersion } from "../../api/platform";
import { connectServer, removeServer, signOutServer, useServers } from "../../hooks/useServers";
import { formatBytes } from "../../utils/photoHelpers";
import { Page, Section } from "./PhoneParts";

// The phone app's Settings (docs/plans/android-app-ui.md), opened from the header's account button: the servers,
// what the app keeps on the phone, and the app itself

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  return (
    <Page title="Settings" onBack={onBack}>
      <ServersSection />
      <StorageSection />
      <AboutSection />
    </Page>
  );
}

function ServersSection() {
  const { servers } = useServers();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (id: string, what: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await what();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title="Servers">
      {servers.map((s) => (
        <div key={s.id} className="flex items-center gap-3 py-2">
          <Server className="w-5 h-5 text-zinc-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-zinc-100 truncate">{s.label}</div>
            <div className="text-[11px] text-zinc-500 truncate">{s.signed_in ? `${s.user} · ${s.role}` : "Signed out"}</div>
          </div>
          {busy === s.id ? (
            <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
          ) : s.signed_in ? (
            <button onClick={() => run(s.id, () => signOutServer(s.id))} className="p-2 rounded-full text-zinc-400 active:bg-white/10" aria-label={`Sign out of ${s.label}`}>
              <LogOut className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={() => run(s.id, () => removeServer(s.id))} className="p-2 rounded-full text-zinc-400 active:bg-white/10" aria-label={`Remove ${s.label}`}>
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      ))}
      {error && <div className="text-xs text-red-300 pb-1">{error}</div>}
      {adding ? (
        <AddServer onDone={() => setAdding(false)} />
      ) : (
        <button onClick={() => setAdding(true)} className="flex items-center gap-2 py-2 text-sm text-emerald-400">
          <Plus className="w-4 h-4" />
          Sign in to a server
        </button>
      )}
    </Section>
  );
}

function AddServer({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = "w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-base text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-500";
  return (
    <form
      className="flex flex-col gap-2 py-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await connectServer(url, name, password);
          onDone();
        } catch (err) {
          setError(String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <input className={field} placeholder="Address (cachy.tailnet.ts.net)" value={url} onChange={(e) => setUrl(e.target.value)} autoCapitalize="off" autoCorrect="off" />
      <input className={field} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="off" autoCorrect="off" />
      <input className={field} placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <div className="text-xs text-red-300">{error}</div>}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onDone} className="flex-1 py-2.5 rounded-full bg-zinc-800 text-sm text-zinc-200">
          Cancel
        </button>
        <button type="submit" disabled={busy || !url || !name || !password} className="flex-1 py-2.5 rounded-full bg-emerald-600 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  );
}

function StorageSection() {
  const { servers } = useServers();
  const [thumbs, setThumbs] = useState<{ count: number; bytes: number } | null>(null);
  const [remote, setRemote] = useState<{ bytes: number; limit_mb: number } | null>(null);
  const load = () => {
    callLocal<{ count: number; bytes: number }>("phone_thumbs_info").then(setThumbs).catch(() => {});
    callLocal<{ bytes: number; limit_mb: number }>("remote_cache_info").then(setRemote).catch(() => {});
  };
  useEffect(load, []);
  return (
    <Section title="On this phone">
      <div className="flex items-center gap-3 py-2">
        <Smartphone className="w-5 h-5 text-zinc-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-zinc-100">Thumbnails of the phone's photos</div>
          <div className="text-[11px] text-zinc-500">{thumbs ? `${thumbs.count.toLocaleString()} · ${formatBytes(thumbs.bytes)}` : "…"}</div>
        </div>
        <button onClick={() => callLocal("clear_phone_thumbs").then(load)} className="px-3 py-1.5 rounded-full bg-zinc-800 text-xs text-zinc-200">
          Clear
        </button>
      </div>
      <div className="flex items-center gap-3 py-2">
        <Cloud className="w-5 h-5 text-zinc-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-zinc-100">Server photos kept for viewing</div>
          <div className="text-[11px] text-zinc-500">
            {remote ? `${formatBytes(remote.bytes)} of ` : "… of "}
            <select
              value={remote?.limit_mb ?? 2048}
              onChange={(e) => callLocal("set_remote_cache_limit", { limitMb: Number(e.target.value) }).then(load)}
              className="bg-transparent text-emerald-400 underline"
              aria-label="How much the server photos kept may take"
            >
              {LIMITS_MB.concat(remote && !LIMITS_MB.includes(remote.limit_mb) ? [remote.limit_mb] : []).map((mb) => (
                <option key={mb} value={mb}>
                  {formatBytes(mb * 1024 * 1024)}
                </option>
              ))}
            </select>
            {" · the oldest go first"}
          </div>
        </div>
        <button onClick={() => callLocal("clear_remote_cache").then(load)} className="px-3 py-1.5 rounded-full bg-zinc-800 text-xs text-zinc-200">
          Clear
        </button>
      </div>
      {servers.filter((x) => x.signed_in).map((x) => (
        <KeepAll key={x.id} server={x.id} label={x.label} onChange={load} />
      ))}
    </Section>
  );
}

const LIMITS_MB = [512, 1024, 2048, 5120, 10240];

// Every thumbnail of a server's library kept on the phone, so the whole library shows without a connection
// (about 50 KB each); on Wi-Fi only
function KeepAll({ server, label, onChange }: { server: string; label: string; onChange: () => void }) {
  const [p, setP] = useState<KeepProgress | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = () =>
      callLocal<KeepProgress>("keep_thumbs_progress")
        .then((x) => {
          if (stop) return;
          // One keeps at a time, for one server: the others show nothing of it
          setP(x.server === server ? x : null);
          if (!x.running) onChange();
        })
        .catch(() => {});
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ids = allPhotosOnServer(server);
  const start = async () => {
    const type = (navigator as Navigator & { connection?: { type?: string } }).connection?.type;
    if (type && type !== "wifi" && type !== "ethernet") {
      setNote("On Wi-Fi only: thumbnails of a whole library take a while to download");
      return;
    }
    setNote(null);
    await callLocal("keep_thumbs", { server, hashes: ids }).catch((e) => setNote(String(e)));
  };
  const finished = p && !p.running && p.total > 0;
  return (
    <div className="py-2">
      <div className="flex items-center gap-3">
        <Download className="w-5 h-5 text-zinc-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-zinc-100">Keep all thumbnails of {label}</div>
          <div className="text-[11px] text-zinc-500">
            {ids.length.toLocaleString()} photos · about {formatBytes(ids.length * 50 * 1024)} · to look through without a connection
          </div>
        </div>
        {p?.running ? (
          <button onClick={() => callLocal("stop_keep_thumbs")} className="px-3 py-1.5 rounded-full bg-zinc-800 text-xs text-zinc-200">
            Stop
          </button>
        ) : (
          <button onClick={start} disabled={ids.length === 0} className="px-3 py-1.5 rounded-full bg-emerald-700 text-xs text-white disabled:opacity-50">
            Keep
          </button>
        )}
      </div>
      {p?.running && p.total > 0 && (
        <div className="pt-2 pl-8">
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${Math.round(((p.done + p.had + p.failed) / p.total) * 100)}%` }} />
          </div>
          <div className="pt-1 text-[11px] text-zinc-500">
            {(p.done + p.had).toLocaleString()} of {p.total.toLocaleString()}
          </div>
        </div>
      )}
      {finished && (
        <div className="pt-1 pl-8 text-[11px] text-zinc-500">
          {(p.done + p.had).toLocaleString()} of {p.total.toLocaleString()} kept{p.failed > 0 ? ` · ${p.failed} couldn't be fetched${p.error ? `: ${p.error}` : ""}` : ""}
        </div>
      )}
      {note && <div className="pt-1 pl-8 text-[11px] text-amber-300">{note}</div>}
    </div>
  );
}

interface KeepProgress {
  server: string;
  running: boolean;
  total: number;
  done: number;
  had: number;
  failed: number;
  error: string | null;
}

function AboutSection() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  return (
    <Section title="About">
      <div className="py-2 text-sm text-zinc-200">Lumina {version}</div>
      <div className="pb-1 text-[11px] text-zinc-500">Your photos on your own server. Photos on this phone are never changed by Lumina.</div>
    </Section>
  );
}
