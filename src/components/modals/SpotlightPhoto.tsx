import { useEffect, useRef, useState } from "react";
import { mediaUrl } from "../../api";
import type { SimilarFaceCandidate } from "../../types/lumina";
import { VIDEO_NAME } from "../../utils/media";

// A face found in a video carries its frame in its id ("{hash}_f{frame}_{x}_{y}")
export function isVideoFace(cand: SimilarFaceCandidate): boolean {
  return /_f\d+_/.test(cand.face_id) || VIDEO_NAME.test(cand.photo_name);
}

// Face review's One by one: the photo a face is in, with the face marked. The thumbnail shows at once and the
// full image takes over once it has loaded (large originals take a while); the face box waits for a picture,
// and the next photos load ahead. A video can't be shown as a picture: its face crop is shown large instead.
export default function SpotlightPhoto({
  cand,
  upcoming,
  label,
}: {
  cand: SimilarFaceCandidate;
  upcoming: SimilarFaceCandidate[];
  label: string;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Width / height of the photo, from whichever image loads first
  const [ratio, setRatio] = useState<number | null>(null);
  const [fullLoaded, setFullLoaded] = useState(false);
  const video = isVideoFace(cand);
  const full = mediaUrl({ kind: "original", hash: cand.hash, path: cand.photo_path });
  const thumb = mediaUrl({ kind: "thumb", hash: cand.hash, path: cand.photo_path });

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setRatio(null);
    setFullLoaded(false);
    if (video) return;
    const img = new Image();
    img.onload = () => {
      setRatio(img.naturalWidth / img.naturalHeight);
      setFullLoaded(true);
    };
    img.src = full;
    return () => {
      img.onload = null;
    };
  }, [cand.face_id, full, video]);

  // The next photos load in the background, so Y/N moves on without waiting
  useEffect(() => {
    const ahead = upcoming.filter((c) => !isVideoFace(c)).map((c) => {
      const img = new Image();
      img.src = mediaUrl({ kind: "original", hash: c.hash, path: c.photo_path });
      return img;
    });
    return () => ahead.forEach((img) => (img.src = ""));
  }, [upcoming.map((c) => c.face_id).join("|")]);

  // The largest box of the photo's shape that fits the area
  const fit =
    ratio && size.w > 0 && size.h > 0
      ? size.w / size.h > ratio
        ? { w: size.h * ratio, h: size.h }
        : { w: size.w, h: size.w / ratio }
      : null;

  return (
    <div ref={area} className="w-full h-full flex items-center justify-center">
      {video ? (
        <div className="flex flex-col items-center gap-3">
          <img
            src={mediaUrl({ kind: "face", path: cand.face_thumb })}
            alt={cand.photo_name}
            className="w-72 h-72 rounded-2xl object-cover border-2 border-emerald-400"
          />
          <span className="text-xs text-zinc-400">A face in the video {cand.photo_name}</span>
        </div>
      ) : (
        <div className="relative" style={fit ? { width: fit.w, height: fit.h } : { width: 0, height: 0 }}>
          <img
            src={fullLoaded ? full : thumb}
            alt={cand.photo_name}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (!fullLoaded && img.naturalHeight > 0) setRatio((r) => r ?? img.naturalWidth / img.naturalHeight);
            }}
            className={`absolute inset-0 w-full h-full object-contain rounded-lg select-none ${fullLoaded ? "" : "blur-[1px]"}`}
          />
          {fit && (
            <div
              style={{
                left: `${cand.bbox_x * 100}%`,
                top: `${cand.bbox_y * 100}%`,
                width: `${cand.bbox_w * 100}%`,
                height: `${cand.bbox_h * 100}%`,
              }}
              className="absolute rounded-md border-2 border-emerald-400 bg-emerald-500/20 pointer-events-none"
            >
              <span className="absolute -top-6 left-0 px-2 py-0.5 rounded bg-emerald-600 text-white text-[11px] font-semibold whitespace-nowrap shadow">
                {label}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
