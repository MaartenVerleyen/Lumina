// A server photo's history (get_photo_history): who changed it and when, one row per editing command. The
// server keeps the command's name only, not what it set, so the words say what kind of change it was.

export interface PhotoChange {
  // Seconds since 1970
  at: number;
  // The account's name, "" for an account that was removed since
  user: string;
  // The command, e.g. "set_photos_rating"
  what: string;
}

const WORDS: Record<string, string> = {
  set_photos_rating: "changed the stars",
  set_photo_flag: "changed the pick or reject",
  set_photo_color_label: "changed the colour label",
  add_tag_batch: "added a tag",
  remove_tag_batch: "removed a tag",
  remove_tag: "removed a tag",
  add_person_to_photos: "added a person",
  remove_person_from_photos: "removed a person",
  remove_person_from_photo: "removed a person",
  assign_face_region_and_automatch: "named a face",
  assign_faces_to_person_batch: "named a face",
  unassign_faces_batch: "took a name off a face",
  remove_face_box: "removed a face box",
  ignore_faces: "marked a face as not a face",
  reject_face_candidates_batch: "said a face isn't someone",
  unreject_face_candidates_batch: "took back that a face isn't someone",
  detect_faces_in_photo: "looked for faces",
  add_to_album: "added it to an album",
  remove_from_album: "took it out of an album",
  set_photo_rotation: "turned it",
  set_photos_rotation_exact: "turned it",
  set_manual_location: "set the place",
  shift_capture_timestamps: "changed the time",
  rescan_exif_batch: "read the photo's information again",
  stage_photo_move: "planned a move",
  stage_photos_move: "planned a move",
  stage_duplicate_extras: "marked it as an extra copy",
  ai_analyze_photo: "made an AI caption",
};

// "Anna changed the stars"; a removed account is "Someone"
export function describeChange(c: Pick<PhotoChange, "user" | "what">): string {
  const who = c.user || "Someone";
  return `${who} ${WORDS[c.what] ?? c.what.replace(/_/g, " ")}`;
}

// The same person doing the same thing several times in a row (a rating changed three times) shows once, with
// the newest time
export function collapseChanges(list: PhotoChange[]): (PhotoChange & { times: number })[] {
  const out: (PhotoChange & { times: number })[] = [];
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && last.user === c.user && describeChange(last) === describeChange(c)) last.times += 1;
    else out.push({ ...c, times: 1 });
  }
  return out;
}
