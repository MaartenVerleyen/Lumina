# Trips and big days, made by the engine

Today every window works out trips itself, from the photo list it has (`src/utils/trips.ts`, `computeTrips`). That
has three problems:

- **It knows too little.** It sees only dates, GPS and place names. On cachy only 10,325 of 107,588 photos have GPS,
  so most days can't be placed, and a day without GPS can't be told apart from a day at home. It can't see who is
  in the photos or what they show.
- **It costs the phone.** Every window works out the trips over every photo (0.1–0.2 s on a PC, about 0.5 s on the
  phone for 110,000 photos), and again when dates or places change.
- **It differs per device.** A trip's id is its first photo; another list (another library taken off All photos,
  a copy that arrived) can give the same trip another id, and its name is lost.

This plan moves trips and big days into the engine (`lumina-core`), which the server and the desktop app share.
The server makes them in the background for its libraries, and the desktop for its own folders. The apps only
show them.

## What a trip and a big day are

The rule from 6.3.4 stays the base (`trips.ts`, agreed 2026-11-17):

- Photos someone took: with a camera model or GPS, not WhatsApp, not a screenshot. Received, downloaded and edited
  images make no trip and join none.
- Days split at 12+ hours without photos, a jump of 100+ km, and where photos cross the line 50 km around home.
- A trip is the days 50+ km from home less than two days apart; days without GPS between two days away belong to
  it. A big day is a day at home with 50+ photos. Copies in two libraries count once.

The engine adds what only it knows:

- **People.** A day without GPS with the same people as the trip around it belongs to the trip. A big day is named
  after the people in it when one or two people are in most of its photos ("Emma's birthday" needs the caption
  too, see below). A day at home with fewer than 50 photos but many of one family counts as a big day.
- **Captions and tags** (Ollama, `ai_caption`, tags). Words like birthday, wedding, party, Christmas, beach, snow
  or a cake with candles say what a day was. They name it ("Birthday · Emma", "Christmas at home", "Beach ·
  Koksijde") and can make a smaller day a big day (a birthday with 20 photos).
- **Smart search** (CLIP). For a day without captions yet: how close its photos are to a few fixed descriptions
  ("a birthday party", "a wedding", "a beach", "snow in the mountains"). Used only where captions are missing.
- **Home.** Worked out from the library as now (the densest GPS area), and settable in Settings for whoever moved
  house (a list of homes with the year they start, later; not in the first version).

## How it works

- **A job of the server's pipeline**, after faces, smart search and captions (`lumina-server/src/pipeline.rs`). It
  makes the trips and big days of a library again when something they come from changed: photos added or gone,
  dates, places, people or captions (the photo revision counter, `revision.rs`, says what changed since the last
  run). For 110,000 photos this is about a second on the server; nothing is done when nothing changed.
- **The desktop app** runs the same job for its own folders after a scan, on the background pool.
- **Stored in the library's database** (new tables, made by `db::migrate`):
  - `moments (id, library_id, kind, start, end, place, title, cover_hash, made_from)`: `kind` trip or big day,
    `title` the name the engine gave it, `made_from` what it was made from (for keeping ids, below).
  - `moment_photos (moment_id, hash)`.
  - `trip_names` stays: a name someone gave wins over the engine's title.
- **Stable ids.** A trip made again (one more photo, a changed caption) keeps its id when most of its photos are
  the same, so a name given to it stays. Today's ids (the first photo's hash) carry over: the first run gives each
  new trip the id of an old trip id among its photos, so names given before are kept.
- **Commands:** `get_moments(rootFolder)` answers the trips and big days with their counts and covers, not their
  photos; `get_moment_photos(id)` the photos of one. Events: `moments-changed` when a run changed something.
- **On the server**, roles apply as for albums: a guest sees a trip only through photos shared with them (the
  scope), never a trip of photos they can't see.
- **All photos** asks each engine for its moments and shows them side by side. A trip in two libraries (the same
  photos on this PC and on the server) is shown once, from the library that has most of its photos.
- **The apps** drop `computeTrips`. The phone no longer works out trips at all; the grid filters a trip by the
  photos the engine named.

## Milestones

1. **The rule in Rust** (`lumina-core/src/moments.rs`), with the cases of `tests/trips.test.ts` as engine tests, the
   tables, the commands and the job on the server. The apps show the server's moments in a server library and in
   All photos; this PC's folders still use the old rule until milestone 2.
2. **The desktop's own folders** through the same job; `computeTrips` and its tests go.
3. **People and captions:** joining days by people, naming by people and caption words, smaller big days found
   through captions. Checked on cachy against a list of real trips and big days Maarten writes down (about 20).
4. **Smart search** for days without captions, and the home setting, if 3 leaves gaps.

## What needs Maarten

- **Agreeing this plan**: it adds tables to the database and changes how the apps get trips (from the engine
  instead of working them out), both things CLAUDE.md asks to agree first.
- **About 20 real trips and big days** from the library on cachy, with their dates and what they should be called,
  to check milestone 3 against.
- **Choices:**
  - Names in English as now, or Dutch ("Verjaardag · Emma")? The caption model writes English.
  - Should big days below 50 photos come from captions alone (a birthday with 15 photos), or only with people
    in them too?
  - Should the engine's names use people's names ("Emma's birthday") when the trip is shared with a guest who
    doesn't know who Emma is? (Suggested: yes, they are the names the person sharing gave.)

## Checks

- Engine tests: the cases of `tests/trips.test.ts`, plus people joining a day without GPS, a caption naming a big
  day, ids kept when a trip is made again, a guest seeing only shared photos' trips.
- On cachy (a copy of the database, never the real one): the trips and big days for the library, timed, compared
  with Maarten's list; a second run with nothing changed does nothing.
- On the phone: no trip work in the timings (`view:` steps), Albums → Trips opens at once.
