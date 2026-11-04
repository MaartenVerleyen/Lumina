import { useEffect, useState, type FormEvent } from "react";
import { Cloud, HardDrive, Loader2, LogIn, LogOut, Server, Trash2 } from "lucide-react";
import { callLocal, openLibraryServer, type ServerInfo } from "../../api";
import { connectServer, refreshServers, removeServer, signOutServer, useServers, type ServerLibrary } from "../../hooks/useServers";
import { confirmDialog } from "../../confirm";
import { formatBytes } from "../../utils/photoHelpers";

// Connecting the desktop app to a Lumina server: address, name, password. The server's address is the one
// its admin gives out ("cachy.tailnet.ts.net"); https:// is added when it's left out.
export function ConnectServerForm({ initial, onDone }: { initial?: { url: string; user: string }; onDone?: (server: ServerInfo) => void }) {
  const [url, setUrl] = useState(initial?.url ?? "");
  const [name, setName] = useState(initial?.user ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim() || !name.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const server = await connectServer(url.trim(), name.trim(), password);
      setPassword("");
      onDone?.(server);
    } catch (err) {
      setError(String(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 focus:border-emerald-500 outline-none text-[13px] text-zinc-100";
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 text-left">
      <label className="flex flex-col gap-1 text-[12px] text-zinc-400">
        Server address
        <input className={field} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="lumina.example.ts.net" autoFocus={!initial} />
      </label>
      <div className="flex gap-3">
        <label className="flex-1 flex flex-col gap-1 text-[12px] text-zinc-400">
          Name
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoCapitalize="none" />
        </label>
        <label className="flex-1 flex flex-col gap-1 text-[12px] text-zinc-400">
          Password
          <input
            className={field}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus={!!initial}
          />
        </label>
      </div>
      {error && <p className="text-[12px] text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={busy || !url.trim() || !name.trim() || !password}
        className="self-start px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-[13px] font-semibold transition flex items-center gap-2"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
        {initial ? "Sign in" : "Connect"}
      </button>
    </form>
  );
}

// Every signed-in server with its libraries, to open one
export function ServerLibraryList({ onOpen, compact = false }: { onOpen: (root: string, server: string) => void; compact?: boolean }) {
  const { servers, libraries } = useServers();
  const signedIn = servers.filter((s) => s.signed_in);
  if (signedIn.length === 0) return null;
  const openServer = openLibraryServer();
  return (
    <div className="flex flex-col gap-2 w-full">
      {signedIn.map((s) => {
        const list = libraries[s.id];
        return (
          <div key={s.id} className="flex flex-col gap-1">
            <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5 px-1">
              <Cloud className="w-3 h-3" /> On {s.label}
            </div>
            {!list && <div className="text-[12px] text-zinc-500 px-1">Listing…</div>}
            {list && "error" in list && <div className="text-[12px] text-red-400 px-1">{list.error}</div>}
            {list && !("error" in list) && list.length === 0 && (
              <div className="text-[12px] text-zinc-500 px-1">{s.role === "guest" ? "Nothing is shared with you yet." : "No libraries yet."}</div>
            )}
            {list &&
              !("error" in list) &&
              list.map((l: ServerLibrary) => (
                <button
                  key={l.root}
                  onClick={() => onOpen(l.root, s.id)}
                  className={`w-full rounded-lg text-left flex items-center justify-between gap-2 transition ${
                    compact ? "px-2 py-1.5 hover:bg-zinc-800/80" : "px-3 py-2.5 bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800"
                  } ${openServer === s.id ? "text-emerald-200" : "text-zinc-200"}`}
                >
                  <span className="truncate text-[13px] font-medium" title={l.root}>
                    {l.name || l.root.split(/[\\/]/).filter(Boolean).pop() || l.root}
                  </span>
                  <span className="text-[11px] text-zinc-500 shrink-0">
                    {l.photos} photo{l.photos === 1 ? "" : "s"}
                  </span>
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
}

// Settings → Servers
export function ServersSettings() {
  const { servers } = useServers();
  const [adding, setAdding] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [cache, setCache] = useState<{ bytes: number; limit_mb: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCache = () => callLocal<{ bytes: number; limit_mb: number }>("remote_cache_info").then(setCache).catch(() => {});
  useEffect(() => {
    refreshServers();
    loadCache();
  }, []);

  async function act(f: () => Promise<unknown>) {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(s: ServerInfo) {
    const ok = await confirmDialog(
      `Lumina forgets ${s.label} and signs out. Nothing on the server changes; photos you downloaded stay where they are.`,
      { title: `Remove ${s.label}?`, kind: "warning", okLabel: "Remove", cancelLabel: "Keep" }
    );
    if (ok) act(() => removeServer(s.id));
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-1">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 px-1 mb-1">Servers</h3>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 divide-y divide-zinc-800/80">
          {servers.length === 0 && (
            <div className="px-4 py-3 text-[13px] text-zinc-400">
              Lumina works on this PC on its own. Connect to a Lumina server to see its libraries here too, upload photos to it and
              download originals.
            </div>
          )}
          {servers.map((s) => (
            <div key={s.id} className="px-4 py-3 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[13px] text-zinc-100 flex items-center gap-2">
                    <Server className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span className="truncate">{s.id}</span>
                  </div>
                  <div className="text-[12px] text-zinc-500 mt-0.5">
                    {s.signed_in ? `Signed in as ${s.user}${s.role ? ` (${s.role})` : ""}` : `Signed out (was ${s.user})`}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {s.signed_in ? (
                    <button
                      onClick={() => act(() => signOutServer(s.id))}
                      className="px-2.5 py-1.5 rounded-lg text-[12px] bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-white flex items-center gap-1.5"
                    >
                      <LogOut className="w-3.5 h-3.5" /> Sign out
                    </button>
                  ) : (
                    <button
                      onClick={() => setSigningIn(signingIn === s.id ? null : s.id)}
                      className="px-2.5 py-1.5 rounded-lg text-[12px] bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1.5"
                    >
                      <LogIn className="w-3.5 h-3.5" /> Sign in
                    </button>
                  )}
                  <button
                    onClick={() => remove(s)}
                    className="p-1.5 rounded-lg text-zinc-500 hover:text-red-300 hover:bg-zinc-800"
                    title={`Remove ${s.label}`}
                    aria-label={`Remove ${s.label}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {signingIn === s.id && !s.signed_in && (
                <ConnectServerForm initial={{ url: s.url, user: s.user }} onDone={() => setSigningIn(null)} />
              )}
            </div>
          ))}
          <div className="px-4 py-3">
            {adding ? (
              <ConnectServerForm onDone={() => setAdding(false)} />
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="px-3 py-1.5 rounded-lg text-[12px] bg-zinc-900 border border-zinc-700 text-zinc-200 hover:text-white flex items-center gap-1.5"
              >
                <Server className="w-3.5 h-3.5 text-emerald-400" /> Connect to a server…
              </button>
            )}
          </div>
        </div>
        {error && <p className="text-[12px] text-red-400 px-1 mt-1">{error}</p>}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 px-1 mb-1">Thumbnail cache</h3>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-3 flex items-center justify-between gap-6">
          <div className="min-w-0">
            <div className="text-[13px] text-zinc-100 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-zinc-400" />
              {cache ? `${formatBytes(cache.bytes)} of ${formatBytes(cache.limit_mb * 1024 * 1024)}` : "…"}
            </div>
            <div className="text-[12px] text-zinc-500 mt-0.5 leading-snug">
              Thumbnails and faces from servers are kept on this PC so the grid scrolls quickly. Above the limit, the ones used longest ago
              go first.
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select
              value={cache?.limit_mb ?? 2048}
              onChange={(e) => act(() => callLocal("set_remote_cache_limit", { limitMb: Number(e.target.value) }).then(loadCache))}
              className="bg-zinc-900 border border-zinc-700 rounded-lg text-[12px] text-zinc-200 px-2 py-1.5"
              aria-label="Cache size"
            >
              {[512, 1024, 2048, 5120, 10240].map((mb) => (
                <option key={mb} value={mb}>
                  {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                </option>
              ))}
            </select>
            <button
              onClick={() => act(() => callLocal("clear_remote_cache").then(loadCache))}
              className="px-2.5 py-1.5 rounded-lg text-[12px] bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-white"
            >
              Empty
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
