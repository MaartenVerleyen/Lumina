// Trips and big days, from capture time and GPS.
// 1. Days: photos in time order, split where there is a gap of 12+ hours, a jump of 100+ km, or where the
//    photos cross the line 50 km around home (a morning at home and an afternoon at the coast are two parts).
// 2. Each day is away (its GPS photos 50+ km from home, the library's densest GPS area), at home, or unknown
//    (no GPS). A trip is the days away that follow each other with less than two days between them; days
//    without GPS between two days away belong to it (a camera without GPS on the same journey).
// 3. Days at home with many photos (a birthday, a party) are big days. Other days at home aren't listed.
// Only photos someone took make or join one: with a camera or a GPS position, and not WhatsApp or a screenshot.
// Received, downloaded and edited images carry the date they arrived, and a screen is no place. Copies of a
// photo (the same name and time, in two libraries) count once. Pure functions, unit-tested.

export interface TripPhoto {
  hash: string;
  captured_at: string;
  location: string;
  latitude?: number | null;
  longitude?: number | null;
  name?: string;
  tags?: string[];
  camera_model?: string | null;
}

export interface Trip {
  // Stable while the first photo stays the same (custom names are stored under it)
  id: string;
  kind: "event" | "trip";
  place: string;
  start: number;
  end: number;
  // Every photo of it, copies too (the grid shows them all)
  hashes: string[];
  // How many photos, a copy counted once
  count: number;
}

const HOUR = 3_600_000;
const DAY_GAP = 12 * HOUR;
const TRIP_GAP = 48 * HOUR;
const JUMP_KM = 100;
const AWAY_KM = 50;
const MIN_TRIP_PHOTOS = 5;
const BIG_DAY_PHOTOS = 50;

// "2024:06:15 18:30:00" -> ms (as UTC: only differences matter)
export function timeOf(capturedAt: string): number | null {
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/.exec(capturedAt || "");
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isFinite(t) && +m[1] > 1971 ? t : null;
}

// A clock that was never set (a camera starts at 1 Jan 2000 or 1980, in its first hour) or a date still to come
function impossible(t: number, now: number): boolean {
  const d = new Date(t);
  const firstHour = d.getUTCMonth() === 0 && d.getUTCDate() === 1 && d.getUTCHours() === 0;
  return (firstHour && (d.getUTCFullYear() === 2000 || d.getUTCFullYear() === 1980)) || t > now + 24 * HOUR;
}

// Photos that tell where someone was: taken with a camera or with a position, not received (WhatsApp) and not of
// a screen
function tellsWhere(p: TripPhoto): boolean {
  const taken = !!p.camera_model?.trim() || gpsOf(p) !== null;
  return taken && !p.tags?.some((t) => t === "whatsapp" || t === "screenshot");
}

export function distanceKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const gpsOf = (p: TripPhoto): [number, number] | null =>
  typeof p.latitude === "number" && typeof p.longitude === "number" ? [p.latitude, p.longitude] : null;

// Home = the centre of the densest ~50 km grid cell of all GPS photos
export function homeOf(photos: TripPhoto[]): [number, number] | null {
  const cells = new Map<string, { n: number; lat: number; lon: number }>();
  for (const p of photos) {
    const g = gpsOf(p);
    if (!g) continue;
    const key = `${Math.round(g[0] * 2)}:${Math.round(g[1] * 2)}`;
    const c = cells.get(key) ?? { n: 0, lat: 0, lon: 0 };
    c.n++;
    c.lat += g[0];
    c.lon += g[1];
    cells.set(key, c);
  }
  let best: { n: number; lat: number; lon: number } | null = null;
  for (const c of cells.values()) if (!best || c.n > best.n) best = c;
  return best ? [best.lat / best.n, best.lon / best.n] : null;
}

type Timed = { p: TripPhoto; t: number };
type Where = "away" | "home" | "unknown";

function centroid(photos: Timed[]): [number, number] | null {
  let n = 0;
  let lat = 0;
  let lon = 0;
  for (const { p } of photos) {
    const g = gpsOf(p);
    if (g) {
      n++;
      lat += g[0];
      lon += g[1];
    }
  }
  return n ? [lat / n, lon / n] : null;
}

let countryNames: Intl.DisplayNames | null | undefined;
function countryName(code: string): string {
  if (countryNames === undefined) {
    try {
      countryNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      countryNames = null;
    }
  }
  try {
    return countryNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

// The most common place ("Paris, FR" -> "Paris"), with a second when it is common too. A journey through more
// than three places is named after its country, or its two countries.
function placeName(photos: Timed[]): string {
  const cities = new Map<string, number>();
  const countries = new Map<string, number>();
  for (const { p } of photos) {
    const [city, country] = (p.location ?? "").split(",").map((s) => s.trim());
    if (city) cities.set(city, (cities.get(city) || 0) + 1);
    if (country) countries.set(country, (countries.get(country) || 0) + 1);
  }
  const top = (m: Map<string, number>) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  const ranked = top(cities);
  if (ranked.length === 0) return "";
  if (ranked.length > 3 && countries.size > 0) {
    const [first, second] = top(countries);
    return second && second[1] >= first[1] * 0.25 ? `${countryName(first[0])} & ${countryName(second[0])}` : countryName(first[0]);
  }
  if (ranked.length === 1) return ranked[0][0];
  const [first, second] = ranked;
  return second[1] >= first[1] * 0.25 ? `${first[0]} & ${second[0]}` : first[0];
}

// How many photos, a copy in another library (the same name and time) counted once
function distinct(photos: Timed[]): number {
  return new Set(photos.map(({ p }) => (p.name ? `${p.name}|${p.captured_at}` : p.hash))).size;
}

export function computeTrips(photos: TripPhoto[], now = Date.now()): Trip[] {
  const timed: Timed[] = [];
  for (const p of photos) {
    if (!tellsWhere(p)) continue;
    const t = timeOf(p.captured_at);
    if (t !== null && !impossible(t, now)) timed.push({ p, t });
  }
  timed.sort((a, b) => a.t - b.t);
  if (timed.length === 0) return [];
  const home = homeOf(timed.map((x) => x.p));
  const isAway = (g: [number, number]) => !!home && distanceKm(home, g) > AWAY_KM;

  // 1. Days
  const days: { photos: Timed[]; where: Where }[] = [];
  let current: Timed[] = [];
  let lastGps: [number, number] | null = null;
  let lastT = -Infinity;
  for (const x of timed) {
    const g = gpsOf(x.p);
    const jumped = g && lastGps ? distanceKm(g, lastGps) >= JUMP_KM || isAway(g) !== isAway(lastGps) : false;
    if (current.length > 0 && (x.t - lastT >= DAY_GAP || jumped)) {
      days.push({ photos: current, where: "unknown" });
      current = [];
      lastGps = null;
    }
    current.push(x);
    if (g) lastGps = g;
    lastT = x.t;
  }
  days.push({ photos: current, where: "unknown" });
  for (const d of days) {
    const c = centroid(d.photos);
    d.where = !c || !home ? "unknown" : distanceKm(home, c) > AWAY_KM ? "away" : "home";
  }

  // 2. Trips (days away less than two days apart, and the days without GPS between them); 3. big days
  const out: Trip[] = [];
  const add = (kind: Trip["kind"], group: Timed[]) => {
    const count = distinct(group);
    if (count < (kind === "trip" ? MIN_TRIP_PHOTOS : BIG_DAY_PHOTOS)) return;
    out.push({
      id: group[0].p.hash,
      kind,
      place: placeName(group),
      start: group[0].t,
      end: group[group.length - 1].t,
      hashes: group.map((x) => x.p.hash),
      count,
    });
  };
  let trip: Timed[] | null = null;
  // Days without GPS after the trip's last day away: the trip's when another day away follows soon enough
  let pending: Timed[][] = [];
  const lastOf = (group: Timed[]) => group[group.length - 1].t;
  const endTrip = () => {
    if (trip) add("trip", trip);
    for (const d of pending) add("event", d);
    trip = null;
    pending = [];
  };
  for (const d of days) {
    const last = trip ? lastOf(pending.length ? pending[pending.length - 1] : trip) : -Infinity;
    const near = d.photos[0].t - last < TRIP_GAP;
    if (d.where === "away") {
      if (trip && near) {
        for (const p of pending) trip.push(...p);
        trip.push(...d.photos);
        pending = [];
      } else {
        endTrip();
        trip = [...d.photos];
      }
    } else if (d.where === "unknown" && trip && near) {
      pending.push(d.photos);
    } else {
      endTrip();
      add("event", d.photos);
    }
  }
  endTrip();
  return out.sort((a, b) => a.start - b.start);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "12 Jun 2024", "12–15 Jun 2024", "30 Jun – 2 Jul 2024", "28 Dec 2023 – 3 Jan 2024"
export function formatDateRange(start: number, end: number): string {
  const a = new Date(start);
  const b = new Date(end);
  const [d1, m1, y1] = [a.getUTCDate(), MONTHS[a.getUTCMonth()], a.getUTCFullYear()];
  const [d2, m2, y2] = [b.getUTCDate(), MONTHS[b.getUTCMonth()], b.getUTCFullYear()];
  if (y1 !== y2) return `${d1} ${m1} ${y1} – ${d2} ${m2} ${y2}`;
  if (m1 !== m2) return `${d1} ${m1} – ${d2} ${m2} ${y1}`;
  if (d1 !== d2) return `${d1}–${d2} ${m1} ${y1}`;
  return `${d1} ${m1} ${y1}`;
}

export function tripLabel(trip: Trip, customName?: string): string {
  const range = formatDateRange(trip.start, trip.end);
  const name = customName || trip.place;
  return name ? `${name} · ${range}` : range;
}
