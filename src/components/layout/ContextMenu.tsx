import { useEffect, useRef, useState } from "react";
import {
  BookImage,
  ChevronRight,
  Copy,
  Download,
  Globe,
  ExternalLink,
  Eye,
  FileText,
  Flag,
  Folder,
  FolderPlus,
  Sparkles,
  Trash2,
} from "lucide-react";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

interface PhotoContextMenuProps {
  position: ContextMenuPosition | null;
  onClose: () => void;
  // Absent in the web client (it acts on this computer's files)
  onOpenDefault?: () => void;
  // Absent in the web client (it acts on this computer's files)
  onRevealInFolder?: () => void;
  // Absent in the web client (it acts on this computer's files)
  onCopyFullImage?: () => void;
  // Absent for users who may not change photos (as are Pick and the albums)
  onStageTrash?: () => void;
  // Optional callbacks for quick Pick & Copy Path
  onPickPhoto?: () => void;
  onCopyPath?: () => void;
  onFindSimilar?: () => void;
  onExport?: () => void;
  onShareGallery?: () => void;
  // "Add to album ▸": existing albums, or a new one named on the spot
  albums?: { id: number; name: string }[];
  onAddToAlbum?: (albumId: number) => void;
  onCreateAlbum?: (name: string) => void;
  // Set while an album is shown: removes the right-clicked photos from it
  onRemoveFromAlbum?: () => void;
}

export function PhotoContextMenu({
  position,
  onClose,
  onOpenDefault,
  onRevealInFolder,
  onCopyFullImage,
  onStageTrash,
  onPickPhoto,
  onCopyPath,
  onFindSimilar,
  onExport,
  onShareGallery,
  albums,
  onAddToAlbum,
  onCreateAlbum,
  onRemoveFromAlbum,
}: PhotoContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [albumsOpen, setAlbumsOpen] = useState(false);
  const [newAlbum, setNewAlbum] = useState("");

  useEffect(() => {
    setAlbumsOpen(false);
    setNewAlbum("");
  }, [position]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  if (!position) return null;

  return (
    <div
      ref={ref}
      style={{
        left: `${Math.min(window.innerWidth - 230, position.x)}px`,
        top: `${Math.max(8, Math.min(window.innerHeight - (albumsOpen ? 420 : 300), position.y))}px`,
      }}
      className="fixed z-[99999] w-56 bg-raised/95 backdrop-blur-md border border-zinc-700/80 rounded-xl shadow-2xl p-1 text-xs select-none animate-in fade-in zoom-in-95"
    >
      {onOpenDefault && (
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
      )}

      {onRevealInFolder && (
        <button
          onClick={() => {
            onRevealInFolder();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
        >
          <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
          <span>Reveal in File Explorer</span>
        </button>
      )}

      {onCopyFullImage && (
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
      )}

      {onCopyPath && (
        <button
          onClick={() => {
            onCopyPath();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-300 transition text-left"
        >
          <FileText className="w-3.5 h-3.5 text-zinc-400" />
          <span>Copy File Path</span>
        </button>
      )}

      {onAddToAlbum && onCreateAlbum && (
        <>
          <button
            onClick={() => setAlbumsOpen((o) => !o)}
            aria-expanded={albumsOpen}
            className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
          >
            <span className="flex items-center gap-2">
              <BookImage className="w-3.5 h-3.5 text-indigo-400" />
              <span>Add to Album</span>
            </span>
            <ChevronRight className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${albumsOpen ? "rotate-90" : ""}`} />
          </button>
          {albumsOpen && (
            <div className="ml-3 pl-2 border-l border-zinc-800 flex flex-col gap-0.5 max-h-48 overflow-y-auto">
              {(albums ?? []).map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    onAddToAlbum(a.id);
                    onClose();
                  }}
                  className="w-full px-2 py-1 rounded-md hover:bg-zinc-800 text-zinc-300 text-left truncate"
                >
                  {a.name}
                </button>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newAlbum.trim()) return;
                  onCreateAlbum(newAlbum);
                  onClose();
                }}
                className="flex items-center gap-1 py-0.5"
              >
                <input
                  autoFocus
                  value={newAlbum}
                  onChange={(e) => setNewAlbum(e.target.value)}
                  onKeyDown={(e) => {
                    // Typing a name must not trigger grid shortcuts; Escape still closes the menu
                    if (e.key === "Escape") onClose();
                    else e.stopPropagation();
                  }}
                  placeholder="New album…"
                  className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 select-text focus:outline-none focus:border-indigo-500"
                />
                <button type="submit" className="px-1.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px]">
                  Add
                </button>
              </form>
            </div>
          )}
        </>
      )}

      {onRemoveFromAlbum && (
        <button
          onClick={() => {
            onRemoveFromAlbum();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-300 transition text-left"
        >
          <BookImage className="w-3.5 h-3.5 text-zinc-500" />
          <span>Remove from This Album</span>
        </button>
      )}

      {onExport && (
        <button
          onClick={() => {
            onExport();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
        >
          <Download className="w-3.5 h-3.5 text-emerald-400" />
          <span>Export…</span>
        </button>
      )}

      {onShareGallery && (
        <button
          onClick={() => {
            onShareGallery();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
        >
          <Globe className="w-3.5 h-3.5 text-emerald-400" />
          <span>Share as Web Gallery…</span>
        </button>
      )}

      {onFindSimilar && (
        <button
          onClick={() => {
            onFindSimilar();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-indigo-950/60 text-indigo-200 transition text-left"
        >
          <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
          <span>Find Similar Photos</span>
        </button>
      )}

      <div className="h-[1px] bg-zinc-800 my-1" />

      {onPickPhoto && (
        <button
          onClick={() => {
            onPickPhoto();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-emerald-950/60 text-emerald-300 transition text-left"
        >
          <Flag className="w-3.5 h-3.5 text-emerald-400" />
          <span>Mark as Pick (P)</span>
        </button>
      )}

      {onStageTrash && (
        <button
          onClick={() => {
            onStageTrash();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-red-950/60 text-red-300 transition text-left"
        >
          <Trash2 className="w-3.5 h-3.5 text-red-400" />
          <span>Reject & Stage for _Trash (X)</span>
        </button>
      )}
    </div>
  );
}

interface FolderContextMenuProps {
  position: ContextMenuPosition | null;
  folderPath: string;
  onClose: () => void;
  // Absent in the web client (it acts on this computer's files)
  onRevealFolder?: () => void;
  // Absent in the web client (it acts on this computer's files)
  onCreateSubfolder?: () => void;
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
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Nothing to offer (the web client has neither item)
  if (!position || (!onRevealFolder && !onCreateSubfolder)) return null;

  return (
    <div
      ref={ref}
      style={{
        left: `${Math.min(window.innerWidth - 230, position.x)}px`,
        top: `${Math.min(window.innerHeight - 160, position.y)}px`,
      }}
      className="fixed z-[99999] w-56 bg-raised/95 backdrop-blur-md border border-zinc-700/80 rounded-xl shadow-2xl p-1 text-xs select-none animate-in fade-in zoom-in-95"
    >
      <div className="px-2.5 py-1 text-[11px] text-zinc-400 font-mono truncate border-b border-zinc-800 mb-1">
        📂 {folderPath || "Root"}
      </div>

      {onRevealFolder && (
        <button
          onClick={() => {
            onRevealFolder();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
        >
          <Folder className="w-3.5 h-3.5 text-emerald-400" />
          <span>Open Folder in Explorer</span>
        </button>
      )}

      {onCreateSubfolder && (
        <button
          onClick={() => {
            onCreateSubfolder();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 transition text-left"
        >
          <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
          <span>Create New Subfolder Here...</span>
        </button>
      )}
    </div>
  );
}
