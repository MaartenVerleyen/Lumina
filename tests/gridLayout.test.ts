import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aspectOf,
  buildJustifiedLayout,
  buildSquareLayout,
  verticalNeighbor,
  monthKeyOf,
  monthLabel,
} from "../src/utils/gridLayout.ts";

const landscape = { width: 3000, height: 2000, rotation: 0 }; // 1.5
const portrait = { width: 2000, height: 3000, rotation: 0 }; // 0.667

test("aspect ratio swaps for quarter turns and defaults to 3:2", () => {
  assert.equal(aspectOf(landscape), 1.5);
  assert.equal(aspectOf({ ...landscape, rotation: 90 }), 2000 / 3000);
  assert.equal(aspectOf({ width: 0, height: 0, rotation: 0 }), 1.5);
  assert.equal(aspectOf({ width: 10000, height: 100, rotation: 0 }), 3);
});

test("justified rows fill the width exactly and keep aspect ratios", () => {
  const photos = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? portrait : landscape));
  const layout = buildJustifiedLayout(photos, { width: 1000, gap: 10, headerHeight: 40, targetRowHeight: 200 });
  const photoRows = layout.rows.filter((r) => r.kind === "photos");
  // Every row but the last ends exactly at the right edge
  for (const row of photoRows.slice(0, -1)) {
    if (row.kind !== "photos") continue;
    const last = row.items[row.items.length - 1];
    assert.equal(last.x + last.width, 1000);
    // Widths follow the aspect ratio (within rounding)
    const first = row.items[0];
    assert.ok(Math.abs(first.width - aspectOf(photos[first.index]) * row.height) <= 1.5);
  }
  // Every photo is placed exactly once, in order
  const placed = photoRows.flatMap((r) => (r.kind === "photos" ? r.items.map((it) => it.index) : []));
  assert.deepEqual(placed, photos.map((_, i) => i));
});

test("the last, unfilled row stays at the target height", () => {
  const layout = buildJustifiedLayout([landscape], { width: 1000, gap: 10, headerHeight: 40, targetRowHeight: 200 });
  assert.equal(layout.rows.length, 1);
  const row = layout.rows[0];
  assert.equal(row.height, 200);
  assert.equal(row.kind === "photos" && row.items[0].width, 300);
});

test("month groups start with a header and never share a row", () => {
  const dates = ["2024:06:01", "2024:06:02", "2024:05:30", "2024:05:01"];
  const photos = dates.map((d) => ({ ...landscape, captured_at: d }));
  const layout = buildJustifiedLayout(photos, {
    width: 2000,
    gap: 10,
    headerHeight: 40,
    targetRowHeight: 200,
    groupKey: (i) => monthKeyOf(photos[i].captured_at),
    groupLabel: monthLabel,
  });
  assert.deepEqual(
    layout.rows.map((r) => (r.kind === "header" ? r.label : r.items.map((it) => it.index).join(","))),
    ["June 2024", "0,1", "May 2024", "2,3"]
  );
  // Rows are stacked without overlap
  for (let i = 1; i < layout.rows.length; i++) {
    assert.ok(layout.rows[i].top >= layout.rows[i - 1].top + layout.rows[i - 1].height);
  }
});

test("square layout puts `columns` cards per row", () => {
  const layout = buildSquareLayout(7, { width: 320, gap: 10, headerHeight: 40, columns: 3, cardHeight: 100 });
  assert.deepEqual(
    layout.rows.map((r) => (r.kind === "photos" ? r.items.length : 0)),
    [3, 3, 1]
  );
  const row = layout.rows[0];
  assert.ok(row.kind === "photos" && row.items[1].x === 110 && row.items[1].width === 100);
});

test("up/down moves to the photo with the nearest centre, skipping headers", () => {
  const layout = buildSquareLayout(7, {
    width: 330,
    gap: 10,
    headerHeight: 40,
    columns: 3,
    cardHeight: 100,
    groupKey: (i) => (i < 3 ? "a" : "b"),
  });
  assert.equal(verticalNeighbor(layout, 1, 1), 4); // header between the rows is skipped
  assert.equal(verticalNeighbor(layout, 5, 1), 6); // only one photo in the last row
  assert.equal(verticalNeighbor(layout, 0, -1), 0); // top edge
});

test("month keys accept EXIF and ISO dates", () => {
  assert.equal(monthKeyOf("2024:06:15 10:00:00"), "2024-06");
  assert.equal(monthKeyOf("2024-06-15"), "2024-06");
  assert.equal(monthKeyOf(""), "undated");
  assert.equal(monthLabel("2024-06"), "June 2024");
});
