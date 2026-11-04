# Sharing dynamic albums

A dynamic album (a saved search, `saved_searches`) can be shared with a user the way an album can. The guest
sees it as an album with its photos, never its query, and it keeps up by itself: a photo that comes to match
appears, one that stops matching goes.

## Decisions (Maarten, 2026-11-04)

- Every part of the search language works in a shared dynamic album: `key:value` terms (rating, flag, label,
  person, tag, camera, lens, place, date, has, is, album, name, negated with `-`), plain words understood as
  terms ("emma summer 2024", "kerst bij oma"), and free text.
- The guest never sees the query: not in an answer, not in an event.
- The server runs the search itself, with a Rust copy of the frontend's search language in lumina-core
  (`search.rs`). One file of examples, `tests/fixtures/search-cases.json`, is run by `npm test` and by
  `cargo test`, so the two copies can't drift apart.
- Free text means what it meant when the search was saved: smart search or plain text. Saving a search
  records it (`saved_searches.smart`, a new column; migrations add it on open). Reopening the search sets the
  smart search switch the same way.
- A guest sees only the albums shared with them. An album that wasn't shared shows a user only the photos of
  it in libraries they have a role on, so a photo shared through one album never reveals the other albums it
  is in.

## How it works

- `search_shares (search_id, user_id, shared_by)` on the server, next to `album_shares`. The search runs over
  the libraries where `shared_by` is an editor (admins: all), so sharing gives away no more than the person
  sharing may change. If they lose that role, the album shrinks with it.
- The server keeps each shared search's photos in `search_share_photos (search_id, hash)`, and the scope reads
  them as it reads `album_photos`. A request never runs a search.
- The photos are worked out again after anything that can change them (photos-changed, people-changed,
  albums-changed, a finished scan, thumbnails, faces, captions or smart search index, files changed in a
  library, shares-changed), a second after the last such event, and once an hour for dates like "last week".
  When a search's photos change, the server sends albums-changed, so guests' windows list the library again.
- A guest gets the shared dynamic albums from `get_albums` as albums (`"dynamic": true`, id `-<search id>`),
  with only their visible photos. `get_saved_searches` stays empty for them.
- Editors share from Collections, with the same dialog as albums (`get_search_shares`, `share_search`).
  Deleting a saved search or a user removes its shares. A restore carries the shares over by search name.
- What the browser applies that the server can't know is left out: the eye and focus checks (`is:blinking`,
  `is:blurry`) use the default sensitivity, and Live Photo clips are left out as in the grid (the photo plays
  them).

## Done when

- The shared examples pass in both languages (`npm test`, `cargo test -p lumina-core`).
- On the test server: test-editor shares a dynamic album `person:Maarten` with test-guest; test-guest sees
  exactly the photos of Maarten, as an album called by the search's name, and no query anywhere (answers,
  events). Naming Maarten in another photo makes it appear for test-guest without a reload; removing him makes
  it go. Unsharing empties the guest's window.
- A smart-search dynamic album ("rocket launch", saved with smart search on) gives the guest the same photos
  the editor sees when opening it.
