import { useEffect, useState } from "react";
import { Cloud, Loader2, LogOut, Plus, Server, Smartphone, Trash2 } from "lucide-react";
import { callLocal } from "../../api";
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
          <div className="text-[11px] text-zinc-500">{remote ? `${formatBytes(remote.bytes)} of ${formatBytes(remote.limit_mb * 1024 * 1024)}` : "…"}</div>
        </div>
        <button onClick={() => callLocal("clear_remote_cache").then(load)} className="px-3 py-1.5 rounded-full bg-zinc-800 text-xs text-zinc-200">
          Clear
        </button>
      </div>
    </Section>
  );
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
