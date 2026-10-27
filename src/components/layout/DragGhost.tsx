import { thumbSrc } from "../../utils/photoHelpers";
import type { PhotoItem } from "../../types/lumina";
import type { usePhotoDrag } from "../../hooks/usePhotoDrag";

// Follows the pointer while photos are dragged onto a folder, person or quick filter
export default function DragGhost({
  drag,
  dragPhoto,
}: {
  drag: ReturnType<typeof usePhotoDrag>["drag"];
  dragPhoto: PhotoItem | undefined;
}) {
  return (
    <>
      {drag && (
        <div
          style={{ left: drag.x + 14, top: drag.y + 14 }}
          className="fixed z-[99995] pointer-events-none flex items-center gap-2 px-2 py-1.5 rounded-xl bg-raised/95 border border-emerald-500/50 shadow-2xl text-xs text-zinc-100"
        >
          {dragPhoto?.thumb_ready && (
            <img src={thumbSrc(dragPhoto)} alt="" className="w-10 h-10 rounded-md object-cover" />
          )}
          <div className="flex flex-col">
            <span className="font-semibold">
              {drag.count} photo{drag.count === 1 ? "" : "s"}
            </span>
            <span className={drag.target ? "text-emerald-300" : "text-zinc-400"}>
              {drag.target ? drag.target.label : "Drop on a folder, person, Picks, Basket or Rejects"}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
