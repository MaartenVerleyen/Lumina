// Uploading from the web client (a phone's browser until the Android app exists): the same resumable protocol
// as the desktop app (src-tauri/src/transfer.rs). The file's identity is Lumina's content hash, BLAKE3 of
// the size and the first and last 64 KB, exactly as the engine computes it (imaging::hash_and_read_head), so
// the server can say what it already has before anything is sent.
import { createBLAKE3 } from "hash-wasm";

const EDGE = 65536;
export const CHUNK = 8 * 1024 * 1024;

type Blake3 = Awaited<ReturnType<typeof createBLAKE3>>;

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

// The engine's content hash: the size (8 bytes, little-endian), the first 64 KB, and the last 64 KB when the
// file is longer than 128 KB; the first 16 hex digits
export async function contentHash(file: Blob, hasher?: Blake3): Promise<string> {
  const h = hasher ?? (await createBLAKE3());
  h.init();
  const size = new Uint8Array(8);
  new DataView(size.buffer).setBigUint64(0, BigInt(file.size), true);
  h.update(size);
  h.update(await bytes(file.slice(0, EDGE)));
  if (file.size > EDGE * 2) h.update(await bytes(file.slice(file.size - EDGE)));
  return h.digest("hex").slice(0, 16);
}

// The whole file's BLAKE3, read in chunks
export async function fullHash(file: Blob, hasher?: Blake3): Promise<string> {
  const h = hasher ?? (await createBLAKE3());
  h.init();
  for (let at = 0; at < file.size; at += CHUNK) h.update(await bytes(file.slice(at, at + CHUNK)));
  return h.digest("hex");
}

export interface UploadOptions {
  base?: string;
  fetch?: typeof fetch;
  clientId?: string;
  onProgress?: (sent: number) => void;
  signal?: { cancelled: boolean };
}

const HEADERS = { "Content-Type": "application/json", "X-Lumina": "1" };

async function failure(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    if (body && typeof body.error === "string") return body.error;
  } catch {
    // not JSON
  }
  return `The server answered ${resp.status}`;
}

// Of these files, the ones the server lacks
export async function missingOnServer(files: { hash: string; size: number; name: string }[], options: UploadOptions = {}): Promise<Set<string>> {
  const doFetch = options.fetch ?? fetch;
  const resp = await doFetch(`${options.base ?? ""}/api/upload/check`, {
    method: "POST",
    credentials: "same-origin",
    headers: HEADERS,
    body: JSON.stringify({ files }),
  });
  if (!resp.ok) throw new Error(await failure(resp));
  return new Set(((await resp.json()) as { missing: string[] }).missing);
}

// Sends one file, carrying on where an earlier try stopped; answers the server's PhotoItem
export async function uploadFile(
  file: File,
  hashes: { hash: string; full_hash: string },
  options: UploadOptions = {}
): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const base = options.base ?? "";
  const headers = { ...HEADERS, ...(options.clientId ? { "X-Lumina-Client": options.clientId } : {}) };
  const started = await doFetch(`${base}/api/upload`, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      hash: hashes.hash,
      full_hash: hashes.full_hash,
      modified: Math.floor((file.lastModified || Date.now()) / 1000),
    }),
  });
  if (!started.ok) throw new Error(await failure(started));
  const { id, received } = (await started.json()) as { id: string; received: number };
  let offset = received;
  options.onProgress?.(offset);
  while (offset < file.size) {
    if (options.signal?.cancelled) throw new Error("Cancelled");
    const resp = await doFetch(`${base}/api/upload/${encodeURIComponent(id)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "X-Lumina": "1", "Content-Type": "application/octet-stream", "Upload-Offset": String(offset) },
      body: file.slice(offset, offset + CHUNK),
    });
    if (resp.status === 409) {
      // A chunk arrived but its answer didn't: the server says where to carry on
      offset = ((await resp.json()) as { offset: number }).offset;
    } else if (resp.ok) {
      offset = ((await resp.json()) as { received: number }).received;
    } else {
      throw new Error(await failure(resp));
    }
    options.onProgress?.(offset);
  }
  const done = await doFetch(`${base}/api/upload/${encodeURIComponent(id)}/finish`, { method: "POST", credentials: "same-origin", headers });
  if (!done.ok) throw new Error(await failure(done));
  return done.json();
}
