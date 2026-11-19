// Trips and big days, as the engine makes them (lumina-core moments.rs) and the apps show them

export interface Trip {
  // Stable while most of its photos stay the same (custom names are stored under it)
  id: string;
  kind: "event" | "trip";
  place: string;
  // The name the engine gave it; a name someone gave wins over it
  title: string;
  start: number;
  end: number;
  // How many photos in the open folder, a copy counted once
  count: number;
  // Up to four photos spread over it; the rest come with get_moment_photos when it is opened
  cover: string[];
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

export function tripLabel(trip: Pick<Trip, "start" | "end" | "place" | "title">, customName?: string): string {
  const range = formatDateRange(trip.start, trip.end);
  const name = customName || trip.title || trip.place;
  return name ? `${name} · ${range}` : range;
}
