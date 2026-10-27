import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { Loader2, UserCircle, X } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { SimilarFaceCandidate } from "../../types/lumina";

interface ProfilePicturePickerProps {
  // The person to pick a picture for (null: closed)
  person: string | null;
  // Path of the current profile picture, highlighted in the grid
  currentCover: string;
  onPick: (faceId: string) => Promise<void>;
  onClose: () => void;
}

// Pick one of a person's named faces as their profile picture
export default function ProfilePicturePicker({ person, currentCover, onPick, onClose }: ProfilePicturePickerProps) {
  const isOpen = person !== null;
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);
  const [faces, setFaces] = useState<SimilarFaceCandidate[] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!person) return;
    let stale = false;
    setFaces(null);
    setError("");
    invoke<SimilarFaceCandidate[]>("get_confirmed_faces_for_person", { personName: person })
      .then((res) => !stale && setFaces(res.filter((f) => f.face_thumb)))
      .catch((err) => !stale && setError(String(err)));
    return () => {
      stale = true;
    };
  }, [person]);

  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9995] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 select-none"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-label={`Profile picture for ${person}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        className="bg-card border border-zinc-800 rounded-2xl w-full max-w-2xl max-h-[80vh] shadow-2xl flex flex-col overflow-hidden focus:outline-none"
      >
        <div className="px-5 py-3.5 bg-raised border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <UserCircle className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-sm font-bold text-zinc-100">
                Profile picture for <span className="capitalize">{person}</span>
              </h2>
              <p className="text-xs text-zinc-400">Click one of their faces</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {error ? (
            <p className="text-xs text-red-300">Could not load the faces: {error}</p>
          ) : faces === null ? (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-zinc-400">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading faces…
            </div>
          ) : faces.length === 0 ? (
            <p className="text-xs text-zinc-400 py-8 text-center">
              No named faces yet. Name this person on a face (Face Review or the inspector) to pick a picture.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-3">
              {faces.map((f) => {
                const current = f.face_thumb === currentCover;
                return (
                  <button
                    key={f.face_id}
                    disabled={saving !== null}
                    onClick={async () => {
                      setSaving(f.face_id);
                      await onPick(f.face_id);
                      setSaving(null);
                      onClose();
                    }}
                    title={f.photo_name}
                    className={`relative aspect-square rounded-full overflow-hidden border-2 transition hover:scale-105 disabled:opacity-60 ${
                      current ? "border-emerald-400" : "border-zinc-800 hover:border-emerald-500/60"
                    }`}
                  >
                    <img src={convertFileSrc(f.face_thumb)} alt="" loading="lazy" className="w-full h-full object-cover" />
                    {saving === f.face_id && (
                      <span className="absolute inset-0 bg-black/50 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 animate-spin text-white" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
