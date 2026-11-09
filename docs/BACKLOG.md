# Backlog

Bugs and small improvements waiting for a fix. Newest at the bottom of each list; strike through or remove an item
once it is fixed and released (with the version).

## Bugs

### Face review (`src/components/modals/FaceMatchReviewModal.tsx`)

- [x] **Switching Grid → One by one → Grid loses the place in the grid.** *Fixed in 5.5.1.* Back in Grid, the list starts at the top
  again. Likely cause: the grid is only rendered while `reviewMode === "grid"`, so its scroll container is
  unmounted while One by one is shown and comes back at 0. Fix idea: keep the scroll position per person in a ref
  and restore it, or hide the grid instead of unmounting it.
- [x] **Videos show as broken images.** *Fixed in 5.5.1.* Video faces look broken in Face review but play fine in the library.
  Likely cause: One by one shows the whole photo with `<img src={mediaUrl({ kind: "original", ... })}>`, which a
  video can't be. Fix idea: for a video, show the frame the face was found in (the face id carries the frame),
  or the video's thumbnail, instead of the original. Check the grid's face crops for videos too.
- [x] **Switching to another person keeps the grid's scroll position.** *Fixed in 5.5.1.* Choosing another person in the list on
  the left should start their faces at the top. Fix idea: reset the grid's scroll to the top when
  `activePerson` (or the tab) changes. Together with the first item: remember the position while switching views
  for the same person, start at the top for a new person.
- [x] **One by one: some photos load very slowly or not at all, while the face box already shows.** *Fixed in 5.5.1.* Likely cause:
  One by one loads the full original file for every photo (large JPEGs, RAW and HEIC files take long to load or
  decode), and the face box is drawn on top straight away, before the photo has loaded. Only the next photo is
  loaded ahead. Fix idea: show the thumbnail at once and swap in the larger image when it has loaded, show the
  face box only once the photo is there, and load the next two or three ahead. Check RAW and HEIC files on
  their own, in case they never load in the window at all.
- [x] **Who is this?: naming a big group names hundreds of faces you can't see or zoom in on.** *Fixed in 5.5.1.* A group can hold
  1000+ faces, but only 12 are shown, and "Name all" names every one of them (`face_ids`, not just the shown
  `samples`). The faces are also small, with no way to see them bigger or open their photo. Same on the phone
  (`phone/FaceReview.tsx`). Decided (8 Nov): showing 12 is fine. Naming a group names only the faces shown (minus
  any left out); the rest of the group then comes back as suggestions for that person in the normal review, where
  each is checked. And a group can be opened in a larger view: bigger faces, and a click on a face shows the
  photo it is in. No engine change needed (the samples carry their face crop and photo).

## Improvements

- [ ] **First index of a large library on a spinning disk is slow** (about 10–35 files per second, limited by
  seeks). Done already: indexing saves as it goes and shows files per second and time left. Open: fewer seeks per
  photo; the head and tail read is part of the content hash, so only the extra file opens (some HEIC metadata)
  are candidates. Measure on a fresh index first.
