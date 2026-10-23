import { useEffect, useRef } from "react";
import { Copy, ExternalLink, Eye, Folder, FolderPlus, Trash2 } from "lucide-react";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

interface PhotoContextMenuProps {
  position: ContextMenuPosition | null;
  onClose: () => void;
  onOpenDefault: () => void;
  onRevealInFolder: () => void;
  onCopyFullImage: () => void;
  onStageTrash: () => void;
}

export function PhotoContextMenu({
  position,
  onClose,
  onOpenDefault,
  onRevealInFolder,
  onCopyFullImage,
  onStageTrash,
}: PhotoContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  if (!position) return null;

  return (
    <div
      ref={ref}
      style={{
        left: `${Math.min(window.innerWidth - 220, position.x)}px`,
        top: `${Math.min(window.innerHeight - 200, position.y)}px`,
      }}
      className="fixed z-[99999] w-52 bg-[#12141d]/95 backdrop-blur-md border border-zinc-700/80 rounded-xl shadow-2xl p-1 text-xs select-none animate-in fade-in zoom-in-95"
    >
      <button
        onClick={() => {
          onOpenDefault();
          onClose();
        }}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
      >
        <Eye className="w-3.5 h-3.5 text-emerald-400" />
        <span>Open in Default Viewer</span>
      </button>

      <button
        onClick={() => {
          onRevealInFolder();
          onClose();
        }}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
      >
        <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
        <span>Reveal in File Manager</span>
      </button>

      <button
        onClick={() => {
          onCopyFullImage();
          onClose();
        }}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
      >
        <Copy className="w-3.5 h-3.5 text-indigo-400" />
        <span>Copy Image (Full Resolution)</span>
      </button>

      <div className="h-[1px] bg-zinc-800 my-1" />

      <button
        onClick={() => {
          onStageTrash();
          onClose();
        }}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-red-950/60 text-red-300 transition text-left"
      >
        <Trash2 className="w-3.5 h-3.5 text-red-400" />
        <span>Stage for _Trash (X)</span>
      </button>
    </div>
  );
}

interface FolderContextMenuProps {
  position: ContextMenuPosition | null;
  folderPath: string;
  onClose: () => void;
  onRevealFolder: () => void;
  onCreateSubfolder: () => void;
}

export function FolderContextMenu({
  position,
  folderPath,
  onClose,
  onRevealFolder,
  onCreateSubfolder,
}: FolderContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  if (!position) return null;

  return (
    <div
      ref={ref}
      style={{
        left: `${Math.min(window.innerWidth - 220, position.x)}px`,
        top: `${Math.min(window.innerHeight - 150, position.y)}px`,
      }}
      className="fixed z-[99999] w-52 bg-[#12141d]/95 backdrop-blur-md border border-zinc-700/80 rounded-xl shadow-2xl p-1 text-xs select-none animate-in fade-in zoom-in-95"
    >
      <div className="px-2.5 py-1 text-[10px] text-zinc-500 font-mono truncate border-b border-zinc-800 mb-1">
        {folderPath}
      </div>

      <button
        onClick={() => {
          onRevealFolder();
          onClose();
        }}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
      >
        <Folder className="w-3.5 h-3.5 text-emerald-400" />
        <span>Open in File Manager</span>
      </button>

      <button
        onClick={() => {
          onCreateSubfolder();
          onClose();
        }}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
      >
        <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
        <span>New Subfolder Here...</span>
      </button>
    </div>
  );
}