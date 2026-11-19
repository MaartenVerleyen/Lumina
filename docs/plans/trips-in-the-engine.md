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

## Agreed with Maarten (2026-11-19)

- The plan, its tables (`moments`, `moment_photos`) and the apps getting trips from the engine.
- Names in English.
- A big day below 50 photos can come from captions alone (a birthday with 15 photos).
- The engine's names use people's names, also when the trip is shared with a guest.
- **Real examples:** a first try over a copy of cachy's database (2021 on, with people and caption words) is being
  checked by Maarten entry by entry; milestone 3 is checked against his answers. What the first try showed: in
  2022 most of the 35 big days are ordinary days with many photos; a batch of 436 photos on one day all with "beach"
  in the caption (a wrong date?); whose birthday it is can't be told from who is in most photos when that's the
  household (the four people in far more photos than anyone else).
- **His first 24 answers** (2021 to Aug 2022; kept with the check page, not in this repository): 3 right, 4 not a
  trip or big day, 17 renamed or joined. What they teach:
  - *Joining.* A journey abroad split in two by a gap of a little over two days should be one trip. Days of one
    occasion belong together: two days around a birth; several days at the same place that isn't home (a hospital)
    over a few weeks.
  - *Names are occasions, not places:* "New year's trip to Strasbourg" (the dates say New Year), "France - Summer
    of 2021" (a long summer trip abroad), "Birthday of a friend", "Grandparents visit", "Family gathering".
  - *Who:* a pet is a named "person" and names days ("Walk with …", "Beach with …"). Two guests in a fifth to a
    third of the photos are a visit, not a "Party" because of balloons. Many different guests, each in few photos,
    are a family gathering. A birthday is named after a person only when that person is clearly in it.
  - *Too many big days:* ordinary days with many photos (a newborn at home), and a "Christmas" from 14 photos
    after the holidays, are not big days.
  - Engine names can't know everything ("Hospital", "Baroque weekend"): the aim is fewer wrong groupings and names
    that are close enough to keep or to change in one go.

## Milestone 3 as built (rule 2, `moments.rs`)

- **What the library says about people:** the household is the people in at least 40% as many photos as the
  person in most; a pet is a "person" whose photos' captions name a dog or a cat (60%+); a guest is anyone else.
- **Trips** in the same country abroad less than four days apart are one journey. Names: "New year's trip to X"
  (over the turn of the year), "Wedding in X", "Ski trip to X", "X - Summer of 2021" (5+ days abroad starting in June
  to August), "Beach trip with <pet>" / "Beach trip to X" (also snow and walking), "Day trip to X", "Weekend in X",
  with " with A & B" for one or two guests in 30%+ of the photos. Otherwise no title: the place is shown.
- **Long stays:** days at or near home whose captions name a hospital (25%+), no more than nine days apart, are
  one "Hospital stay". A household member first seen at its start makes its first two days "Birth of <name>"; the
  day after it is "Homecoming".
- **Big days need a reason:** an occasion (wedding, birthday, Christmas in December up to the 26th, New Year's Eve,
  a party), which also makes a day of 10+ photos a big day; or, from 50 photos, guests ("Family gathering" for four
  or more, "Visit from A & B" for one or two in 15%+) or something done (beach, snow, a walk, with the pet). A day
  whose photos mostly have no caption yet keeps the old rule (50 photos). Days in a row with the same name are one.
- On the copy of cachy's database: 99 moments instead of 178, 0.44 s in a debug build. Against Maarten's 24 answers:
  the three "not a big day" are gone, the three joins are made (the summer abroad, the birth, the hospital stay),
  and the names match or are close ("Day trip to … with …" for a themed weekend, "Party with <pet>" for the pet's
  birthday, "Birthday" for a friend's).

### Rule 3, after Maarten's second check (77 answers, about 50 right as they were)

- **Strays:** a phone's photo without a position joins a trip only when that phone has photos with one on the
  trip. The other partner's phone at home made trips include home photos and screenshots. Cameras that never record
  a position (under 5% of their photos) still join, as before.
- **Trip names don't name guests** ("Day trip to Rochefort", not "… with Michiel & Wim"), and a trip named after a
  country gets no "Weekend in"/"Day trip to".
- **Districts are their town** ("Zagreb - Centar" is Zagreb).
- **Events from captions:** festival, concert, race (circuit), exhibition or museum, for trips ("Festival in …") and
  for days ("Exhibition"); they count as occasions.
- **A day out:** most of a day in a town that isn't one of home's towns (20%+ of the photos near home) and 15+ km
  away is "Day trip to …", a trip, after a gathering and before a visit ("Visit from Annie" was a day out).
- **A second guest** is named from a third of the first one's share ("Visit from John & Sabine" with 33% and 6%).
- What engine names can't know: a bachelor party, a conference, a circuit's name, small day trips that weren't
  trips (to family nearby), a party that wasn't one.

## Checks

- Engine tests: the cases of `tests/trips.test.ts`, plus people joining a day without GPS, a caption naming a big
  day, ids kept when a trip is made again, a guest seeing only shared photos' trips.
- On cachy (a copy of the database, never the real one): the trips and big days for the library, timed, compared
  with Maarten's list; a second run with nothing changed does nothing.
- On the phone: no trip work in the timings (`view:` steps), Albums → Trips opens at once.
