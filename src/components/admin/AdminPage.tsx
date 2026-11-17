import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowUp, Folder, FolderPlus, HardDrive, Library, Loader2, RotateCcw, Server, SlidersHorizontal, Upload, Users, X } from "lucide-react";
import { call, callServer, serverAuth, subscribe, uploadBackup, type Role } from "../../api";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { confirmDialog } from "../../confirm";
import { formatBytes } from "../../utils/photoHelpers";
import { useAccount } from "../auth/ServerGate";

// The server's admin page (admins only): what the server is doing and has still to do, its libraries and
// settings, the accounts with their roles per library, and restoring a backup. The web client shows it for its
// own server; the desktop app for a server it is signed in to (Settings → Servers), through that server's RPC.

// The server the open admin page is for in the desktop app (null: the web client's own). One admin page is open
// at a time, and it sets this before its sections render.
let adminServer: string | null = null;
function adminCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return adminServer ? callServer<T>(adminServer, command, args) : call<T>(command, args);
}

interface LibraryStatus {
  root: string;
  name: string;
  photos: number;
  videos: number;
  thumbnails_missing: number;
  faces_pending: number;
  smart_search_pending: number;
  captions_pending: number;
  damaged?: number;
  damaged_files?: string[];
}

interface ServerStatus {
  version: string;
  data_dir: string;
  disk: { free: number; total: number } | null;
  device: string | null;
  caption_model: string | null;
  ollama: { running: boolean; installed_models?: { name: string }[] } | null;
  jobs: { current: string | null; queued: string[]; thumbnails: boolean; smart_search: boolean; captions: boolean };
  libraries: LibraryStatus[];
  // What runs now, with its counts
  progress?: Progress[];
}

interface Progress {
  label: string;
  stage: string;
  completed: number;
  total: number;
  seconds: number;
}

interface ServerSettings {
  libraries: { root: string; photos: number }[];
  removed: { root: string; photos: number }[];
  upload_library: string | null;
  caption_model: string | null;
  ollama_url: string;
  // Set by an environment variable where the server starts
  fixed: string[];
}

interface FolderList {
  path: string | null;
  parent: string | null;
  folders: { name: string; path: string }[];
}

interface Account {
  name: string;
  role: Role;
  libraries: { root: string; role: Role }[];
}

interface Manifest {
  computer: string;
  created_at: number;
  app_version: string;
  photos: number;
  people: number;
  albums: number;
  roots: { path: string; photos: number }[];
}

type Section = "server" | "libraries" | "settings" | "people" | "restore";
const ROLES: Role[] = ["guest", "viewer", "uploader", "editor", "admin"];
const LIBRARY_ROLES: Role[] = ["guest", "viewer", "uploader", "editor"];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-zinc-500 px-1 mb-1">{title}</h3>
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 divide-y divide-zinc-800/80">{children}</div>
    </section>
  );
}

function Button({ children, onClick, disabled, primary, danger }: { children: ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition disabled:opacity-40 ${
        primary
          ? "bg-emerald-600 hover:bg-emerald-500 text-white"
          : danger
            ? "bg-red-950/60 hover:bg-red-900/70 border border-red-800/60 text-red-200"
            : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

const select = "bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1 text-[12px] text-zinc-200 focus:outline-none focus:border-emerald-500";
const input = "bg-zinc-950 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-[12px] text-zinc-200 select-text focus:outline-none focus:border-emerald-500";

export default function AdminPage({ isOpen, onClose, server = null }: { isOpen: boolean; onClose: () => void; server?: string | null }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  const [section, setSection] = useState<Section>("server");
  if (!isOpen) return null;
  adminServer = server;
  const sections: { id: Section; label: string; icon: typeof Server }[] = [
    { id: "server", label: "Server", icon: Activity },
    { id: "libraries", label: "Libraries", icon: Library },
    { id: "settings", label: "Settings", icon: SlidersHorizontal },
    { id: "people", label: "People", icon: Users },
    { id: "restore", label: "Restore", icon: RotateCcw },
  ];
  return (
    <div onClick={onClose} className="fixed inset-0 z-[9985] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Server admin"
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onClick={(e) => e.stopPropagation()}
        className="bg-raised border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex w-[min(1000px,100%)] h-[min(680px,100%)]"
      >
        <nav className="w-48 shrink-0 bg-panel border-r border-zinc-800 p-3 flex flex-col gap-0.5">
          <div className="flex items-center gap-2 px-2.5 pt-1 pb-4 text-sm font-semibold text-zinc-100">
            <Server className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="truncate" title={server ?? undefined}>{server ? `Admin: ${server}` : "Server admin"}</span>
          </div>
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              aria-current={section === id ? "page" : undefined}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-left transition ${
                section === id ? "bg-emerald-500/10 text-emerald-200" : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60"
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <h2 className="text-base font-semibold text-zinc-100">{sections.find((s) => s.id === section)!.label}</h2>
            <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 pb-6 flex flex-col gap-5 text-[13px] text-zinc-300">
            {section === "server" && <ServerSection />}
            {section === "libraries" && <LibrariesSection />}
            {section === "settings" && <SettingsSection />}
            {section === "people" && <PeopleSection />}
            {section === "restore" && <RestoreSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerSection() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    adminCall<ServerStatus>("server_status")
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    load();
    // Every few seconds while open, and when a job ends
    const timer = setInterval(load, 5000);
    const offs = ["scan-progress", "face-scan-progress", "semantic-progress", "ai-batch-progress"].map((name) =>
      subscribe<{ done?: boolean }>(name, (e) => {
        if (e.payload?.done && (!adminServer || e.server === adminServer)) load();
      })
    );
    return () => {
      clearInterval(timer);
      for (const off of offs) off.then((f) => f());
    };
  }, []);

  async function start(root: string, job: string) {
    try {
      await adminCall("start_library_job", { rootFolder: root, job });
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!status) {
    return error ? <p className="text-red-400">{error}</p> : <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />;
  }
  const { jobs } = status;
  const running = [jobs.current, jobs.thumbnails && "Thumbnails", jobs.smart_search && "Smart search index", jobs.captions && "Captions"].filter(
    Boolean
  ) as string[];
  return (
    <>
      {error && <p className="text-red-400">{error}</p>}
      <Group title="This server">
        <Fact label="Lumina">{status.version}</Fact>
        <Fact label="Faces and smart search run on">{status.device ?? "Not used since the server started"}</Fact>
        <Fact label="Captions">
          {status.caption_model ? `${status.caption_model} · Ollama ${status.ollama?.running ? "running" : "not running"}` : "No caption model configured"}
        </Fact>
        <Fact label="Data folder">
          <span className="font-mono text-[12px]">{status.data_dir}</span>
          {status.disk && (
            <span className="text-zinc-500">
              {" "}
              · <HardDrive className="inline w-3.5 h-3.5 -mt-0.5" /> {formatBytes(status.disk.free)} free of {formatBytes(status.disk.total)}
            </span>
          )}
        </Fact>
      </Group>
      <Group title="Running now">
        <Fact label="Working on">
          {running.length === 0 ? "Nothing" : (
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
              {running.join(" · ")}
            </span>
          )}
        </Fact>
        {(status.progress ?? []).map((p) => (
          <ProgressRow key={p.label} progress={p} />
        ))}
        {jobs.queued.length > 0 && <Fact label="Waiting">{jobs.queued.join(" · ")}</Fact>}
      </Group>
      {status.libraries.map((l) => (
        <Group key={l.root} title={`${l.name || l.root} · ${l.photos.toLocaleString()} items (${l.videos} videos)`}>
          <Fact label="Folder">
            <span className="font-mono text-[12px]">{l.root}</span>
          </Fact>
          <Backlog label="Thumbnails to make" count={l.thumbnails_missing} action="Rescan" onStart={() => start(l.root, "rescan")} hint="Walks the folders again and does what is missing" />
          {(l.damaged ?? 0) > 0 && <DamagedFiles count={l.damaged ?? 0} files={l.damaged_files ?? []} />}
          <Backlog label="Photos and videos without a face scan" count={l.faces_pending} action="Scan faces" onStart={() => start(l.root, "faces")} />
          <Backlog label="Not in the smart search index" count={l.smart_search_pending} action="Index" onStart={() => start(l.root, "smart_search")} />
          <Backlog
            label="Photos without a caption"
            count={l.captions_pending}
            action="Write captions"
            disabled={!status.caption_model}
            onStart={() => start(l.root, "captions")}
            hint={status.caption_model ? undefined : "Set caption_model (or LUMINA_CAPTION_MODEL) to write captions"}
          />
        </Group>
      ))}
    </>
  );
}

// "about 20 min left", from the rate so far (nothing until there is one)
function timeLeft(p: Progress): string | null {
  if (p.total <= 0 || p.completed <= 0 || p.seconds < 5 || p.completed >= p.total) return null;
  const seconds = ((p.total - p.completed) / p.completed) * p.seconds;
  if (seconds < 60) return "less than a minute left";
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min left`;
  return `about ${(seconds / 3600).toFixed(1)} hours left`;
}

function ProgressRow({ progress: p }: { progress: Progress }) {
  const left = timeLeft(p);
  return (
    <div className="px-4 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-6">
        <span className="text-zinc-200">{p.label}</span>
        <span className="text-zinc-400 text-[12px]">
          {p.total > 0 ? `${p.completed.toLocaleString()} of ${p.total.toLocaleString()}` : p.stage || "Starting"}
          {left ? ` · ${left}` : ""}
        </span>
      </div>
      {p.total > 0 && (
        <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
          <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, (p.completed / p.total) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 px-4 py-2.5">
      <span className="text-zinc-400 shrink-0">{label}</span>
      <span className="text-zinc-100 text-right min-w-0 break-words">{children}</span>
    </div>
  );
}

// The files of a library that can't be read, for whoever looks after it: listed on request
function DamagedFiles({ count, files }: { count: number; files: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-zinc-200">Damaged files</div>
          <div className="text-[12px] text-zinc-500">
            Cut off or unreadable. They aren't tried again until the file changes or you rescan. In the app: search for is:damaged.
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="font-mono text-amber-300">{count.toLocaleString()}</span>
          <Button onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</Button>
        </div>
      </div>
      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-zinc-800 bg-black/20 px-3 py-2 font-mono text-[12px] text-zinc-300">
          {files.map((f) => (
            <div key={f} className="truncate" title={f}>
              {f}
            </div>
          ))}
          {count > files.length && <div className="text-zinc-500">…and {(count - files.length).toLocaleString()} more</div>}
        </div>
      )}
    </div>
  );
}

function Backlog({ label, count, action, onStart, disabled, hint }: { label: string; count: number; action: string; onStart: () => void; disabled?: boolean; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-zinc-200">{label}</div>
        {hint && <div className="text-[12px] text-zinc-500">{hint}</div>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`font-mono ${count > 0 ? "text-amber-300" : "text-zinc-500"}`}>{count.toLocaleString()}</span>
        <Button onClick={onStart} disabled={disabled}>
          {action}
        </Button>
      </div>
    </div>
  );
}

function PeopleSection() {
  const me = useAccount()?.user.name.toLowerCase();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newUser, setNewUser] = useState({ name: "", role: "viewer" as Role, password: "" });
  const [passwordFor, setPasswordFor] = useState<{ name: string; password: string } | null>(null);

  const load = () =>
    Promise.all([adminCall<Account[]>("admin_list_users"), adminCall<{ root: string }[]>("list_libraries")])
      .then(([a, libs]) => {
        setAccounts(a);
        setRoots(libs.map((l) => l.root));
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    load();
  }, []);

  async function run(what: Promise<unknown>, done: string) {
    setError(null);
    setNotice(null);
    try {
      await what;
      setNotice(done);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!accounts) return error ? <p className="text-red-400">{error}</p> : <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />;
  return (
    <>
      <p className="text-[12px] text-zinc-500 leading-relaxed">
        Each person's role is their default for every library; a library can have its own role for them (a guest of one, an editor of
        another). Guests see only the albums shared with them. Admins can do everything, on the whole server.
      </p>
      {error && <p className="text-red-400">{error}</p>}
      {notice && <p className="text-emerald-300">{notice}</p>}
      {accounts.map((a) => {
        const isMe = a.name.toLowerCase() === me;
        return (
          <Group key={a.name} title={isMe ? `${a.name} (you)` : a.name}>
            <div className="flex items-center justify-between gap-6 px-4 py-2.5">
              <span className="text-zinc-400">Role</span>
              <select
                className={select}
                value={a.role}
                disabled={isMe}
                onChange={(e) => run(adminCall("admin_set_role", { name: a.name, role: e.target.value }), `${a.name} is now ${e.target.value}`)}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            {a.role !== "admin" &&
              roots.length > 1 &&
              roots.map((root) => {
                const own = a.libraries.find((l) => l.root === root)?.role;
                return (
                  <div key={root} className="flex items-center justify-between gap-6 px-4 py-2">
                    <span className="text-zinc-400 font-mono text-[12px] truncate">{root}</span>
                    <select
                      className={select}
                      value={own ?? ""}
                      onChange={(e) =>
                        run(
                          adminCall("admin_set_library_role", { name: a.name, rootFolder: root, role: e.target.value || null }),
                          `${a.name}'s role on ${root} changed`
                        )
                      }
                    >
                      <option value="">default ({a.role})</option>
                      {LIBRARY_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            <div className="flex items-center justify-end gap-2 px-4 py-2.5">
              {passwordFor?.name === a.name ? (
                <form
                  className="flex items-center gap-2 mr-auto"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(adminCall("admin_set_password", { name: a.name, password: passwordFor.password }), `New password for ${a.name}; they're logged out everywhere`).then(() =>
                      setPasswordFor(null)
                    );
                  }}
                >
                  <input
                    type="password"
                    autoFocus
                    autoComplete="new-password"
                    placeholder="New password (8 or more characters)"
                    value={passwordFor.password}
                    onChange={(e) => setPasswordFor({ name: a.name, password: e.target.value })}
                    className={`${input} w-64`}
                  />
                  <Button primary>Set</Button>
                  <Button onClick={() => setPasswordFor(null)}>Cancel</Button>
                </form>
              ) : (
                <Button onClick={() => setPasswordFor({ name: a.name, password: "" })}>Reset password</Button>
              )}
              {!isMe && (
                <Button
                  danger
                  onClick={async () => {
                    const ok = await confirmDialog(`Remove ${a.name}? They are logged out and can't log in again. Their ratings and tags stay.`, {
                      title: "Remove account",
                      kind: "danger",
                      okLabel: "Remove",
                    });
                    if (ok) run(adminCall("admin_remove_user", { name: a.name }), `Removed ${a.name}`);
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          </Group>
        );
      })}
      <Group title="Add someone">
        <form
          className="flex flex-wrap items-center gap-2 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(adminCall("admin_create_user", newUser), `Added ${newUser.name.trim()} (${newUser.role})`).then(() =>
              setNewUser({ name: "", role: "viewer", password: "" })
            );
          }}
        >
          <input placeholder="Name" value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} className={`${input} w-40`} />
          <select className={select} value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Password (8 or more characters)"
            value={newUser.password}
            onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
            className={`${input} w-60`}
          />
          <Button primary disabled={!newUser.name.trim() || newUser.password.length < 8}>
            Add
          </Button>
        </form>
      </Group>
    </>
  );
}

function RestoreSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [remaps, setRemaps] = useState<Record<string, string>>({});
  const [roots, setRoots] = useState<string[]>([]);
  const [state, setState] = useState<"idle" | "restoring" | "restarting">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminCall<{ root: string }[]>("list_libraries").then((l) => setRoots(l.map((x) => x.root))).catch(() => {});
  }, []);

  async function upload(file: File) {
    setError(null);
    setManifest(null);
    setProgress(0);
    try {
      const { file: name } = await uploadBackup(file, (sent, total) => setProgress(total ? Math.round((sent / total) * 100) : 0));
      setUploaded(name);
      const m = await adminCall<Manifest>("inspect_backup", { path: name });
      setManifest(m);
      // Each library of the backup goes to the server's library of the same name, or the first one
      const lastPart = (p: string) => p.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase();
      setRemaps(Object.fromEntries(m.roots.map((r) => [r.path, roots.find((s) => lastPart(s) === lastPart(r.path)) ?? roots[0] ?? r.path])));
    } catch (e) {
      setError(String(e));
    } finally {
      setProgress(null);
    }
  }

  async function restore() {
    if (!uploaded || !manifest) return;
    const ok = await confirmDialog(
      `Replace the server's library with this backup (${manifest.photos.toLocaleString()} photos from ${manifest.computer})?\n\nRatings, tags, people and albums become the backup's. The current library database is kept as a copy in the data folder, and accounts stay as they are. The server starts again; everyone's window reconnects.`,
      { title: "Restore backup", kind: "danger", okLabel: "Restore" }
    );
    if (!ok) return;
    setState("restoring");
    setError(null);
    try {
      await adminCall("restore_library", { path: uploaded, remaps: Object.entries(remaps).map(([from, to]) => ({ from, to })) });
      setState("restarting");
      // Back once the server answers again
      const started = Date.now();
      const poll = async () => {
        try {
          if ((await serverAuth.me()) && Date.now() - started > 3000) {
            location.reload();
            return;
          }
        } catch {
          // still starting
        }
        setTimeout(poll, 1000);
      };
      setTimeout(poll, 2000);
    } catch (e) {
      setState("idle");
      setError(String(e));
    }
  }

  // The backup goes up as a browser upload with the web page's sign-in, which the desktop app doesn't have
  if (adminServer) {
    return (
      <p className="text-[12px] text-zinc-500 leading-relaxed">
        Restoring a backup (.luminabackup) uploads the file from a browser: open {adminServer}'s web page, sign in, and choose
        Server admin → Restore there.
      </p>
    );
  }

  return (
    <>
      <p className="text-[12px] text-zinc-500 leading-relaxed">
        A backup (.luminabackup) from the desktop app or from this server puts back its ratings, tags, people, albums and face crops.
        The photos themselves aren't in it: they must already be in the server's library folders.
      </p>
      {error && <p className="text-red-400">{error}</p>}
      <Group title="Backup file">
        <div className="flex items-center justify-between gap-6 px-4 py-3">
          <span className="text-zinc-400">{uploaded && manifest ? "Uploaded" : "Choose a .luminabackup file to upload"}</span>
          <input ref={fileRef} type="file" accept=".luminabackup" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          {progress !== null ? (
            <span className="flex items-center gap-2 text-zinc-200">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" /> Uploading… {progress}%
            </span>
          ) : (
            <Button onClick={() => fileRef.current?.click()} disabled={state !== "idle"}>
              <span className="flex items-center gap-1.5">
                <Upload className="w-3.5 h-3.5" /> Choose file…
              </span>
            </Button>
          )}
        </div>
      </Group>
      {manifest && (
        <>
          <Group title="In the backup">
            <Fact label="Made on">
              {manifest.computer} · {new Date(manifest.created_at * 1000).toLocaleString()} · Lumina {manifest.app_version}
            </Fact>
            <Fact label="Contents">
              {manifest.photos.toLocaleString()} photos · {manifest.people} people · {manifest.albums} albums
            </Fact>
          </Group>
          <Group title="Where its libraries are on this server">
            {manifest.roots.map((r) => (
              <div key={r.path} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <span className="min-w-0">
                  <span className="block font-mono text-[12px] text-zinc-200 truncate">{r.path}</span>
                  <span className="text-[12px] text-zinc-500">{r.photos.toLocaleString()} photos</span>
                </span>
                <select className={select} value={remaps[r.path] ?? ""} onChange={(e) => setRemaps({ ...remaps, [r.path]: e.target.value })}>
                  {roots.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                  <option value={r.path}>Keep as it is ({r.path})</option>
                </select>
              </div>
            ))}
          </Group>
          <div className="flex justify-end">
            {state === "idle" ? (
              <Button danger onClick={restore}>
                Restore this backup
              </Button>
            ) : (
              <span className="flex items-center gap-2 text-zinc-200">
                <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                {state === "restoring" ? "Restoring…" : "The server is starting again…"}
              </span>
            )}
          </div>
        </>
      )}
    </>
  );
}

function LibrariesSection() {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [folder, setFolder] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    adminCall<ServerSettings>("admin_get_settings")
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  async function run(what: () => Promise<ServerSettings>, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setSettings(await what());
      setNotice(done);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(path: string) {
    const ok = await run(
      () => adminCall<ServerSettings>("admin_add_library", { folder: path }),
      `Added ${path}. The server is indexing it now: its photos appear in the apps as they are indexed, and the progress shows under Server.`
    );
    if (ok) setFolder("");
  }

  async function takeOff(root: string, photos: number) {
    const ok = await confirmDialog(
      `Take ${root} off the server?\n\nIts ${photos.toLocaleString()} photos are no longer scanned or shown in the apps. The files stay where they are, and their ratings, faces and albums stay in the server's database: add the folder again to get them back.`,
      { title: "Take a library off", kind: "warning", okLabel: "Take off", cancelLabel: "Cancel" }
    );
    if (ok) await run(() => adminCall<ServerSettings>("admin_remove_library", { rootFolder: root }), `Took ${root} off the server.`);
  }

  if (!settings) return error ? <p className="text-red-400">{error}</p> : <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />;
  const fixed = settings.fixed.includes("libraries");
  return (
    <>
      <p className="text-[12px] text-zinc-500 leading-relaxed">
        The folders on this server that it keeps indexed, with thumbnails, faces and smart search. A folder inside a library is part of
        that library; a folder around libraries takes them in.
      </p>
      {fixed && (
        <p className="text-amber-300 text-[12px]">The libraries are set by LUMINA_LIBRARIES where the server starts, so they can only be changed there.</p>
      )}
      {error && <p className="text-red-400">{error}</p>}
      {notice && <p className="text-emerald-300">{notice}</p>}
      <Group title="Libraries">
        {settings.libraries.length === 0 && <p className="px-4 py-2.5 text-zinc-500">No libraries yet: add a folder below.</p>}
        {settings.libraries.map((l) => (
          <div key={l.root} className="flex items-center justify-between gap-6 px-4 py-2.5">
            <div className="min-w-0">
              <div className="font-mono text-[12px] text-zinc-100 break-all">{l.root}</div>
              <div className="text-[12px] text-zinc-500">{l.photos.toLocaleString()} photos and videos</div>
            </div>
            <Button onClick={() => takeOff(l.root, l.photos)} disabled={busy || fixed || settings.libraries.length <= 1} danger>
              Take off
            </Button>
          </div>
        ))}
      </Group>
      {!fixed && (
        <Group title="Add a folder">
          <div className="px-4 py-3 flex flex-col gap-2.5">
            <div className="flex gap-2">
              <input
                className={`${input} flex-1 font-mono`}
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="/mnt/photos"
                aria-label="Folder on the server"
              />
              <Button onClick={() => setBrowsing((b) => !b)}>
                <span className="flex items-center gap-1.5">
                  <Folder className="w-3.5 h-3.5" />
                  Browse
                </span>
              </Button>
              <Button primary onClick={() => add(folder.trim())} disabled={busy || !folder.trim()}>
                <span className="flex items-center gap-1.5">
                  <FolderPlus className="w-3.5 h-3.5" />
                  Add
                </span>
              </Button>
            </div>
            {browsing && (
              <FolderBrowser
                start={folder.trim() || null}
                onPick={(path) => {
                  setFolder(path);
                  setBrowsing(false);
                }}
              />
            )}
          </div>
        </Group>
      )}
      {settings.removed.length > 0 && (
        <Group title="Taken off">
          {settings.removed.map((l) => (
            <div key={l.root} className="flex items-center justify-between gap-6 px-4 py-2.5">
              <div className="min-w-0">
                <div className="font-mono text-[12px] text-zinc-400 break-all">{l.root}</div>
                <div className="text-[12px] text-zinc-500">{l.photos.toLocaleString()} photos kept in the database</div>
              </div>
              <Button onClick={() => add(l.root)} disabled={busy || fixed}>
                Add back
              </Button>
            </div>
          ))}
        </Group>
      )}
    </>
  );
}

// The folders on the server, one level at a time (a typed folder that isn't there starts at the top)
function FolderBrowser({ start, onPick }: { start: string | null; onPick: (path: string) => void }) {
  const [list, setList] = useState<FolderList | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function open(path: string | null) {
    try {
      setList(await adminCall<FolderList>("admin_list_folders", { path }));
      setError(null);
    } catch (e) {
      if (path === start && start !== null) return open(null);
      setError(String(e));
    }
  }
  useEffect(() => {
    open(start);
  }, []);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <button
          onClick={() => open(list?.parent ?? null)}
          disabled={!list?.path}
          className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-30"
          aria-label="Up one folder"
          title="Up one folder"
        >
          <ArrowUp className="w-3.5 h-3.5" />
        </button>
        <span className="flex-1 min-w-0 font-mono text-[12px] text-zinc-300 truncate">{list?.path ?? "This server"}</span>
        {list?.path && (
          <Button primary onClick={() => onPick(list.path!)}>
            Use this folder
          </Button>
        )}
      </div>
      {error && <p className="px-3 py-2 text-red-400 text-[12px]">{error}</p>}
      <div className="max-h-56 overflow-y-auto py-1">
        {list?.folders.length === 0 && <p className="px-3 py-2 text-zinc-500 text-[12px]">No folders in here</p>}
        {list?.folders.map((f) => (
          <button
            key={f.path}
            onClick={() => open(f.path)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-200 hover:bg-zinc-800/70"
          >
            <Folder className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            <span className="truncate">{f.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SettingsSection() {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [form, setForm] = useState({ upload_library: "", caption_model: "", ollama_url: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const show = (s: ServerSettings) => {
    setSettings(s);
    setForm({ upload_library: s.upload_library ?? "", caption_model: s.caption_model ?? "", ollama_url: s.ollama_url ?? "" });
  };
  useEffect(() => {
    adminCall<ServerSettings>("admin_get_settings")
      .then(show)
      .catch((e) => setError(String(e)));
    adminCall<ServerStatus>("server_status")
      .then((s) => setModels((s.ollama?.installed_models ?? []).map((m) => m.name)))
      .catch(() => {});
  }, []);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const fixed = (name: string) => settings.fixed.includes(name);
    try {
      show(
        await adminCall<ServerSettings>("admin_save_settings", {
          uploadLibrary: fixed("upload_library") ? null : form.upload_library,
          captionModel: fixed("caption_model") ? null : form.caption_model,
          ollamaUrl: fixed("ollama_url") ? null : form.ollama_url,
        })
      );
      setNotice("Saved. The server uses the new settings from now on.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return error ? <p className="text-red-400">{error}</p> : <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />;
  const fixedNote = (name: string, variable: string) =>
    settings.fixed.includes(name) ? <div className="text-[12px] text-amber-300">Set by {variable} where the server starts</div> : null;
  return (
    <>
      {error && <p className="text-red-400">{error}</p>}
      {notice && <p className="text-emerald-300">{notice}</p>}
      <Group title="Uploads">
        <div className="flex items-center justify-between gap-6 px-4 py-2.5">
          <div>
            <div className="text-zinc-200">Uploads go to</div>
            <div className="text-[12px] text-zinc-500">Into uploads/&lt;name&gt; in that library</div>
            {fixedNote("upload_library", "LUMINA_UPLOAD_LIBRARY")}
          </div>
          <select
            className={select}
            value={form.upload_library}
            disabled={settings.fixed.includes("upload_library")}
            onChange={(e) => setForm({ ...form, upload_library: e.target.value })}
          >
            <option value="">The first library</option>
            {settings.libraries.map((l) => (
              <option key={l.root} value={l.root}>
                {l.root}
              </option>
            ))}
          </select>
        </div>
      </Group>
      <Group title="Captions (Ollama)">
        <div className="flex items-center justify-between gap-6 px-4 py-2.5">
          <div>
            <div className="text-zinc-200">Caption model</div>
            <div className="text-[12px] text-zinc-500">New photos get a caption with it; empty: no captions</div>
            {fixedNote("caption_model", "LUMINA_CAPTION_MODEL")}
          </div>
          <input
            className={`${input} w-64`}
            value={form.caption_model}
            list="admin-ollama-models"
            placeholder="qwen3-vl:8b-instruct"
            disabled={settings.fixed.includes("caption_model")}
            onChange={(e) => setForm({ ...form, caption_model: e.target.value })}
          />
          <datalist id="admin-ollama-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <div className="flex items-center justify-between gap-6 px-4 py-2.5">
          <div>
            <div className="text-zinc-200">Ollama's address</div>
            {fixedNote("ollama_url", "LUMINA_OLLAMA_URL")}
          </div>
          <input
            className={`${input} w-64 font-mono`}
            value={form.ollama_url}
            placeholder="http://127.0.0.1:11434"
            disabled={settings.fixed.includes("ollama_url")}
            onChange={(e) => setForm({ ...form, ollama_url: e.target.value })}
          />
        </div>
      </Group>
      <div className="flex items-center justify-between gap-4">
        <p className="text-[12px] text-zinc-500">The address the server listens on and its data folder are set in lumina-server.toml.</p>
        <Button primary onClick={save} disabled={busy}>
          Save
        </Button>
      </div>
    </>
  );
}
