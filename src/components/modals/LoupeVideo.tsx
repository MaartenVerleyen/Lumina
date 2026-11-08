import { useEffect, useState } from "react";
import { platform } from "../../api/platform";
import { call, mediaUrl, subscribe } from "../../api";
import { Film, Loader2 } from "lucide-react";
import { PhotoItem } from "../../types/lumina";
import { thumbSrc } from "../../utils/photoHelpers";
import { diskPathOf } from "../../utils/rawPairs";
import { isPlayableInBrowser, isPlayableInWebView } from "../../utils/media";

// The Loupe's video: played from the original when the app can, otherwise from a converted copy made on
// request (ffmpeg is downloaded the first time)

type Conversion =
  | { state: "idle" }
  | { state: "downloading"; percent: number; totalMb: number }
  | { state: "converting"; percent: number }
  | { state: "failed"; error: string };

export default function LoupeVideo({ photo }: { photo: PhotoItem }) {
  // The desktop's webview plays what isPlayableInWebView names; in a browser the browser decides. A video of
  // the phone's own (the phone app; its codec isn't read) is one the phone made or received, and plays.
  const direct = photo.path.startsWith("phone:")
    ? true
    : platform.localFiles
    ? isPlayableInWebView(photo)
    : isPlayableInBrowser(photo, (mime) => document.createElement("video").canPlayType(mime));
  // A converted copy made earlier (or just now)
  const [copyPath, setCopyPath] = useState<string | null>(null);
  const [conversion, setConversion] = useState<Conversion>({ state: "idle" });

  useEffect(() => {
    setCopyPath(null);
    setConversion({ state: "idle" });
    if (direct) return;
    let stale = false;
    call<string | null>("existing_playable_copy", { hash: photo.hash })
      .then((p) => {
        if (!stale && p) setCopyPath(p);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [photo.hash, direct]);

  useEffect(() => {
    if (direct) return;
    const offDownload = subscribe<{ percent: number; total_mb: number; done: boolean }>("ffmpeg-download", (e) => {
      if (!e.payload.done) setConversion({ state: "downloading", percent: e.payload.percent, totalMb: e.payload.total_mb });
    });
    const offConvert = subscribe<{ hash: string; percent: number; done: boolean }>("transcode-progress", (e) => {
      if (e.payload.hash === photo.hash && !e.payload.done) setConversion({ state: "converting", percent: e.payload.percent });
    });
    return () => {
      offDownload.then((f) => f());
      offConvert.then((f) => f());
    };
  }, [photo.hash, direct]);

  // Leaving the video (or the Loupe) stops a conversion still running
  useEffect(() => {
    return () => {
      if (!direct) call("cancel_playable_copy").catch(() => {});
    };
  }, [photo.hash, direct]);

  async function convert() {
    setConversion({ state: "converting", percent: 0 });
    try {
      const path = await call<string>("make_playable_copy", { hash: photo.hash });
      setCopyPath(path);
      setConversion({ state: "idle" });
    } catch (err) {
      const msg = String(err);
      setConversion(msg.includes("cancelled") ? { state: "idle" } : { state: "failed", error: msg });
    }
  }

  const src = direct
    ? mediaUrl({ kind: "original", hash: photo.hash, path: photo.path })
    : copyPath
      ? mediaUrl({ kind: "preview", hash: photo.hash, path: copyPath })
      : null;
  if (src) {
    return (
      <video
        key={src}
        data-loupe-video
        src={src}
        poster={photo.thumb_ready ? thumbSrc(photo) : undefined}
        controls
        autoPlay
        onClick={(e) => e.stopPropagation()}
        className="max-w-full max-h-full rounded-xl shadow-2xl bg-black"
      />
    );
  }

  const busy = conversion.state === "downloading" || conversion.state === "converting";
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="relative max-w-full max-h-full flex flex-col items-center justify-center gap-3"
    >
      {photo.thumb_ready ? (
        <img
          src={thumbSrc(photo)}
          alt={photo.name}
          draggable={false}
          className="max-w-full max-h-[60vh] object-contain rounded-xl shadow-2xl opacity-60"
        />
      ) : (
        <Film className="w-16 h-16 text-zinc-700" />
      )}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl px-4 py-3 text-xs text-zinc-300 flex flex-col items-center gap-2.5 min-w-80">
        {busy ? (
          <>
            <span className="flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
              {conversion.state === "downloading"
                ? `Downloading ffmpeg (${Math.round(conversion.totalMb)} MB, once)… ${conversion.percent}%`
                : `Making a playable copy… ${conversion.percent}%`}
            </span>
            <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${conversion.percent}%` }} />
            </div>
            <button
              onClick={() => call("cancel_playable_copy").catch(() => {})}
              className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span>
              {conversion.state === "failed"
                ? conversion.error
                : "This video's format doesn't play inside Lumina. A playable copy can be made (kept in Lumina's cache)."}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={convert}
                className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
              >
                {conversion.state === "failed" ? "Try again" : "Make playable copy"}
              </button>
              {platform.localFiles && (
                <button
                  onClick={() => call("open_in_default_app", { path: diskPathOf(photo) })}
                  className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                >
                  Open in player
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
