import { createContext, useContext, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Loader2, LogIn } from "lucide-react";
import {
  accessSnapshot,
  hasRole,
  inDesktopApp,
  allPhotosSources,
  LOGGED_OUT_EVENT,
  openLibraryIsAll,
  openLibraryIsLocal,
  openLibraryRole,
  openServerUser,
  serverAuth,
  subscribeAccess,
  type RemoteUser,
  type Role,
} from "../../api";

// Who is logged in to the server (the web client only; null in the desktop app)
interface Account {
  user: RemoteUser;
  logout: () => void;
}

const AccountContext = createContext<Account | null>(null);

export function useAccount(): Account | null {
  return useContext(AccountContext);
}

// What the user may do with the open library. A library on this computer is the user's own: everything. A
// library on a server follows the user's role there, which can differ per library (an editor of their own,
// a guest of someone else's); before the server has said, their default role. The server checks every call
// again; this only hides what would be refused.
export interface Access {
  // Rate, flag, tag, name faces, albums, locations, dates, single-photo AI, planned moves
  edit: boolean;
  // Files on disk (commit moves, empty _Trash), caches, the long jobs, users
  admin: boolean;
  // Send photos to the server (uploader and up)
  upload: boolean;
}

const EVERYTHING: Access = { edit: true, admin: true, upload: true };

export function useAccess(): Access {
  const account = useAccount();
  useSyncExternalStore(subscribeAccess, accessSnapshot);
  if (openLibraryIsLocal()) return EVERYTHING;
  // All photos: editing works where a photo's home allows it (the rest is left alone, with a note); files,
  // jobs and users belong to one library opened on its own
  if (openLibraryIsAll()) {
    const sources = [...allPhotosSources().values()];
    return { edit: sources.some((s) => s.editable), admin: false, upload: sources.some((s) => s.server !== null && s.uploadable) };
  }
  // The web client's account, or the one the desktop app uses on the open library's server
  const user = account?.user ?? openServerUser();
  const admin = hasRole(user, "admin");
  const role = openLibraryRole() ?? user?.role;
  const at = (wanted: Role) => admin || hasRole(role ? { role } : null, wanted);
  return { edit: at("editor"), admin, upload: at("uploader") };
}

// The web client shows the app only to a logged-in user: it asks the server who is logged in, shows the
// login form when nobody is, and goes back to it when the server says the session ended. The app itself is
// not mounted meanwhile, so it starts afresh after a login. The desktop app passes straight through.
export function ServerGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<RemoteUser | null | undefined>(inDesktopApp ? null : undefined);
  const [unreachable, setUnreachable] = useState<string | null>(null);

  useEffect(() => {
    if (inDesktopApp) return;
    serverAuth
      .me()
      .then((u) => setUser(u))
      .catch((e) => {
        setUnreachable(String(e?.message ?? e));
        setUser(null);
      });
    const loggedOut = () => setUser(null);
    window.addEventListener(LOGGED_OUT_EVENT, loggedOut);
    return () => window.removeEventListener(LOGGED_OUT_EVENT, loggedOut);
  }, []);

  if (inDesktopApp) return <>{children}</>;
  if (user === undefined) {
    return (
      <div className="h-screen bg-surface flex items-center justify-center text-zinc-400 text-xs gap-2">
        <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
        Connecting to the server…
      </div>
    );
  }
  if (user === null) {
    return <LoginScreen notice={unreachable} onLogin={(u) => { setUnreachable(null); setUser(u); }} />;
  }
  const logout = () => {
    serverAuth.logout().finally(() => setUser(null));
  };
  return <AccountContext.Provider value={{ user, logout }}>{children}</AccountContext.Provider>;
}

function LoginScreen({ notice, onLogin }: { notice: string | null; onLogin: (user: RemoteUser) => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      onLogin(await serverAuth.login(name.trim(), password));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 focus:border-emerald-500 outline-none text-sm text-zinc-100";
  return (
    <div className="h-screen bg-surface flex items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-panel/90 p-7 flex flex-col gap-4"
      >
        <div className="flex flex-col items-center text-center gap-1">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-2">
            <LogIn className="w-6 h-6 text-emerald-400" />
          </div>
          <h1 className="text-lg font-bold text-zinc-100">Lumina</h1>
          <p className="text-xs text-zinc-400">Log in to see the photos on this server.</p>
        </div>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Name
          <input
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Password
          <input
            className={field}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !name.trim() || !password}
          className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition flex items-center justify-center gap-2"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
          Log in
        </button>
      </form>
    </div>
  );
}
