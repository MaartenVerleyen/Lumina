import { useEffect, useRef, useState } from "react";
import { LogOut, Server, Smartphone, UserRound } from "lucide-react";
import { OPEN_ADMIN_EVENT } from "../../api";
import { useAccount } from "./ServerGate";
import { usePhoneLayout } from "../../app/usePhoneLayout";

const ROLE_LABEL: Record<string, string> = {
  guest: "Guest: sees what is shared with them",
  viewer: "Viewer: can look and search",
  uploader: "Uploader: can look and search",
  editor: "Editor: can rate, tag and name",
  admin: "Admin: can do everything",
};

// The web client's account button: who is logged in, their role, and Log out. Nothing in the desktop app.
export function AccountMenu() {
  const account = useAccount();
  const layout = usePhoneLayout();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  if (!account) return null;
  const { user, logout } = account;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 border border-zinc-800 text-xs transition"
        title={`Logged in as ${user.name}`}
      >
        <UserRound className="w-3.5 h-3.5 text-emerald-400" />
        <span className="hidden md:inline max-w-[8rem] truncate">{user.name}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-56 bg-raised border border-zinc-700/80 rounded-xl shadow-2xl p-1.5 z-50 text-xs">
          <div className="px-2.5 py-2">
            <div className="font-semibold text-zinc-100 truncate">{user.name}</div>
            <div className="text-[11px] text-zinc-500">{ROLE_LABEL[user.role] ?? user.role}</div>
          </div>
          <div className="h-[1px] bg-zinc-800/80 my-1" />
          {user.role === "admin" && (
            <button
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new Event(OPEN_ADMIN_EVENT));
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
            >
              <Server className="w-4 h-4 text-zinc-400 shrink-0" />
              <span>Server admin…</span>
            </button>
          )}
          {layout.phoneScreen && (
            <button
              onClick={() => layout.setPreferFull(false)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
            >
              <Smartphone className="w-4 h-4 text-zinc-400 shrink-0" />
              <span>Phone layout</span>
            </button>
          )}
          <button
            onClick={logout}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
          >
            <LogOut className="w-4 h-4 text-zinc-400 shrink-0" />
            <span>Log out</span>
          </button>
        </div>
      )}
    </div>
  );
}
