import { useEffect, useState } from "react";
import { Cloud, Download, HardDrive, Loader2, LogOut, Plus, Server, Smartphone, Trash2 } from "lucide-react";
import { allPhotosOnServer, callLocal, onAndroid } from "../../api";
import { getVersion } from "../../api/platform";
import { connectServer, removeServer, signOutServer, useServers } from "../../hooks/useServers";
import { formatBytes } from "../../utils/photoHelpers";
import { Button, Page, Section, T } from "./PhoneParts";
import { checkForUpdate, useUpdate } from "./useUpdate";

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

// A setting's row: its icon, what it is and a line about it, and at most one button
function Row({ icon, title, sub, children }: { icon: React.ReactNode; title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="shrink-0 text-zinc-400">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className={`${T.body} text-zinc-100`}>{title}</div>
        {sub && <div className={`pt-0.5 ${T.secondary}`}>{sub}</div>}
      </div>
      {children}
    </div>
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
        <Row key={s.id} icon={<Server className="w-5 h-5" />} title={s.label} sub={s.signed_in ? `${s.user} · ${s.role}` : "Signed out"}>
          {busy === s.id ? (
            <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
          ) : s.signed_in ? (
            <Button icon={<LogOut className="w-4 h-4" />} onClick={() => run(s.id, () => signOutServer(s.id))}>
              Sign out
            </Button>
          ) : (
            <Button icon={<Trash2 className="w-4 h-4" />} onClick={() => run(s.id, () => removeServer(s.id))}>
              Remove
            </Button>
          )}
        </Row>
      ))}
      {error && <div className="pb-1 text-[13px] text-red-300">{error}</div>}
      {adding ? (
        <AddServer onDone={() => setAdding(false)} />
      ) : (
        <div className="-ml-4">
          <Button kind="text" icon={<Plus className="w-4 h-4" />} onClick={() => setAdding(true)}>
            Sign in to a server
          </Button>
        </div>
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
      {error && <div className="text-[13px] text-red-300">{error}</div>}
      <div className="flex gap-2 pt-1">
        <div className="flex-1 flex">
          <Button wide onClick={onDone}>
            Cancel
          </Button>
        </div>
        <div className="flex-1 flex">
          <Button wide kind="primary" type="submit" disabled={busy || !url || !name || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </div>
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
      <Row
        icon={<Smartphone className="w-5 h-5" />}
        title="Thumbnails of the phone's photos"
        sub={thumbs ? `${thumbs.count.toLocaleString()} ${thumbs.count === 1 ? "photo" : "photos"} · ${formatBytes(thumbs.bytes)}` : "…"}
      >
        <Button onClick={() => void callLocal("clear_phone_thumbs").then(load)}>Clear</Button>
      </Row>
      <Row
        icon={<Cloud className="w-5 h-5" />}
        title="Server photos kept for viewing"
        sub={remote ? `${formatBytes(remote.bytes)} kept` : "…"}
      >
        <Button onClick={() => void callLocal("clear_remote_cache").then(load)}>Clear</Button>
      </Row>
      <Row icon={<HardDrive className="w-5 h-5" />} title="Space for them" sub="When it's full, the oldest go">
        <select
          value={remote?.limit_mb ?? 2048}
          onChange={(e) => void callLocal("set_remote_cache_limit", { limitMb: Number(e.target.value) }).then(load)}
          className="min-h-11 shrink-0 rounded-full bg-zinc-800 px-4 text-[15px] text-zinc-100 outline-none"
          aria-label="Space for server photos kept for viewing"
        >
          {LIMITS_MB.concat(remote && !LIMITS_MB.includes(remote.limit_mb) ? [remote.limit_mb] : []).map((mb) => (
            <option key={mb} value={mb}>
              {formatBytes(mb * 1024 * 1024)}
            </option>
          ))}
        </select>
      </Row>
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
    <div>
      <Row
        icon={<Download className="w-5 h-5" />}
        title={`Keep all thumbnails of ${label}`}
        sub={`${ids.length.toLocaleString()} photos · about ${formatBytes(ids.length * 50 * 1024)} · to look through without a connection`}
      >
        {p?.running ? (
          <Button onClick={() => void callLocal("stop_keep_thumbs")}>Stop</Button>
        ) : (
          <Button onClick={() => void start()} disabled={ids.length === 0}>
            Keep
          </Button>
        )}
      </Row>
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
  const { update, checking, checkedAt, error } = useUpdate();
  const [installing, setInstalling] = useState<{ done: number; total: number } | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const install = async () => {
    if (!update) return;
    setInstallError(null);
    setInstalling({ done: 0, total: update.size });
    const timer = window.setInterval(() => {
      callLocal<{ done: number; total: number }>("phone_update_progress")
        .then((p) => setInstalling({ done: p.done, total: p.total || update.size }))
        .catch(() => {});
    }, 500);
    try {
      // Downloads, then Android's installer asks
      await callLocal("phone_update_install", { url: update.url });
    } catch (e) {
      setInstallError(String(e));
    } finally {
      window.clearInterval(timer);
      setInstalling(null);
    }
  };
  return (
    <Section title="About">
      <div className={`py-2 ${T.body}`}>Lumina {version}</div>
      {onAndroid && update ? (
        <div className="py-1">
          <div className="text-sm text-emerald-300">Lumina {update.version} is out</div>
          {update.notes && <div className={`pt-1 whitespace-pre-line line-clamp-6 ${T.secondary}`}>{update.notes}</div>}
          {installing ? (
            <div className="pt-2">
              <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                <div className="h-full bg-emerald-500" style={{ width: `${installing.total ? Math.round((installing.done / installing.total) * 100) : 0}%` }} />
              </div>
              <div className="pt-1 text-[11px] text-zinc-500">
                Downloading {formatBytes(installing.done)} of {formatBytes(installing.total)}
              </div>
            </div>
          ) : (
            <div className="mt-2 flex">
              <Button wide kind="primary" onClick={() => void install()}>
                Update ({formatBytes(update.size)})
              </Button>
            </div>
          )}
          {installError && <div className="pt-1 text-[11px] text-red-300">{installError}</div>}
        </div>
      ) : onAndroid ? (
        <div className="flex items-center gap-2 pb-1">
          <span className={`flex-1 ${T.secondary}`}>
            {checking ? "Looking for updates…" : error ? error : checkedAt ? "This is the latest version." : ""}
          </span>
          <Button kind="text" onClick={() => void checkForUpdate(true)} disabled={checking}>
            Check now
          </Button>
        </div>
      ) : null}
      <div className={`pb-1 ${T.caption}`}>Your photos on your own server. Photos on this phone are never changed by Lumina.</div>
    </Section>
  );
}
