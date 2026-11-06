import { callLocal } from "../../api";

// Free up space (docs/plans/android.md, milestone 4): photos on this phone that the backup's server has, asked of
// the server just before (phone_backup.rs), go to the phone's trash after Android's own question

export interface FreeUp {
  count: number;
  bytes: number;
  items: { id: number; video: boolean }[];
}

// What can go: all photos the server has, or of these content ids only
export function freeUpScan(server: string, only?: string[]): Promise<FreeUp> {
  return callLocal<FreeUp>("phone_free_up_scan", { server, only: only ?? null });
}

// Into the phone's trash (30 days); false when the question was answered no
export function moveToTrash(scan: FreeUp): Promise<boolean> {
  return callLocal<boolean>("phone_trash", { items: scan.items });
}
