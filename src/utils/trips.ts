// Automatic events and trips from capture time and GPS.
// 1. Events: photos in time order, split where there is a gap of 12+ hours or a jump of 100+ km.
// 2. Trips: consecutive events away from home (the library's densest GPS area) that are less than two days
//    apart are merged, so a week abroad is one trip instead of seven days.
// Groups of fewer than 5 photos are left out. Pure functions, unit-tested.

export interface TripPhoto {
  hash: string;
  captured_at: string;
  location: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface Trip {
  // Stable while the first photo stays the same (custom names are stored under it)
  id: string;
  kind: "event" | "trip";
  place: string;
  start: number;
  end: number;
  hashes: string[];
}

const HOUR = 3_600_000;
const EVENT_GAP = 12 * HOUR;
const TRIP_GAP = 48 * HOUR;
const JUMP_KM = 100;
const AWAY_KM = 50;
const MIN_PHOTOS = 5;

// "2024:06:15 18:30:00" -> ms (as UTC: only differences matter)
export function timeOf(capturedAt: string): number | null {
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/.exec(capturedAt || "");
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isFinite(t) && +m[1] > 1971 ? t : null;
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

interface Group {
  photos: { p: TripPhoto; t: number }[];
  away: boolean;
}

function centroid(group: Group): [number, number] | null {
  let n = 0, lat = 0, lon = 0;
  for (const { p } of group.photos) {
    const g = gpsOf(p);
    if (g) {
      n++;
      lat += g[0];
      lon += g[1];
    }
  }
  return n ? [lat / n, lon / n] : null;
}

// Most common place name ("Paris, FR" -> "Paris"); a second place is added when it is common too
function placeName(group: Group): string {
  const counts = new Map<string, number>();
  for (const { p } of group.photos) {
    const city = p.location?.split(",")[0].trim();
    if (city) counts.set(city, (counts.get(city) || 0) + 1);
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return "";
  if (ranked.length === 1) return ranked[0][0];
  const [first, second] = ranked;
  const extra = ranked.length > 2 ? ` +${ranked.length - 2}` : "";
  return second[1] >= first[1] * 0.25 ? `${first[0]} & ${second[0]}${extra}` : first[0];
}

export function computeTrips(photos: TripPhoto[]): Trip[] {
  const timed = photos
    .map((p) => ({ p, t: timeOf(p.captured_at) }))
    .filter((x): x is { p: TripPhoto; t: number } => x.t !== null)
    .sort((a, b) => a.t - b.t);
  if (timed.length === 0) return [];
  const home = homeOf(photos);

  // 1. Events
  const events: Group[] = [];
  let current: Group = { photos: [], away: false };
  let lastGps: [number, number] | null = null;
  let lastT = -Infinity;
  for (const x of timed) {
    const g = gpsOf(x.p);
    const jumped = g && lastGps ? distanceKm(g, lastGps) >= JUMP_KM : false;
    if (current.photos.length > 0 && (x.t - lastT >= EVENT_GAP || jumped)) {
      events.push(current);
      current = { photos: [], away: false };
      lastGps = null;
    }
    current.photos.push(x);
    if (g) lastGps = g;
    lastT = x.t;
  }
  events.push(current);
  for (const e of events) {
    const c = centroid(e);
    e.away = Boolean(home && c && distanceKm(home, c) > AWAY_KM);
  }

  // 2. Trips: away-from-home events close in time
  const groups: (Group & { merged: number })[] = [];
  for (const e of events) {
    const prev = groups[groups.length - 1];
    const gap = prev ? e.photos[0].t - prev.photos[prev.photos.length - 1].t : Infinity;
    if (prev && prev.away && e.away && gap < TRIP_GAP) {
      prev.photos.push(...e.photos);
      prev.merged++;
    } else {
      groups.push({ ...e, photos: [...e.photos], merged: 1 });
    }
  }

  return groups
    .filter((g) => g.photos.length >= MIN_PHOTOS)
    .map((g) => ({
      id: g.photos[0].p.hash,
      kind: g.merged > 1 || (g.away && g.photos[g.photos.length - 1].t - g.photos[0].t > 20 * HOUR) ? "trip" : "event",
      place: placeName(g),
      start: g.photos[0].t,
      end: g.photos[g.photos.length - 1].t,
      hashes: g.photos.map((x) => x.p.hash),
    }));
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
