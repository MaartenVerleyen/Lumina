import { useState } from "react";
import { BookImage, Check, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { Album, SavedSearch } from "../../types/lumina";

interface AlbumsSectionProps {
  albums: Album[];
  // Photos of each album in the open folder
  albumCounts: Map<number, number>;
  savedSearches: SavedSearch[];
  activeAlbumId: number | null;
  searchQuery: string;
  onSelectAlbum: (id: number | null) => void;
  onCreateAlbum: (name: string) => Promise<number | null>;
  onRenameAlbum: (id: number, name: string) => Promise<void>;
  onDeleteAlbum: (id: number) => Promise<void>;
  onRunSavedSearch: (saved: SavedSearch) => void;
  onDeleteSavedSearch: (id: number) => Promise<void>;
}

// Sidebar list of albums (click to show, drop photos to add) and smart albums (saved searches)
export default function AlbumsSection({
  albums,
  albumCounts,
  savedSearches,
  activeAlbumId,
  searchQuery,
  onSelectAlbum,
  onCreateAlbum,
  onRenameAlbum,
  onDeleteAlbum,
  onRunSavedSearch,
  onDeleteSavedSearch,
}: AlbumsSectionProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const submitNew = async () => {
    if (newName.trim()) await onCreateAlbum(newName);
    setNewName("");
    setIsCreating(false);
  };

  const submitRename = async () => {
    if (renamingId !== null && renameValue.trim()) await onRenameAlbum(renamingId, renameValue);
    setRenamingId(null);
  };

  const inputClass =
    "flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 select-text focus:outline-none focus:border-indigo-500";

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-zinc-500 tracking-wider uppercase">Albums</span>
        <button
          onClick={() => setIsCreating((v) => !v)}
          className="p-0.5 rounded text-zinc-500 hover:text-indigo-300"
          title="New album (or drag photos onto an album to add them)"
          aria-label="New album"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="mt-2 flex flex-col gap-0.5 text-xs">
        {isCreating && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitNew();
            }}
            className="flex items-center gap-1 px-1 py-0.5"
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setIsCreating(false);
              }}
              placeholder="Album name"
              className={inputClass}
            />
            <button type="submit" className="p-1 text-indigo-300 hover:text-white" aria-label="Create album">
              <Check className="w-3.5 h-3.5" />
            </button>
          </form>
        )}

        {albums.length === 0 && !isCreating && savedSearches.length === 0 && (
          <span className="px-2.5 py-1 text-[11px] text-zinc-600">
            Create an album with + or the Album button on a selection.
          </span>
        )}

        {albums.map((a) => {
          const isActive = activeAlbumId === a.id;
          if (renamingId === a.id) {
            return (
              <form
                key={a.id}
                onSubmit={(e) => {
                  e.preventDefault();
                  submitRename();
                }}
                className="flex items-center gap-1 px-1 py-0.5"
              >
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={submitRename}
                  className={inputClass}
                />
              </form>
            );
          }
          return (
            <div
              key={a.id}
              data-drop-kind="album"
              data-drop-value={String(a.id)}
              data-drop-label={`Add to album "${a.name}"`}
              onClick={() => onSelectAlbum(isActive ? null : a.id)}
              className={`group flex items-center justify-between px-2.5 py-1.5 rounded-md border cursor-pointer transition ${
                isActive
                  ? "bg-indigo-500/15 text-indigo-200 border-indigo-500/30 font-medium"
                  : "text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200 border-transparent"
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <BookImage className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span className="truncate">{a.name}</span>
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(a.id);
                    setRenameValue(a.name);
                  }}
                  className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label={`Rename album ${a.name}`}
                  title="Rename"
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteAlbum(a.id);
                  }}
                  className="p-0.5 rounded text-zinc-500 hover:text-red-300 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label={`Delete album ${a.name}`}
                  title="Delete album (photos are kept)"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
                <span
                  className="text-[11px] text-zinc-500 font-mono ml-0.5"
                  title={`${albumCounts.get(a.id) ?? 0} in this folder · ${a.hashes.length} in total`}
                >
                  {albumCounts.get(a.id) ?? 0}
                </span>
              </span>
            </div>
          );
        })}

        {savedSearches.map((s) => {
          const isActive = searchQuery.trim() === s.query;
          return (
            <div
              key={`s${s.id}`}
              onClick={() => onRunSavedSearch(s)}
              title={s.query}
              className={`group flex items-center justify-between px-2.5 py-1.5 rounded-md border cursor-pointer transition ${
                isActive
                  ? "bg-indigo-500/15 text-indigo-200 border-indigo-500/30 font-medium"
                  : "text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200 border-transparent"
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <Sparkles className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                <span className="truncate">{s.name}</span>
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteSavedSearch(s.id);
                }}
                className="p-0.5 rounded text-zinc-500 hover:text-red-300 opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0"
                aria-label={`Delete smart album ${s.name}`}
                title="Delete smart album"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
