import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Info, Loader2, MapPin, Camera, Share2, X } from "lucide-react";
import { callLocal, mediaUrl, onAndroid, openLibraryServer } from "../../api";
import type { PhotoItem } from "../../types/lumina";
import { thumbSrc } from "../../utils/photoHelpers";
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
export default function MobileViewer({
  photos,
  index,
  onIndex,
  onClose,
  onPerson,
}: {
  photos: PhotoItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onPerson: (name: string) => void;
}) {
  const photo = photos[index];
  const video = photo ? isVideo(photo) : false;
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [touching, setTouching] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [info, setInfo] = useState(false);
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
          {onAndroid && openLibraryServer() && <ShareButton hash={photo.hash} />}
          <button onClick={() => setInfo(true)} className="p-2 rounded-full text-white active:bg-white/20" aria-label="Details">
            <Info className="w-5 h-5" />
          </button>
        </div>
      )}

      {info && <Details photo={photo} onClose={() => setInfo(false)} onPerson={onPerson} />}
    </div>
  );
}

// The phone app: the photo's original to another app (downloaded first, then Android's share sheet)
function ShareButton({ hash }: { hash: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const share = async () => {
    setBusy(true);
    setError(null);
    try {
      await callLocal("share_photo", { server: openLibraryServer(), hash });
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

function Details({ photo, onClose, onPerson }: { photo: PhotoItem; onClose: () => void; onPerson: (name: string) => void }) {
  const exposure = [photo.aperture && `f/${String(photo.aperture).replace(/^f\//, "")}`, photo.shutter_speed, photo.iso && `ISO ${String(photo.iso).replace(/^ISO\s*/i, "")}`]
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
        {photo.location && (
          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
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
        {photo.people.length > 0 && (
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
