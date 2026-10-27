import { FolderPlus, X } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";

// Create a subfolder in the library (from the folder tree's right-click menu)
export default function NewFolderModal({
  isNewFolderModalOpen,
  setIsNewFolderModalOpen,
  newFolderInput,
  setNewFolderInput,
  onCreate,
}: {
  isNewFolderModalOpen: boolean;
  setIsNewFolderModalOpen: (open: boolean) => void;
  newFolderInput: string;
  setNewFolderInput: (value: string) => void;
  onCreate: (relativePath: string) => Promise<void>;
}) {
  const newFolderDialogRef = useDialogFocus<HTMLFormElement>(isNewFolderModalOpen);
  return (
    <>
      {isNewFolderModalOpen && (
        <div
          onClick={() => setIsNewFolderModalOpen(false)}
          className="fixed inset-0 z-[9995] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none"
        >
          <form
            ref={newFolderDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Create new subfolder"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newFolderInput.trim()) return;
              await onCreate(newFolderInput.trim());
              setIsNewFolderModalOpen(false);
              setNewFolderInput("");
            }}
            className="bg-raised border border-zinc-800 rounded-2xl w-full max-w-md p-5 shadow-2xl flex flex-col gap-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-zinc-100 flex items-center gap-2">
                <FolderPlus className="w-4 h-4 text-emerald-400" />
                Create New Subfolder
              </span>
              <button
                type="button"
                onClick={() => setIsNewFolderModalOpen(false)}
                className="text-zinc-500 hover:text-white"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              type="text"
              value={newFolderInput}
              onChange={(e) => setNewFolderInput(e.target.value)}
              placeholder="e.g. 2026/Selects or Favorites"
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono text-xs focus:outline-none focus:border-emerald-500"
              autoFocus
            />
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setIsNewFolderModalOpen(false)}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-semibold"
              >
                Create Folder
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
