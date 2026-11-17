import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTrips, formatDateRange, tripLabel, timeOf, distanceKm, type TripPhoto } from "../src/utils/trips.ts";

const HOME: [number, number] = [50.93, 4.33]; // Meise
const PARIS: [number, number] = [48.86, 2.35];
const LYON: [number, number] = [45.76, 4.84];
const NOW = Date.UTC(2026, 10, 17);

let n = 0;
function burst(day: string, hour: number, count: number, gps: [number, number] | null, location = "", extra: Partial<TripPhoto> = {}): TripPhoto[] {
  return Array.from({ length: count }, (_, i) => ({
    hash: `p${n++}`,
    name: `IMG_${n}.jpg`,
    captured_at: `${day} ${String(hour).padStart(2, "0")}:${String(i).padStart(2, "0")}:00`,
    location,
    latitude: gps ? gps[0] : null,
    longitude: gps ? gps[1] : null,
    tags: [],
    camera_model: "Pixel 7",
    ...extra,
  }));
}
// Home is where most GPS photos are
const homeBulk = () => burst("2024:05:01", 10, 30, HOME, "Meise, BE");

test("time parsing and distance", () => {
  assert.equal(timeOf("2024:06:15 18:30:00"), Date.UTC(2024, 5, 15, 18, 30, 0));
  assert.equal(timeOf(""), null);
  assert.ok(Math.abs(distanceKm(HOME, PARIS) - 264) < 10);
});

test("days at home aren't listed, unless they are big days", () => {
  n = 0;
  const photos = [...homeBulk(), ...burst("2024:05:04", 14, 6, HOME, "Meise, BE"), ...burst("2024:05:10", 12, 55, HOME, "Meise, BE")];
  const trips = computeTrips(photos, NOW);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].kind, "event");
  assert.equal(trips[0].count, 55);
  assert.equal(trips[0].place, "Meise");
});

test("days away close together are one trip, named after the place", () => {
  n = 0;
  const photos = [
    ...homeBulk(),
    ...burst("2024:06:12", 9, 8, PARIS, "Paris, FR"),
    ...burst("2024:06:13", 9, 8, PARIS, "Paris, FR"),
    ...burst("2024:06:15", 9, 8, PARIS, "Versailles, FR"),
    ...burst("2024:06:20", 9, 8, HOME, "Meise, BE"),
  ];
  const trips = computeTrips(photos, NOW);
  assert.equal(trips.length, 1);
  const paris = trips[0];
  assert.equal(paris.kind, "trip");
  assert.equal(paris.count, 24);
  assert.equal(paris.place, "Paris & Versailles");
  assert.equal(tripLabel(paris), "Paris & Versailles · 12–15 Jun 2024");
  assert.equal(tripLabel(paris, "Paris with the kids"), "Paris with the kids · 12–15 Jun 2024");
});

test("a day without GPS between two days away belongs to the trip", () => {
  n = 0;
  const photos = [
    ...homeBulk(),
    ...burst("2024:06:12", 9, 8, PARIS, "Paris, FR"),
    ...burst("2024:06:13", 9, 7, null),
    ...burst("2024:06:14", 9, 8, PARIS, "Paris, FR"),
    // after the last day away, and no day away follows: not the trip's (and too small for a big day)
    ...burst("2024:06:15", 9, 6, null),
  ];
  const trips = computeTrips(photos, NOW);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].count, 23);
});

test("WhatsApp photos and screenshots make no trip and join none", () => {
  n = 0;
  const photos = [
    ...homeBulk(),
    ...burst("2024:07:01", 9, 10, null, "", { tags: ["whatsapp"] }),
    ...burst("2024:07:02", 9, 6, PARIS, "Paris, FR"),
    ...burst("2024:07:02", 15, 5, null, "", { tags: ["screenshot"] }),
    ...burst("2024:08:01", 9, 60, LYON, "Lyon, FR", { tags: ["whatsapp"] }),
  ];
  const trips = computeTrips(photos, NOW);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].count, 6);
});

test("a copy of a photo in another library counts once", () => {
  n = 0;
  const day = burst("2024:06:12", 9, 6, PARIS, "Paris, FR");
  const copies = day.map((p) => ({ ...p, hash: `${p.hash}-copy` }));
  const trips = computeTrips([...homeBulk(), ...day, ...copies], NOW);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].count, 6);
  assert.equal(trips[0].hashes.length, 12);
});

test("a journey through many places is named after its country", () => {
  n = 0;
  const photos = [
    ...homeBulk(),
    ...burst("2024:06:12", 9, 6, PARIS, "Paris, FR"),
    ...burst("2024:06:13", 9, 6, PARIS, "Versailles, FR"),
    ...burst("2024:06:14", 9, 6, LYON, "Lyon, FR"),
    ...burst("2024:06:15", 9, 6, LYON, "Annecy, FR"),
  ];
  const trips = computeTrips(photos, NOW);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].place, "France");
});

test("received and downloaded images (no camera, no GPS) make no trip and join none", () => {
  n = 0;
  const photos = [
    ...homeBulk(),
    ...burst("2024:04:30", 9, 60, null, "", { camera_model: null }),
    ...burst("2024:06:12", 9, 6, PARIS, "Paris, FR"),
    ...burst("2024:06:12", 15, 9, null, "", { camera_model: "" }),
  ];
  const trips = computeTrips(photos, NOW);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].count, 6);
});

test("a day that starts at home and ends away is split at the line around home", () => {
  n = 0;
  const NEAR: [number, number] = [50.95, 4.36];
  const photos = [...homeBulk(), ...burst("2024:08:29", 8, 20, NEAR, "Meise, BE"), ...burst("2024:08:29", 12, 6, PARIS, "Paris, FR")];
  const trips = computeTrips(photos, NOW);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].count, 6);
  assert.equal(trips[0].place, "Paris");
});

test("a 100 km jump splits a day: only the part away is a trip", () => {
  n = 0;
  const photos = [...homeBulk(), ...burst("2024:07:01", 8, 6, HOME), ...burst("2024:07:01", 9, 6, PARIS)];
  const trips = computeTrips(photos, NOW);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].count, 6);
});

test("photos without a date, a camera's unset clock or a date to come make no trip", () => {
  n = 0;
  const photos = [
    ...homeBulk(),
    ...burst("", 0, 10, PARIS).map((p) => ({ ...p, captured_at: "" })),
    ...burst("2000:01:01", 0, 60, null),
    ...burst("2027:03:01", 9, 8, PARIS, "Paris, FR"),
  ];
  assert.deepEqual(computeTrips(photos, NOW), []);
});

test("date ranges", () => {
  const d = (s: string) => timeOf(`${s} 12:00:00`)!;
  assert.equal(formatDateRange(d("2024:06:12"), d("2024:06:12")), "12 Jun 2024");
  assert.equal(formatDateRange(d("2024:06:30"), d("2024:07:02")), "30 Jun – 2 Jul 2024");
  assert.equal(formatDateRange(d("2023:12:28"), d("2024:01:03")), "28 Dec 2023 – 3 Jan 2024");
});
