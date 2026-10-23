import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import luminaMark from "../../assets/lumina-mark.svg";
import { Loader2 } from "lucide-react";

interface SplashScreenProps {
  isReady: boolean;
  onFinish?: () => void;
}

export default function SplashScreen({ isReady, onFinish }: SplashScreenProps) {
  const [fading, setFading] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Show the Tauri native window immediately once the HTML/React runtime is running
    getCurrentWindow().show().catch(() => {});
  }, []);

  useEffect(() => {
    if (isReady && !hidden) {
      setFading(true);
      const timer = setTimeout(() => {
        setHidden(true);
        onFinish?.();
      }, 500); // 500ms smooth fade transition
      return () => clearTimeout(timer);
    }
  }, [isReady, hidden, onFinish]);

  if (hidden) return null;

  return (
    <div
      className={`fixed inset-0 z-[99999] bg-[#090a0f] flex flex-col items-center justify-center select-none transition-opacity duration-500 ${
        fading ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      <div className="flex flex-col items-center gap-4 animate-in fade-in zoom-in-95 duration-300">
        <div className="relative">
          <img
            src={luminaMark}
            alt="Lumina"
            className="w-20 h-20 object-contain drop-shadow-[0_0_25px_rgba(16,185,129,0.35)]"
          />
          <div className="absolute -inset-2 rounded-full border border-emerald-500/20 animate-ping pointer-events-none" />
        </div>

        <div className="flex flex-col items-center">
          <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            Lumina <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 font-mono">v3.6</span>
          </h1>
          <p className="text-xs text-zinc-400 mt-1">Local AI Photo Culling & Organizer</p>
        </div>

        <div className="flex items-center gap-2 mt-6 text-xs text-zinc-500 font-mono">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
          <span>Initializing Library & Neural Engines...</span>
        </div>
      </div>
    </div>
  );
}