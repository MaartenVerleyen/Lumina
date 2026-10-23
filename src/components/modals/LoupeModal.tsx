import { convertFileSrc } from "@tauri-apps/api/core";
import { PhotoItem } from "../../types/lumina";
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  RotateCcw as RotateLeft,
  RotateCw,
  Sparkles,
  Star,
  X,
  XCircle,
} from "lucide-react";

interface LoupeModalProps {
  isOpen: boolean;
  onClose: () => void;
  activePhoto: PhotoItem | null;
  autoAdvance: boolean;
  navigateByOffset: (offset: number, extendSelection: boolean) => void;
  handleSetFlag: (flag: "pick" | "reject" | null) => Promise<void>;
  handleBatchStageMove: (targetSub: string | null) => Promise<void>;
  handleBatchRate: (rating: number) => Promise<void>;
  handleRotateSelection: (deltaDegrees: number) => Promise<void>;
  handleAiAnalyzeSingle: () => Promise<void>;
}

export default function LoupeModal({
  isOpen,
  onClose,
  activePhoto,
  autoAdvance,
  navigateByOffset,
  handleSetFlag,
  handleBatchStageMove,
  handleBatchRate,
  handleRotateSelection,
  handleAiAnalyzeSingle,
}: LoupeModalProps) {
  if (!isOpen || !activePhoto) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9999] bg-black/95 backdrop-blur-md flex items-center justify-center p-8 select-none"
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          navigateByOffset(-1, false);
        }}
        className="absolute left-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/60 transition shadow-xl"
        title="Previous (Left Arrow)"
      >
        <ChevronLeft className="w-6 h-6" />
      </button>

      <img
        onClick={(e) => e.stopPropagation()}
        src={convertFileSrc(activePhoto.path)}
        alt={activePhoto.name}
        style={{ transform: `rotate(${activePhoto.rotation}deg)` }}
        className="max-w-full max-h-full object-contain rounded-xl shadow-2xl transition-transform duration-150"
      />

      <button
        onClick={(e) => {
          e.stopPropagation();
          navigateByOffset(1, false);
        }}
        className="absolute right-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/60 transition shadow-xl"
        title="Next (Right Arrow)"
      >
        <ChevronRight className="w-6 h-6" />
      </button>

      <button
        onClick={onClose}
        className="absolute top-6 right-6 p-2 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 border border-zinc-700/60"
      >
        <X className="w-5 h-5" />
      </button>

      {/* Interactive Fullscreen Triage Action HUD */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-[#10121a]/95 border border-zinc-700/70 backdrop-blur-xl px-5 py-2.5 rounded-2xl flex items-center gap-4 text-xs text-zinc-200 shadow-2xl z-50"
      >
        <div className="flex flex-col">
          <span className="font-semibold text-zinc-100">{activePhoto.name}</span>
          <span className="text-[10px] text-zinc-500 font-mono">
            {activePhoto.captured_at || "No date"}{" "}
            {activePhoto.location ? `• ${activePhoto.location}` : ""}
          </span>
        </div>

        {/* Pick/Reject in Loupe */}
        <div className="flex items-center gap-1 border-l border-zinc-700 pl-3">
          <button
            onClick={() => {
              handleSetFlag(activePhoto.flag === "pick" ? null : "pick");
              if (autoAdvance) navigateByOffset(1, false);
            }}
            className={`px-2 py-1 rounded font-medium flex items-center gap-1.5 ${
              activePhoto.flag === "pick"
                ? "bg-emerald-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:text-emerald-300"
            }`}
          >
            <Flag className="w-3.5 h-3.5" />
            <span>Pick (P)</span>
          </button>
          <button
            onClick={() => {
              handleSetFlag("reject");
              handleBatchStageMove("_Trash");
              if (autoAdvance) navigateByOffset(1, false);
            }}
            className="px-2 py-1 bg-zinc-800 hover:bg-red-950/60 text-red-400 rounded font-medium flex items-center gap-1.5"
          >
            <XCircle className="w-3.5 h-3.5" />
            <span>Reject (X)</span>
          </button>
        </div>

        {/* Stars */}
        <div className="flex items-center gap-1 border-l border-zinc-700 pl-3">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => {
                handleBatchRate(star);
                if (autoAdvance) navigateByOffset(1, false);
              }}
              className="p-0.5 hover:scale-110 transition"
            >
              <Star
                className={`w-4 h-4 ${
                  star <= activePhoto.rating
                    ? "text-amber-400 fill-amber-400"
                    : "text-zinc-600 hover:text-amber-400"
                }`}
              />
            </button>
          ))}
        </div>

        {/* Rotation in Loupe */}
        <div className="flex items-center gap-1 border-l border-zinc-700 pl-3">
          <button
            onClick={() => handleRotateSelection(-90)}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white"
            title="Rotate Left ([)"
          >
            <RotateLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => handleRotateSelection(90)}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white"
            title="Rotate Right (])"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* AI Analyze in Loupe */}
        <button
          onClick={handleAiAnalyzeSingle}
          className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 rounded text-white border-l border-zinc-700 ml-1"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>AI (A)</span>
        </button>
      </div>
    </div>
  );
}
