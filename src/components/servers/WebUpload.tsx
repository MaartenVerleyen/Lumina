import { useRef, useSyncExternalStore } from "react";
import { Loader2, Upload } from "lucide-react";
import { createBLAKE3 } from "hash-wasm";
import { contentHash, fullHash, missingOnServer, uploadFile } from "../../api/webUpload";
import { useAccess } from "../auth/ServerGate";

// The web client's Upload button (uploader and up): photos and videos picked on a phone or computer go to the
// server's upload folder (uploads/<your name>/). Files the server already has are skipped; a dropped
// connection is tried again (2 s, 4 s, ... 30 s, five times) and the upload carries on where it stopped.

interface State {
  running: boolean;
  files: number;
  done: number;
  skipped: number;
  failed: { name: string; error: string }[];
  stage: string;
  bytesTotal: number;
  bytesDone: number;
}

let state: State = { running: false, files: 0, done: 0, skipped: 0, failed: [], stage: "", bytesTotal: 0, bytesDone: 0 };
const listeners = new Set<() => void>();
function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A network failure (fetch throws a TypeError) is tried again; what the server refuses is not
async function withRetries<T>(f: () => Promise<T>): Promise<T> {
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof TypeError) || attempt >= 5) throw e;
      set({ stage: `Waiting for the server; trying again in ${delay / 1000} s` });
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
}

// Whatever goes wrong ends the run with its reason, never a button stuck at 0 %
async function run(files: File[]) {
  if (state.running || files.length === 0) return;
  try {
    await runFiles(files);
  } catch (e) {
    set({ running: false, stage: "", failed: [...state.failed, { name: "", error: `Upload stopped: ${String((e as Error)?.message ?? e)}` }] });
  }
}

async function runFiles(files: File[]) {
  const bytesTotal = files.reduce((n, f) => n + f.size, 0);
  set({ running: true, files: files.length, done: 0, skipped: 0, failed: [], stage: "Reading files", bytesTotal, bytesDone: 0 });
  const hasher = await createBLAKE3();
  const hashed: { file: File; hash: string }[] = [];
  for (const [i, file] of files.entries()) {
    set({ stage: `Reading files (${i + 1} of ${files.length})` });
    hashed.push({ file, hash: await contentHash(file, hasher) });
  }
  let missing: Set<string>;
  try {
    set({ stage: "Asking the server what it already has" });
    missing = await withRetries(() => missingOnServer(hashed.map((h) => ({ hash: h.hash, size: h.file.size, name: h.file.name }))));
  } catch (e) {
    set({ running: false, stage: "", failed: [{ name: "", error: String((e as Error)?.message ?? e) }] });
    return;
  }
  let bytesDone = 0;
  for (const { file, hash } of hashed) {
    if (!missing.has(hash)) {
      bytesDone += file.size;
      set({ skipped: state.skipped + 1, bytesDone });
      continue;
    }
    try {
      set({ stage: `Checking ${file.name}` });
      const full_hash = await fullHash(file, hasher);
      set({ stage: `Uploading ${file.name}` });
      await withRetries(() => uploadFile(file, { hash, full_hash }, { onProgress: (sent) => set({ bytesDone: bytesDone + sent }) }));
      set({ done: state.done + 1 });
    } catch (e) {
      set({ failed: [...state.failed, { name: file.name, error: String((e as Error)?.message ?? e) }] });
    }
    bytesDone += file.size;
    set({ bytesDone });
  }
  set({ running: false, stage: "" });
}

function useWebUpload(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state
  );
}

export function WebUploadButton({ className = "" }: { className?: string }) {
  const access = useAccess();
  const s = useWebUpload();
  const input = useRef<HTMLInputElement>(null);
  if (!access.upload) return null;
  const percent = s.bytesTotal > 0 ? Math.round((s.bytesDone / s.bytesTotal) * 100) : 0;
  const summary = s.running
    ? `${s.stage} · ${percent}%`
    : s.files > 0
    ? [
        `Uploaded ${s.done} of ${s.files}`,
        s.skipped > 0 ? `${s.skipped} already on the server` : "",
        s.failed.length > 0 ? `${s.failed.length} failed: ${s.failed[0].name ? `${s.failed[0].name}: ` : ""}${s.failed[0].error}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "Upload photos and videos to the server";
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/*,video/*,.dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.heic,.heif,.xmp"
        className="hidden"
        onChange={(e) => {
          run(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <button
        onClick={() => !s.running && input.current?.click()}
        title={summary}
        aria-label={summary}
        className={`relative p-2 rounded-full text-zinc-300 hover:text-white active:bg-white/10 ${className}`}
      >
        {s.running ? <Loader2 className="w-5 h-5 animate-spin text-emerald-400" /> : <Upload className="w-5 h-5" />}
        {s.running && (
          <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 text-[9px] font-semibold text-emerald-300">{percent}%</span>
        )}
        {!s.running && s.failed.length > 0 && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" />}
      </button>
    </>
  );
}
