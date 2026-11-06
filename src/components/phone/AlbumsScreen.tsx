import { useEffect, useMemo, useState } from "react";
import { BellRing, CloudCheck, CloudOff, Eye, Plus, Sparkles } from "lucide-react";
import { callLocal, mediaUrl, onAndroid } from "../../api";
import type { LibraryState } from "../../hooks/useLibraryState";
import { useServers } from "../../hooks/useServers";
import type { PhotoItem } from "../../types/lumina";
import { thumbSrc } from "../../utils/photoHelpers";
import { orderFolders } from "./BackupScreen";
import { setBackupSettings, usePhoneBackup } from "./usePhoneBackup";
import { usePhoneFolders, type PhoneFolder } from "./usePhoneFolders";

// The phone app's Albums tab (docs/plans/android-app-ui.md): the server's albums, trips and events, and the
// phone's own folders with whether each is backed up

export default function AlbumsScreen({
  lib,
  onOpened,
  onOpenFolder,
}: {
  lib: LibraryState;
  onOpened: () => void;
  onOpenFolder: (folder: PhoneFolder) => void;
}) {
  const { servers } = useServers();
  const { settings, status } = usePhoneBackup();
  const folders = usePhoneFolders(settings?.server ?? null, status?.backed_up);
  const byHash = useMemo(() => new Map(lib.photos.map((p) => [p.hash, p])), [lib.photos]);
  const albums = lib.albums.filter((a) => (lib.albumCounts.get(a.id) ?? 0) > 0);
  const trips = lib.autoEvents;
  const open = (go: () => void) => {
    lib.clearAllFilters();
    go();
    onOpened();
  };
  // The albums under a heading per server ("On cachy")
  const byServer = [...new Set(albums.map((a) => a.engine ?? ""))].map((engine) => ({
    label: servers.find((x) => x.id === engine)?.label ?? (engine || "this phone"),
    albums: albums.filter((a) => (a.engine ?? "") === engine),
  }));
  // Albums shared with you followed onto this phone (their photos come into Pictures/Lumina/<album>)
  const [follows, setFollows] = useState<PhoneFollow[]>([]);
  const loadFollows = () =>
    callLocal<PhoneFollow[]>("album_follows")
      .then((list) => setFollows(list.filter((f) => f.folder.startsWith("phone:"))))
      .catch(() => {});
  // Again every few seconds while shown: the photos of a follow come in the background
  useEffect(() => {
    if (!onAndroid) return;
    void loadFollows();
    const timer = window.setInterval(loadFollows, 5000);
    return () => window.clearInterval(timer);
  }, []);
  const followOf = (engine?: string, id?: number) => follows.find((f) => f.server === engine && f.album_id === id);
  const toggleFollow = async (engine: string, id: number, name: string) => {
    if (followOf(engine, id)) await callLocal("phone_unfollow_album", { server: engine, albumId: id });
    else await callLocal("phone_follow_album", { server: engine, albumId: id, albumName: name });
    await loadFollows();
  };

  const toggleBackup = (folder: string, on: boolean) => {
    if (!settings) return;
    const set = new Set(settings.folders);
    if (on) set.add(folder);
    else set.delete(folder);
    const updated = { ...settings, folders: [...set] };
    setBackupSettings(updated);
    void callLocal("set_phone_backup", { settings: updated }).catch(() => {});
  };

  return (
    <div className="flex-1 overflow-y-auto overscroll-contain pb-6">
      {byServer.map((group) => (
        <div key={group.label}>
          <Heading>On {group.label}</Heading>
          <div className="grid grid-cols-2 min-[520px]:grid-cols-3 gap-3 px-3">
            {group.albums.map((a) => {
              const followed = followOf(a.engine, a.realId);
              return (
                <div key={a.id}>
                  <Card
                    cover={byHash.get(a.hashes[0])}
                    title={a.name}
                    subtitle={`${(lib.albumCounts.get(a.id) ?? 0).toLocaleString()}${a.readOnly ? " · shared with you" : ""}`}
                    badge={a.dynamic ? <Sparkles className="w-3.5 h-3.5 text-indigo-300" /> : a.readOnly ? <Eye className="w-3.5 h-3.5 text-violet-300" /> : null}
                    onClick={() => open(() => lib.setActiveAlbumId(a.id))}
                  />
                  {onAndroid && a.readOnly && a.engine && a.realId !== undefined && (
                    <button
                      onClick={() => void toggleFollow(a.engine!, a.realId!, a.name)}
                      className={`mt-1 w-full flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] border ${
                        followed ? "border-emerald-600/50 text-emerald-300" : "border-zinc-700 text-zinc-300"
                      }`}
                    >
                      {followed ? <BellRing className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                      {followed ? `Following · ${followed.photos.toLocaleString()} on this phone` : "Follow onto this phone"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {trips.length > 0 && (
        <>
          <Heading>Trips and events</Heading>
          <div className="flex gap-3 overflow-x-auto px-3 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {trips.map((t) => (
              <div key={t.id} className="w-36 shrink-0">
                <Card
                  cover={undefined}
                  coverHash={lib.trips.find((x) => x.id === t.id)?.hashes[0]}
                  byHash={byHash}
                  title={t.label}
                  subtitle={t.count.toLocaleString()}
                  onClick={() => open(() => lib.setActiveEvent(t.id))}
                />
              </div>
            ))}
          </div>
        </>
      )}
      {onAndroid && folders && folders.length > 0 && settings && (
        <>
          <Heading>On this phone</Heading>
          <div className="grid grid-cols-2 min-[520px]:grid-cols-3 gap-3 px-3">
            {orderFolders(folders, settings.folders).map((f) => {
              const on = settings.folders.includes(f.folder);
              const all = f.backed_up >= f.count;
              return (
                <div key={f.folder}>
                  <Card
                    coverUrl={mediaUrl({ kind: "thumb", hash: "", path: f.cover })}
                    title={f.name}
                    subtitle={f.count.toLocaleString()}
                    onClick={() => onOpenFolder(f)}
                  />
                  <button
                    onClick={() => toggleBackup(f.folder, !on)}
                    className={`mt-1 w-full flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] border ${
                      on ? (all ? "border-emerald-600/50 text-emerald-300" : "border-sky-600/50 text-sky-300") : "border-zinc-700 text-zinc-400"
                    }`}
                  >
                    {on ? <CloudCheck className="w-3.5 h-3.5" /> : <CloudOff className="w-3.5 h-3.5" />}
                    {on ? (all ? "Backed up" : `Backing up · ${(f.count - f.backed_up).toLocaleString()} to go`) : "Not backed up"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
      {albums.length === 0 && trips.length === 0 && !(folders && folders.length > 0) && (
        <div className="p-8 text-center text-sm text-zinc-400">No albums yet.</div>
      )}
    </div>
  );
}

interface PhoneFollow {
  server: string;
  album_id: number;
  album_name: string;
  folder: string;
  photos: number;
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="px-4 pt-5 pb-2 text-sm font-semibold text-zinc-100">{children}</h2>;
}

function Card({
  cover,
  coverHash,
  coverUrl,
  byHash,
  title,
  subtitle,
  badge,
  onClick,
}: {
  cover?: PhotoItem;
  coverHash?: string | null;
  coverUrl?: string;
  byHash?: Map<string, PhotoItem>;
  title: string;
  subtitle: string;
  badge?: React.ReactNode;
  onClick: () => void;
}) {
  const photo = cover ?? (coverHash && byHash ? byHash.get(coverHash) : undefined);
  const src = coverUrl ?? (photo?.thumb_ready ? thumbSrc(photo) : null);
  return (
    <button onClick={onClick} className="w-full text-left active:opacity-70">
      <div className="relative aspect-square rounded-xl overflow-hidden bg-zinc-800">
        {src && <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" />}
        {badge && <span className="absolute top-1.5 right-1.5 rounded-full bg-zinc-950/80 p-1">{badge}</span>}
      </div>
      <div className="pt-1.5 text-sm text-zinc-100 truncate">{title}</div>
      <div className="text-[11px] text-zinc-500 truncate">{subtitle}</div>
    </button>
  );
}
