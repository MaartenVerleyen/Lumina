import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTrips, formatDateRange, tripLabel, timeOf, distanceKm } from "../src/utils/trips.ts";

const HOME: [number, number] = [50.93, 4.33]; // Meise
const PARIS: [number, number] = [48.86, 2.35];

let n = 0;
function burst(day: string, hour: number, count: number, gps: [number, number] | null, location = "") {
  return Array.from({ length: count }, (_, i) => ({
    hash: `p${n++}`,
    captured_at: `${day} ${String(hour).padStart(2, "0")}:${String(i).padStart(2, "0")}:00`,
    location,
    latitude: gps ? gps[0] : null,
    longitude: gps ? gps[1] : null,
  }));
}

test("time parsing and distance", () => {
  assert.equal(timeOf("2024:06:15 18:30:00"), Date.UTC(2024, 5, 15, 18, 30, 0));
  assert.equal(timeOf(""), null);
  assert.ok(Math.abs(distanceKm(HOME, PARIS) - 264) < 10);
});

test("home days split into events, small groups are dropped", () => {
  n = 0;
  const photos = [
    ...burst("2024:05:01", 10, 30, HOME, "Meise, BE"), // home bulk (defines home)
    ...burst("2024:05:04", 14, 6, HOME, "Meise, BE"),
    ...burst("2024:05:05", 14, 3, HOME, "Meise, BE"), // too small
  ];
  const trips = computeTrips(photos);
  assert.equal(trips.length, 2);
  assert.ok(trips.every((t) => t.kind === "event"));
  assert.equal(trips[1].hashes.length, 6);
});

test("a multi-day stay away from home becomes one trip named after the place", () => {
  n = 0;
  const photos = [
    ...burst("2024:05:01", 10, 30, HOME, "Meise, BE"),
    ...burst("2024:06:12", 9, 8, PARIS, "Paris, FR"),
    ...burst("2024:06:13", 9, 8, PARIS, "Paris, FR"),
    ...burst("2024:06:15", 9, 8, PARIS, "Versailles, FR"),
    ...burst("2024:06:20", 9, 8, HOME, "Meise, BE"),
  ];
  const trips = computeTrips(photos);
  const paris = trips.find((t) => t.kind === "trip");
  assert.ok(paris);
  assert.equal(paris.hashes.length, 24);
  assert.equal(paris.place, "Paris & Versailles");
  assert.equal(tripLabel(paris), "Paris & Versailles · 12–15 Jun 2024");
  assert.equal(tripLabel(paris, "Paris with the kids"), "Paris with the kids · 12–15 Jun 2024");
  assert.equal(trips.length, 3);
});

test("a 100 km jump splits even without a time gap", () => {
  n = 0;
  const photos = [...burst("2024:07:01", 8, 6, HOME), ...burst("2024:07:01", 9, 6, PARIS)];
  assert.equal(computeTrips(photos).length, 2);
});

test("photos without a date are ignored", () => {
  n = 0;
  const photos = burst("", 0, 10, HOME).map((p) => ({ ...p, captured_at: "" }));
  assert.deepEqual(computeTrips(photos), []);
});

test("date ranges", () => {
  const d = (s: string) => timeOf(`${s} 12:00:00`)!;
  assert.equal(formatDateRange(d("2024:06:12"), d("2024:06:12")), "12 Jun 2024");
  assert.equal(formatDateRange(d("2024:06:30"), d("2024:07:02")), "30 Jun – 2 Jul 2024");
  assert.equal(formatDateRange(d("2023:12:28"), d("2024:01:03")), "28 Dec 2023 – 3 Jan 2024");
});
