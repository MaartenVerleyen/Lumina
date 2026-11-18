import { useEffect, useMemo, useState } from "react";
import { BellRing, CloudCheck, CloudOff, Eye, Plus, Sparkles } from "lucide-react";
import { callLocal, mediaUrl, onAndroid } from "../../api";
import type { LibraryState } from "../../hooks/useLibraryState";
import { useServers } from "../../hooks/useServers";
import type { PhotoItem } from "../../types/lumina";
import { thumbSrc } from "../../utils/photoHelpers";
import { orderFolders } from "./BackupScreen";
import { Card as PhotoCard, photoCount, SectionTitle } from "./PhoneParts";
import { setBackupSettings, usePhoneBackup } from "./usePhoneBackup";
import { usePhoneFolders } from "./usePhoneFolders";
import type { Scope } from "./navigation";

// The phone app's Albums tab (docs/plans/android-app-ui.md): the server's albums, and the
// phone's own folders with whether each is backed up

export default function AlbumsScreen({ lib, onOpen }: { lib: LibraryState; onOpen: (title: string, scope: Scope) => void }) {
  const { servers } = useServers();
  const { settings, status } = usePhoneBackup();
  const folders = usePhoneFolders(settings?.server ?? null, status?.backed_up);
  const byHash = useMemo(() => new Map(lib.photos.map((p) => [p.hash, p])), [lib.photos]);
  const albums = lib.albums.filter((a) => (lib.albumCounts.get(a.id) ?? 0) > 0);
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
          <SectionTitle>On {group.label}</SectionTitle>
          <div className="grid grid-cols-2 min-[520px]:grid-cols-3 gap-3 px-4">
            {group.albums.map((a) => {
              const followed = followOf(a.engine, a.realId);
              return (
                <div key={a.id}>
                  <Card
                    cover={byHash.get(a.hashes[0])}
                    title={a.name}
                    subtitle={`${photoCount(lib.albumCounts.get(a.id) ?? 0)}${a.readOnly ? " · shared with you" : ""}`}
                    badge={a.dynamic ? <Sparkles className="w-3.5 h-3.5 text-indigo-300" /> : a.readOnly ? <Eye className="w-3.5 h-3.5 text-violet-300" /> : null}
                    onClick={() => onOpen(a.name, { album: a.id })}
                  />
                  {onAndroid && a.readOnly && a.engine && a.realId !== undefined && (
                    <button
                      onClick={() => void toggleFollow(a.engine!, a.realId!, a.name)}
                      className={`mt-1.5 w-full min-h-11 flex items-center justify-center gap-1.5 rounded-full px-3 text-[13px] ${
                        followed ? "bg-emerald-900/50 text-emerald-200" : "bg-zinc-800 text-zinc-100"
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
      {onAndroid && folders && folders.length > 0 && settings && (
        <>
          <SectionTitle>On this phone</SectionTitle>
          <div className="grid grid-cols-2 min-[520px]:grid-cols-3 gap-3 px-4">
            {orderFolders(folders, settings.folders).map((f) => {
              const on = settings.folders.includes(f.folder);
              const all = f.backed_up >= f.count;
              return (
                <div key={f.folder}>
                  <Card
                    coverUrl={mediaUrl({ kind: "thumb", hash: "", path: f.cover })}
                    title={f.name}
                    subtitle={photoCount(f.count)}
                    onClick={() => onOpen(f.name, { folder: f.name, hashes: f.hashes })}
                  />
                  <button
                    onClick={() => toggleBackup(f.folder, !on)}
                    className={`mt-1.5 w-full min-h-11 flex items-center justify-center gap-1.5 rounded-full px-3 text-[13px] ${
                      on ? (all ? "bg-emerald-900/50 text-emerald-200" : "bg-sky-900/50 text-sky-200") : "bg-zinc-800 text-zinc-300"
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
      {albums.length === 0 && !(folders && folders.length > 0) && (
        <div className="p-8 text-center text-[15px] text-zinc-400">No albums yet.</div>
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
  return <PhotoCard src={src} title={title} sub={subtitle} badge={badge} onClick={onClick} />;
}
