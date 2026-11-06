import { useEffect, useState } from "react";
import { callLocal, onAndroid } from "../../api";

// The phone's own folders (Camera, WhatsApp Images, Screenshots, ...) from phone_backup.rs: how many photos each
// holds, how many of them the backup's server has, the newest as cover, and their content ids
export interface PhoneFolder {
  folder: string;
  name: string;
  count: number;
  backed_up: number;
  cover: string;
  hashes: string[];
}

// Asked again when `version` changes (a backup that moved on)
export function usePhoneFolders(server: string | null, version: unknown): PhoneFolder[] | null {
  const [folders, setFolders] = useState<PhoneFolder[] | null>(null);
  useEffect(() => {
    if (!onAndroid) return;
    let stale = false;
    callLocal<PhoneFolder[]>("phone_folders", { server })
      .then((f) => !stale && setFolders(f))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [server, version]);
  return folders;
}
