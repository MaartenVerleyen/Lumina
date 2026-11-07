import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Cloud, CloudOff, CloudUpload, Download, ExternalLink, FileImage, FolderOpen, Info, Loader2, MapPin, Camera, MoreVertical, Share2, Smartphone, UserRound, X } from "lucide-react";
import { allPhotosCanBackUp, allPhotosSources, call, callLocal, canEditPhoto, mediaUrl, onAndroid, openLibraryIsAll } from "../../api";
import { whereabouts, type Source } from "../../api/allPhotos";
import { useServers } from "../../hooks/useServers";
import { openWith, saveToPhone, serverOf, sharePhotos } from "./share";
import type { FaceInstance, PersonItem, PhotoItem } from "../../types/lumina";
import { formatBytes, thumbSrc } from "../../utils/photoHelpers";
import { isVideo } from "../../utils/media";
import LoupeVideo from "../modals/LoupeVideo";

const MAX_ZOOM = 5;
const DOUBLE_TAP_MS = 280;

// "2024-08-07 14:03:12" -> "7 Aug 2024, 14:03" in the phone's own language
export function capturedLabel(capturedAt: string): string {
  const d = new Date((capturedAt || "").replace(" ", "T").replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const distance = (a: React.Touch, b: React.Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

interface Gesture {
  mode: "none" | "swipe" | "pan" | "pinch";
  startX: number;
  startY: number;
  startTime: number;
  moved: boolean;
  // The zoom and pan when the gesture began
  viewScale: number;
  viewX: number;
  viewY: number;
  startDistance: number;
}

// The phone layout's full-screen viewer: swipe sideways for the next photo, down to close, up for the
// details; pinch or double-tap to zoom. Videos play with the browser's own controls.
export default function PhoneViewer({
  photos,
  index,
  onIndex,
  onClose,
  onPerson,
  onShowFolder,
  people,
  onFaces,
}: {
  photos: PhotoItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onPerson: (name: string) => void;
  // The names to suggest when naming a face, and where a photo's renamed faces go
  people: PersonItem[];
  onFaces: (faces: Record<string, FaceInstance[]>) => void;
  // The phone app: the phone's folder this photo is in (Albums)
  onShowFolder?: (photo: PhotoItem) => void;
}) {
  const photo = photos[index];
  const video = photo ? isVideo(photo) : false;
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [touching, setTouching] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [info, setInfo] = useState(false);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const gesture = useRef<Gesture>({ mode: "none", startX: 0, startY: 0, startTime: 0, moved: false, viewScale: 1, viewX: 0, viewY: 0, startDistance: 0 });
  const lastTap = useRef(0);
  const tapTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 });
    setDrag({ dx: 0, dy: 0 });
    setLoaded(false);
  }, [photo?.hash]);

  // The photos on either side load while this one is looked at
  useEffect(() => {
    for (const i of [index - 1, index + 1]) {
      const p = photos[i];
      if (p && !isVideo(p)) new Image().src = mediaUrl({ kind: "original", hash: p.hash, path: p.path });
    }
  }, [index, photos]);

  const go = (step: number) => {
    const next = index + step;
    if (next >= 0 && next < photos.length) onIndex(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Escape") (info ? setInfo(false) : onClose());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  if (!photo) return null;

  function begin(e: React.TouchEvent) {
    const g = gesture.current;
    const target = e.target as HTMLElement;
    if (target.closest("[data-viewer-chrome]")) {
      g.mode = "none";
      return;
    }
    // Touches on a video's control bar belong to the video (scrubbing, volume)
    const videoEl = target.closest("video");
    if (videoEl) {
      const rect = videoEl.getBoundingClientRect();
      if (e.touches[0].clientY > rect.bottom - Math.max(64, rect.height * 0.3)) {
        g.mode = "none";
        return;
      }
    }
    g.viewScale = view.scale;
    g.viewX = view.x;
    g.viewY = view.y;
    if (e.touches.length === 2 && !video) {
      g.mode = "pinch";
      g.startDistance = distance(e.touches[0], e.touches[1]);
    } else if (e.touches.length === 1) {
      g.mode = view.scale > 1 ? "pan" : "swipe";
      g.startX = e.touches[0].clientX;
      g.startY = e.touches[0].clientY;
      g.startTime = Date.now();
      g.moved = false;
    }
    setTouching(true);
  }

  function move(e: React.TouchEvent) {
    const g = gesture.current;
    if (g.mode === "pinch" && e.touches.length === 2) {
      const scale = Math.min(MAX_ZOOM, Math.max(1, (g.viewScale * distance(e.touches[0], e.touches[1])) / g.startDistance));
      setView({ scale, x: g.viewX, y: g.viewY });
      return;
    }
    if (e.touches.length !== 1 || (g.mode !== "pan" && g.mode !== "swipe")) return;
    const dx = e.touches[0].clientX - g.startX;
    const dy = e.touches[0].clientY - g.startY;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) g.moved = true;
    if (g.mode === "pan") setView({ scale: view.scale, x: g.viewX + dx, y: g.viewY + dy });
    else setDrag({ dx, dy });
  }

  function end(e: React.TouchEvent) {
    const g = gesture.current;
    // One finger lifted from a pinch: the other one pans on from here
    if (e.touches.length === 1 && g.mode === "pinch") {
      g.mode = view.scale > 1 ? "pan" : "none";
      g.startX = e.touches[0].clientX;
      g.startY = e.touches[0].clientY;
      g.viewX = view.x;
      g.viewY = view.y;
      return;
    }
    if (e.touches.length > 0) return;
    setTouching(false);
    const { dx, dy } = drag;
    setDrag({ dx: 0, dy: 0 });
    if (g.mode === "pinch" && view.scale < 1.05) setView({ scale: 1, x: 0, y: 0 });
    if (g.mode === "swipe" && g.moved) {
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      else if (dy > 110 && dy > Math.abs(dx)) onClose();
      else if (dy < -80 && -dy > Math.abs(dx)) setInfo(true);
    } else if ((g.mode === "swipe" || g.mode === "pan") && !g.moved && Date.now() - g.startTime < 300) {
      tap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    g.mode = "none";
  }

  // One tap shows or hides the bars; two zoom in on that spot (or back out)
  function tap(x: number, y: number) {
    const now = Date.now();
    if (!video && now - lastTap.current < DOUBLE_TAP_MS) {
      window.clearTimeout(tapTimer.current);
      lastTap.current = 0;
      if (view.scale > 1) setView({ scale: 1, x: 0, y: 0 });
      else {
        const scale = 2.5;
        setView({ scale, x: (window.innerWidth / 2 - x) * (scale - 1), y: (window.innerHeight / 2 - y) * (scale - 1) });
      }
      return;
    }
    lastTap.current = now;
    window.clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => setChrome((c) => !c), video ? 0 : DOUBLE_TAP_MS);
  }

  const closing = drag.dy > 0 && Math.abs(drag.dy) > Math.abs(drag.dx) ? drag.dy : 0;
  const sideways = Math.abs(drag.dx) >= Math.abs(drag.dy) ? drag.dx : 0;
  const transform =
    view.scale > 1
      ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
      : `translate(${sideways}px, ${closing}px) scale(${1 - Math.min(closing, 300) / 1500})`;
  const rotate = photo.rotation ? { transform: `rotate(${photo.rotation}deg)` } : undefined;

  return (
    <div
      className="fixed inset-0 z-50 bg-black select-none"
      style={{ backgroundColor: `rgba(0,0,0,${1 - Math.min(closing, 300) / 450})`, touchAction: "none" }}
      onTouchStart={begin}
      onTouchMove={move}
      onTouchEnd={end}
      onTouchCancel={end}
    >
      <div
        className="absolute inset-0 grid place-items-center"
        style={{ transform, transition: touching ? "none" : "transform 0.2s ease-out" }}
      >
        {video ? (
          <div className="col-start-1 row-start-1 w-full h-full flex items-center justify-center [&_video]:w-full [&_video]:h-auto [&_video]:max-h-full [&_video]:rounded-none">
            <LoupeVideo key={photo.hash} photo={photo} />
          </div>
        ) : (
          <>
            {photo.thumb_ready && !loaded && (
              <img src={thumbSrc(photo)} alt="" draggable={false} className="col-start-1 row-start-1 w-full h-full object-contain" style={rotate} />
            )}
            <img
              key={photo.hash}
              src={mediaUrl({ kind: "original", hash: photo.hash, path: photo.path })}
              alt={photo.name}
              draggable={false}
              onLoad={() => setLoaded(true)}
              className={`col-start-1 row-start-1 w-full h-full object-contain transition-opacity duration-150 ${loaded ? "opacity-100" : "opacity-0"}`}
              style={rotate}
            />
          </>
        )}
      </div>

      {chrome && (
        <div
          data-viewer-chrome
          className="absolute top-0 inset-x-0 flex items-center gap-2 px-2 pb-6 bg-gradient-to-b from-black/70 to-transparent"
          style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
        >
          <button onClick={onClose} className="p-2 rounded-full text-white active:bg-white/20" aria-label="Back">
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div className="flex-1 min-w-0 text-white">
            <div className="text-sm font-semibold truncate">{capturedLabel(photo.captured_at) || photo.name}</div>
            <div className="text-[11px] text-zinc-300 truncate">
              {index + 1} of {photos.length}
              {photo.location ? ` · ${photo.location}` : ""}
            </div>
          </div>
          {onAndroid && <ShareButton photo={photo} />}
          <button onClick={() => setInfo(true)} className="p-2 rounded-full text-white active:bg-white/20" aria-label="Details">
            <Info className="w-5 h-5" />
          </button>
          {onAndroid && (
            <button onClick={() => setMenu(true)} className="p-2 rounded-full text-white active:bg-white/20" aria-label="More">
              <MoreVertical className="w-5 h-5" />
            </button>
          )}
        </div>
      )}

      {chrome && !info && photos.length > 1 && <Filmstrip photos={photos} index={index} onIndex={onIndex} />}

      {notice && (
        <div data-viewer-chrome className="absolute left-1/2 -translate-x-1/2 bottom-28 max-w-[85%] rounded-full bg-raised/95 border border-zinc-700 px-4 py-2 text-xs text-zinc-100 shadow-lg">
          {notice}
        </div>
      )}

      {info && (
        <Details
          photo={photo}
          onClose={() => setInfo(false)}
          onPerson={onPerson}
          onAction={(what) => void act(what, photo, setNotice)}
          people={people}
          onFaces={onFaces}
        />
      )}
      {menu && (
        <Menu
          photo={photo}
          onClose={() => setMenu(false)}
          onAction={(what) => {
            setMenu(false);
            if (what === "folder") onShowFolder?.(photo);
            else void act(what, photo, setNotice);
          }}
          canShowFolder={!!onShowFolder && photo.path.startsWith("phone:")}
        />
      )}
    </div>
  );
}

type Action = "share" | "save" | "backup" | "open" | "folder";

// Where a photo is, as All photos knows it: on this phone, and which servers
function whereOf(photo: PhotoItem): { phone: boolean; servers: string[]; where: ReturnType<typeof whereabouts> } | null {
  if (!openLibraryIsAll() || !photo.copies) return null;
  const sources = allPhotosSources();
  const found = photo.copies.map((k) => sources.get(k)).filter((x): x is Source => !!x);
  return {
    phone: found.some((x) => x.server === null),
    servers: [...new Set(found.filter((x) => x.server !== null).map((x) => x.server!))],
    where: whereabouts(photo, sources, allPhotosCanBackUp()),
  };
}

async function act(what: Action, photo: PhotoItem, notify: (text: string | null) => void) {
  const say = (text: string) => {
    notify(text);
    window.setTimeout(() => notify(null), 3500);
  };
  try {
    if (what === "share") await sharePhotos([photo]);
    else if (what === "open") await openWith(photo);
    else if (what === "save") {
      say("Downloading to this phone…");
      const n = await saveToPhone([photo]);
      say(n > 0 ? "Saved to this phone (Pictures/Lumina)" : "Nothing to save");
    } else if (what === "backup") {
      await callLocal("phone_backup_selected", { hashes: [photo.hash] });
      say("Backing up…");
    }
  } catch (e) {
    say(String(e));
  }
}

// ⋮: what can be done with this photo here
function Menu({ photo, onClose, onAction, canShowFolder }: { photo: PhotoItem; onClose: () => void; onAction: (what: Action) => void; canShowFolder: boolean }) {
  const where = whereOf(photo);
  const items: { what: Action; label: string; icon: typeof Share2 }[] = [
    { what: "share", label: "Share", icon: Share2 },
    ...(serverOf(photo) && !where?.phone ? [{ what: "save" as const, label: "Download to this phone", icon: Download }] : []),
    ...(where?.where === "not-backed-up" ? [{ what: "backup" as const, label: "Back up now", icon: CloudUpload }] : []),
    { what: "open", label: "Open with…", icon: ExternalLink },
    ...(canShowFolder ? [{ what: "folder" as const, label: "Show in its folder", icon: FolderOpen }] : []),
  ];
  return (
    <div data-viewer-chrome className="absolute inset-0 z-10" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute right-2 min-w-[210px] rounded-2xl bg-raised border border-zinc-700/80 py-1.5 shadow-2xl"
        style={{ top: "calc(env(safe-area-inset-top) + 3.5rem)" }}
      >
        {items.map(({ what, label, icon: Icon }) => (
          <button key={what} onClick={() => onAction(what)} className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm text-zinc-100 active:bg-white/10">
            <Icon className="w-[18px] h-[18px] text-zinc-400" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// The photos around this one, to jump to
function Filmstrip({ photos, index, onIndex }: { photos: PhotoItem[]; index: number; onIndex: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const from = Math.max(0, index - 40);
  const shown = photos.slice(from, index + 41);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>("[data-current]");
    el?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [index]);
  return (
    <div
      data-viewer-chrome
      ref={ref}
      className="absolute bottom-0 inset-x-0 flex gap-1 overflow-x-auto px-[45%] pt-6 bg-gradient-to-t from-black/70 to-transparent [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
    >
      {shown.map((p, k) => {
        const i = from + k;
        return (
          <button
            key={p.hash}
            data-current={i === index ? "" : undefined}
            onClick={() => onIndex(i)}
            className={`shrink-0 overflow-hidden rounded transition-all ${i === index ? "w-12 h-14 ring-2 ring-white" : "w-9 h-14 opacity-70"}`}
          >
            {p.thumb_ready && <img src={thumbSrc(p)} alt="" draggable={false} className="w-full h-full object-cover" />}
          </button>
        );
      })}
    </div>
  );
}

// The phone app: the photo to another app (Android's share sheet)
function ShareButton({ photo }: { photo: PhotoItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const share = async () => {
    setBusy(true);
    setError(null);
    try {
      await sharePhotos([photo]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error && <span className="text-[11px] text-red-300 max-w-[40vw] truncate" title={error}>{error}</span>}
      <button onClick={share} disabled={busy} className="p-2 rounded-full text-white active:bg-white/20" aria-label="Share">
        {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Share2 className="w-5 h-5" />}
      </button>
    </>
  );
}

function Details({
  photo,
  onClose,
  onPerson,
  onAction,
  people,
  onFaces,
}: {
  photo: PhotoItem;
  onClose: () => void;
  onPerson: (name: string) => void;
  onAction: (what: Action) => void;
  people: PersonItem[];
  onFaces: (faces: Record<string, FaceInstance[]>) => void;
}) {
  const { servers } = useServers();
  const [naming, setNaming] = useState<FaceInstance | null>(null);
  const where = whereOf(photo);
  const labelOf = (id: string) => servers.find((x) => x.id === id)?.label ?? id;
  const faces = (photo.faces ?? []).filter((f) => f.face_thumb);
  // Where the account may change the photo, every face shows and a tap names it; elsewhere only the named ones
  const canName = canEditPhoto(photo.hash);
  const shownFaces = canName ? faces : faces.filter((f) => f.person_name);
  if (naming) {
    return (
      <FaceSheet
        faceIds={[naming.face_id]}
        thumb={naming.face_thumb}
        current={naming.person_name ?? ""}
        people={people}
        onClose={() => setNaming(null)}
        onPerson={onPerson}
        onDone={(changed) => {
          onFaces(changed);
          setNaming(null);
        }}
      />
    );
  }
  const aperture = photo.aperture ? `f/${String(photo.aperture).replace(/^f\//, "")}` : "";
  // A phone's lens name often holds the aperture already ("5.96mm f/1.6")
  const exposure = [aperture && !(photo.lens_model ?? "").includes(aperture) && aperture, photo.shutter_speed, photo.iso && `ISO ${String(photo.iso).replace(/^ISO\s*/i, "")}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div data-viewer-chrome className="absolute inset-0 flex flex-col justify-end" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[70%] overflow-y-auto rounded-t-2xl bg-raised border-t border-zinc-700/80 px-4 pt-3 text-sm text-zinc-200"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="font-semibold text-zinc-100 truncate">{photo.name}</div>
            <div className="text-xs text-zinc-400">
              {capturedLabel(photo.captured_at) || "No date"}
              {photo.width > 0 && ` · ${photo.width} × ${photo.height}`}
            </div>
          </div>
          <button onClick={onClose} className="p-2 -mr-2 rounded-full text-zinc-400 active:bg-white/10" aria-label="Close details">
            <X className="w-5 h-5" />
          </button>
        </div>
        {where && (
          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
            {where.where === "not-backed-up" ? (
              <CloudOff className="w-4 h-4 text-amber-400 shrink-0" />
            ) : where.phone ? (
              <Smartphone className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <Cloud className="w-4 h-4 text-sky-400 shrink-0" />
            )}
            <span className="flex-1">
              {where.phone && where.servers.length > 0
                ? `On this phone and on ${where.servers.map(labelOf).join(", ")}`
                : where.phone
                  ? "Only on this phone"
                  : `Only on ${where.servers.map(labelOf).join(", ")}`}
            </span>
            {onAndroid && where.where === "not-backed-up" && (
              <button onClick={() => onAction("backup")} className="px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-200 active:bg-amber-500/30">
                Back up now
              </button>
            )}
            {onAndroid && !where.phone && (
              <button onClick={() => onAction("save")} className="px-2.5 py-1 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-200 active:bg-zinc-700">
                Download
              </button>
            )}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
          <FileImage className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="truncate">
            {[photo.name, photo.size_kb > 0 ? formatBytes(photo.size_kb * 1024) : "", photo.width > 0 ? `${((photo.width * photo.height) / 1e6).toFixed(1)} MP` : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        {photo.location && (
          <div className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
            <MapPin className="w-4 h-4 text-emerald-400 shrink-0" />
            {photo.location}
          </div>
        )}
        {(photo.camera_model || exposure) && (
          <div className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
            <Camera className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{[photo.camera_model, photo.lens_model, exposure].filter(Boolean).join(" · ")}</span>
          </div>
        )}
        {shownFaces.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">People</div>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {shownFaces.map((f) => (
                <button
                  key={f.face_id}
                  onClick={() => (canName ? setNaming(f) : onPerson(f.person_name!))}
                  className="shrink-0 flex flex-col items-center gap-1 w-14"
                >
                  <img
                    src={mediaUrl({ kind: "face", path: f.face_thumb })}
                    alt=""
                    className={`w-12 h-12 rounded-full object-cover bg-zinc-800 ${f.person_name ? "" : "ring-2 ring-amber-400/70"}`}
                  />
                  <span className={`text-[11px] truncate w-full text-center ${f.person_name ? "text-zinc-300" : "text-amber-300"}`}>
                    {f.person_name || "Who's this?"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!shownFaces.some((f) => f.person_name) && photo.people.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1.5">People</div>
            <div className="flex flex-wrap gap-1.5">
              {photo.people.map((name) => (
                <button
                  key={name}
                  onClick={() => onPerson(name)}
                  className="px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-200 active:bg-emerald-500/30"
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}
        {photo.ai_caption && (
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Caption</div>
            <p className="text-xs leading-relaxed text-zinc-300 select-text">{photo.ai_caption}</p>
          </div>
        )}
        {photo.tags.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1.5">Tags</div>
            <div className="flex flex-wrap gap-1.5">
              {photo.tags.map((t) => (
                <span key={t} className="px-2 py-0.5 rounded-full bg-zinc-800 text-[11px] text-zinc-300">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Faces of one person (a face of a photo, or a group the server found): give them a name (typed, or one of the
// people already known), change it, or take it off
export function FaceSheet({
  faceIds,
  thumb,
  current,
  title,
  people,
  onClose,
  onPerson,
  onDone,
}: {
  faceIds: string[];
  thumb: string;
  current: string;
  // In place of "Who's this?" (a group: "12 faces")
  title?: string;
  people: PersonItem[];
  onClose: () => void;
  onPerson?: (name: string) => void;
  onDone: (faces: Record<string, FaceInstance[]>) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = text.trim().toLowerCase();
  // The people in the most photos first; while typing, the names that start with it before those that contain it
  const suggestions = people
    .filter((p) => !p.hidden && p.name.toLowerCase() !== current.toLowerCase() && (!typed || p.name.toLowerCase().includes(typed)))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(typed)) - Number(a.name.toLowerCase().startsWith(typed)) || b.photo_count - a.photo_count)
    .slice(0, 8);
  const isNew = typed !== "" && !people.some((p) => p.name.toLowerCase() === typed);

  const run = async (command: string, personName: string) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await call<Record<string, FaceInstance[]>>(command, { faceIds, personName }));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  const name = (personName: string) => void run("assign_faces_to_person_batch", personName.trim());

  return (
    <div data-viewer-chrome className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80%] overflow-y-auto rounded-t-2xl bg-raised border-t border-zinc-700/80 px-4 pt-4 text-sm text-zinc-200"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
      >
        <div className="flex items-center gap-3">
          <img src={mediaUrl({ kind: "face", path: thumb })} alt="" className="w-14 h-14 rounded-full object-cover bg-zinc-800" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-zinc-100 truncate">{current || title || "Who's this?"}</div>
            {current && onPerson && (
              <button onClick={() => onPerson(current)} className="text-xs text-emerald-400 active:text-emerald-300">
                All photos of {current}
              </button>
            )}
          </div>
          <button onClick={onClose} className="p-2 -mr-2 rounded-full text-zinc-400 active:bg-white/10" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) name(text);
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={current ? "Someone else? Type their name" : "Type a name"}
            autoCapitalize="words"
            autoComplete="off"
            enterKeyHint="done"
            className="flex-1 min-w-0 rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2.5 text-base text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className="px-4 rounded-xl bg-emerald-600 text-white font-medium disabled:opacity-40 active:bg-emerald-700"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
          </button>
        </form>
        {isNew && <div className="mt-1.5 text-xs text-zinc-500">{text.trim()} is someone new: saving adds them to People.</div>}

        {suggestions.length > 0 && (
          <div className="mt-3 flex flex-col">
            {suggestions.map((p) => (
              <button
                key={p.name}
                disabled={busy}
                onClick={() => name(p.name)}
                className="flex items-center gap-3 py-2 text-left active:bg-white/5 rounded-lg"
              >
                {p.cover_thumb ? (
                  <img src={mediaUrl({ kind: "face", path: p.cover_thumb })} alt="" className="w-9 h-9 rounded-full object-cover bg-zinc-800" />
                ) : (
                  <span className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center">
                    <UserRound className="w-4 h-4 text-zinc-500" />
                  </span>
                )}
                <span className="flex-1 truncate text-zinc-100">{p.name}</span>
                <span className="text-xs text-zinc-500">{p.photo_count}</span>
              </button>
            ))}
          </div>
        )}

        {current && (
          <button
            disabled={busy}
            onClick={() => void run("unassign_faces_batch", current)}
            className="mt-4 w-full py-2.5 rounded-xl border border-zinc-700 text-zinc-300 active:bg-white/5"
          >
            This isn't {current}
          </button>
        )}
        {error && <div className="mt-3 text-xs text-red-300">{error}</div>}
      </div>
    </div>
  );
}
