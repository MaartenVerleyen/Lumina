import { useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { PhotoItem } from "../../types/lumina";
import { Columns, Star, Trophy, ZoomIn, ZoomOut } from "lucide-react";

interface CompareViewProps {
  comparePhotos: PhotoItem[];
  activeHash: string | null;
  setActiveHash: React.Dispatch<React.SetStateAction<string | null>>;
  compareZoom: number;
  setCompareZoom: React.Dispatch<React.SetStateAction<number>>;
  comparePan: { x: number; y: number };
  setComparePan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  setViewMode: React.Dispatch<React.SetStateAction<"grid" | "map" | "compare">>;
  setPhotos: React.Dispatch<React.SetStateAction<PhotoItem[]>>;
}

export default function CompareView({
  comparePhotos,
  activeHash,
  setActiveHash,
  compareZoom,
  setCompareZoom,
  comparePan,
  setComparePan,
  setViewMode,
  setPhotos,
}: CompareViewProps) {
  const isPanningCompareRef = useRef<boolean>(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#07080c]">
      {/* Synchronized Compare Toolbar */}
      <div className="bg-[#0c0d14] border-b border-zinc-800 px-4 py-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-emerald-300 flex items-center gap-1.5">
            <Columns className="w-4 h-4 text-emerald-400" />
            Synchronized Compare ({comparePhotos.length} photos)
          </span>
          <span className="text-zinc-500">
            Scroll wheel or click +/- to zoom all • Drag any image to pan all simultaneously
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCompareZoom((z) => Math.max(1, +(z - 0.5).toFixed(1)))}
            className="p-1.5 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 text-zinc-300"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="font-mono text-zinc-300 w-12 text-center">
            {Math.round(compareZoom * 100)}%
          </span>
          <button
            onClick={() => setCompareZoom((z) => Math.min(6, +(z + 0.5).toFixed(1)))}
            className="p-1.5 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 text-zinc-300"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              setCompareZoom(1);
              setComparePan({ x: 0, y: 0 });
            }}
            className="px-2.5 py-1 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 text-zinc-400 hover:text-white"
          >
            Reset 100%
          </button>
          <button
            onClick={() => setViewMode("grid")}
            className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded font-medium ml-2"
          >
            Exit Compare (C)
          </button>
        </div>
      </div>

      {/* Multi-Pane Synchronized Canvas */}
      <div
        onWheel={(e) => {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 0.35 : -0.35;
          setCompareZoom((z) => {
            const next = Math.max(1, Math.min(6, +(z + delta).toFixed(2)));
            if (next === 1) setComparePan({ x: 0, y: 0 });
            return next;
          });
        }}
        onMouseDown={(e) => {
          if (compareZoom <= 1) return;
          isPanningCompareRef.current = true;
          panStartRef.current = { x: e.clientX - comparePan.x, y: e.clientY - comparePan.y };
        }}
        onMouseMove={(e) => {
          if (!isPanningCompareRef.current) return;
          setComparePan({
            x: e.clientX - panStartRef.current.x,
            y: e.clientY - panStartRef.current.y,
          });
        }}
        onMouseUp={() => {
          isPanningCompareRef.current = false;
        }}
        onMouseLeave={() => {
          isPanningCompareRef.current = false;
        }}
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, comparePhotos.length)}, minmax(0, 1fr))`,
        }}
        className="flex-1 grid gap-2 p-3 overflow-hidden select-none cursor-grab active:cursor-grabbing"
      >
        {comparePhotos.map((cp) => {
          const isActive = cp.hash === activeHash;
          return (
            <div
              key={cp.hash}
              onClick={() => setActiveHash(cp.hash)}
              className={`relative flex flex-col rounded-xl overflow-hidden bg-zinc-950 border transition ${
                isActive ? "border-emerald-500 ring-1 ring-emerald-500" : "border-zinc-800"
              }`}
            >
              <div className="flex-1 relative overflow-hidden flex items-center justify-center">
                <img
                  src={convertFileSrc(cp.path)}
                  alt={cp.name}
                  draggable={false}
                  style={{
                    transform: `translate(${comparePan.x}px, ${comparePan.y}px) scale(${compareZoom}) rotate(${cp.rotation}deg)`,
                    transformOrigin: "center center",
                  }}
                  className="max-w-full max-h-full object-contain pointer-events-none transition-transform duration-75"
                />
              </div>

              {/* Compare Card Bottom Bar */}
              <div className="p-2.5 bg-[#10121a] border-t border-zinc-800 flex items-center justify-between text-xs z-10">
                <div className="truncate">
                  <div className="font-semibold text-zinc-200 truncate">{cp.name}</div>
                  <div className="text-[11px] font-mono text-emerald-400 flex items-center gap-1.5">
                    <span>Focus Score: {cp.sharpness}</span>
                    {cp.rating > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-amber-400">
                        • <Star className="w-3 h-3 fill-amber-400" /> {cp.rating}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      await invoke("set_photo_flag", { hashes: [cp.hash], flag: "pick" });
                      const others = comparePhotos.filter((o) => o.hash !== cp.hash);
                      if (others.length > 0) {
                        const otherHashes = others.map((o) => o.hash);
                        const ops = otherHashes.map((hash) => ({
                          hash,
                          target_subfolder: "_Trash",
                        }));
                        await invoke("stage_photos_move", { ops });
                        await invoke("set_photo_flag", {
                          hashes: otherHashes,
                          flag: "reject",
                        });
                      }
                      const otherSet = new Set(others.map((o) => o.hash));
                      setPhotos((prev) =>
                        prev.map((p) => {
                          if (p.hash === cp.hash) return { ...p, flag: "pick" };
                          if (otherSet.has(p.hash)) {
                            return { ...p, flag: "reject", staged_target: "_Trash" };
                          }
                          return p;
                        })
                      );
                      setViewMode("grid");
                    }}
                    className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-semibold shadow transition flex items-center gap-1.5"
                    title="Keep this photo as Pick and stage the other compared photos for _Trash"
                  >
                    <Trophy className="w-3.5 h-3.5" />
                    <span>Keep This & Trash Rest</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
