import { test } from "node:test";
import assert from "node:assert/strict";
import { remapPath, remapSettings, backupName, backupDue } from "../src/utils/backup.ts";

const remaps = [
  // A trailing separator on the new folder is fine
  { from: String.raw`D:\Photos`, to: "E:\\Pictures\\" },
  { from: String.raw`D:\Photos\Phone`, to: String.raw`F:\Phone` },
];

test("paths move to the longest matching new folder", () => {
  assert.equal(remapPath(String.raw`D:\Photos\2023\a.jpg`, remaps), String.raw`E:\Pictures\2023\a.jpg`);
  assert.equal(remapPath(String.raw`d:\photos\Phone\b.heic`, remaps), String.raw`F:\Phone\b.heic`);
  assert.equal(remapPath(String.raw`D:\Photos`, remaps), String.raw`E:\Pictures`);
  assert.equal(remapPath(String.raw`D:\Photos2\c.jpg`, remaps), null);
});

test("settings keep their shape, with folder paths moved along", () => {
  const saved = {
    lumina_active_folder: String.raw`D:\Photos`,
    lumina_recent_folders: JSON.stringify([String.raw`D:\Photos`, String.raw`C:\Other`]),
    lumina_gallery_settings: JSON.stringify({ destDir: String.raw`D:\Photos\Galleries`, zip: true }),
    lumina_settings: JSON.stringify({ gridStyle: "square", lastBackupAt: 5 }),
  };
  const out = remapSettings(saved, remaps);
  assert.equal(out.lumina_active_folder, String.raw`E:\Pictures`);
  assert.deepEqual(JSON.parse(out.lumina_recent_folders), [String.raw`E:\Pictures`, String.raw`C:\Other`]);
  assert.deepEqual(JSON.parse(out.lumina_gallery_settings), { destDir: String.raw`E:\Pictures\Galleries`, zip: true });
  assert.deepEqual(JSON.parse(out.lumina_settings), { gridStyle: "square", lastBackupAt: 5 });
});

test("backup names sort by date, automatic ones share a prefix", () => {
  const d = new Date(2026, 9, 7, 9, 5);
  assert.equal(backupName("manual", d), "Lumina backup 2026-10-07 0905");
  assert.equal(backupName("auto", d), "Lumina auto-backup 2026-10-07 0905");
});

test("automatic backups are due after their interval", () => {
  const day = 86_400_000;
  assert.equal(backupDue("off", 0, 10 * day), false);
  assert.equal(backupDue("daily", 9 * day, 10 * day), true);
  assert.equal(backupDue("weekly", 9 * day, 10 * day), false);
  assert.equal(backupDue("weekly", 0, 10 * day), true);
});
