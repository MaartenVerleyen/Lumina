// Photo grid layout, computed up front so the grid can virtualize rows of different heights.
// Two styles share one row model:
//  - "justified": every row is filled edge to edge and each photo keeps its own aspect ratio
//  - "square": a fixed number of equal cards per row (the classic grid)
// When a group key is given (month, when sorted by date), each new group starts with a header row.

export interface LayoutPhoto {
  width: number;
  height: number;
  rotation: number;
  captured_at?: string;
}

export interface LayoutItem {
  index: number; // index into the photo list
  x: number;
  width: number;
}

export type LayoutRow =
  | { kind: "header"; key: string; label: string; top: number; height: number }
  | { kind: "photos"; key: string; top: number; height: number; items: LayoutItem[] };

export interface GridLayout {
  rows: LayoutRow[];
  // Row index (into `rows`) of every photo
  rowOfPhoto: number[];
}

export interface LayoutOptions {
  width: number;
  gap: number;
  headerHeight: number;
  // Returns the group a photo belongs to (e.g. "2024-06"), or null for no headers
  groupKey?: (index: number) => string | null;
  groupLabel?: (key: string) => string;
}

// Displayed aspect ratio (width / height), with quarter-turn rotations swapped. Unknown sizes are 3:2,
// and extreme panoramas or slivers are clamped so one photo can't take a whole row or vanish.
export function aspectOf(p: LayoutPhoto): number {
  if (!(p.width > 0 && p.height > 0)) return 1.5;
  const quarter = p.rotation === 90 || p.rotation === 270;
  const ratio = quarter ? p.height / p.width : p.width / p.height;
  return Math.min(3, Math.max(0.4, ratio));
}

type RowSink = (items: LayoutItem[], height: number) => void;

function buildRows(
  count: number,
  options: LayoutOptions,
  fillGroup: (indices: number[], emit: RowSink) => void
): GridLayout {
  const rows: LayoutRow[] = [];
  const rowOfPhoto = new Array<number>(count).fill(0);
  let top = 0;

  const emit: RowSink = (items, height) => {
    const rowIndex = rows.length;
    for (const it of items) rowOfPhoto[it.index] = rowIndex;
    rows.push({ kind: "photos", key: `r${items[0].index}`, top, height, items });
    top += height + options.gap;
  };

  let groupStart = 0;
  while (groupStart < count) {
    const key = options.groupKey ? options.groupKey(groupStart) : null;
    let groupEnd = groupStart + 1;
    if (options.groupKey) {
      while (groupEnd < count && options.groupKey(groupEnd) === key) groupEnd++;
    } else {
      groupEnd = count;
    }
    if (key !== null && options.groupKey) {
      const label = options.groupLabel ? options.groupLabel(key) : key;
      rows.push({ kind: "header", key: `h${groupStart}`, label, top, height: options.headerHeight });
      top += options.headerHeight;
    }
    const indices: number[] = [];
    for (let i = groupStart; i < groupEnd; i++) indices.push(i);
    fillGroup(indices, emit);
    groupStart = groupEnd;
  }
  return { rows, rowOfPhoto };
}

// Justified rows: photos are added at the target height until the row is full, then the row is scaled
// to fit the width exactly. A group's last, unfilled row stays at the target height (left aligned).
export function buildJustifiedLayout(
  photos: LayoutPhoto[],
  options: LayoutOptions & { targetRowHeight: number }
): GridLayout {
  const { width, gap, targetRowHeight } = options;
  const maxHeight = targetRowHeight * 1.6;

  return buildRows(photos.length, options, (indices, emit) => {
    let pending: number[] = [];
    let aspectSum = 0;

    const place = (row: number[], height: number, stretch: boolean) => {
      const items: LayoutItem[] = [];
      let x = 0;
      row.forEach((index, i) => {
        const isLast = i === row.length - 1;
        let w = Math.round(aspectOf(photos[index]) * height);
        // The last photo of a full row absorbs rounding, so rows end exactly at the edge
        if (stretch && isLast) w = Math.max(1, width - x);
        items.push({ index, x, width: w });
        x += w + gap;
      });
      emit(items, Math.round(height));
    };

    for (const index of indices) {
      pending.push(index);
      aspectSum += aspectOf(photos[index]);
      const gaps = gap * (pending.length - 1);
      const rowWidthAtTarget = aspectSum * targetRowHeight + gaps;
      if (rowWidthAtTarget >= width) {
        const height = Math.min(maxHeight, (width - gaps) / aspectSum);
        place(pending, height, true);
        pending = [];
        aspectSum = 0;
      }
    }
    if (pending.length > 0) place(pending, targetRowHeight, false);
  });
}

// Classic grid: `columns` equal cards per row
export function buildSquareLayout(
  count: number,
  options: LayoutOptions & { columns: number; cardHeight: number }
): GridLayout {
  const { width, gap, columns, cardHeight } = options;
  const cardWidth = Math.floor((width - (columns - 1) * gap) / columns);
  return buildRows(count, options, (indices, emit) => {
    for (let start = 0; start < indices.length; start += columns) {
      const items = indices
        .slice(start, start + columns)
        .map((index, i) => ({ index, x: i * (cardWidth + gap), width: cardWidth }));
      emit(items, cardHeight);
    }
  });
}

// Arrow up/down: the photo in the previous/next photo row whose centre is closest to this one's centre.
// Returns the same index at the top or bottom edge.
export function verticalNeighbor(layout: GridLayout, index: number, direction: 1 | -1): number {
  const rowIndex = layout.rowOfPhoto[index];
  const row = layout.rows[rowIndex];
  if (!row || row.kind !== "photos") return index;
  const self = row.items.find((it) => it.index === index);
  if (!self) return index;
  const centre = self.x + self.width / 2;

  for (let r = rowIndex + direction; r >= 0 && r < layout.rows.length; r += direction) {
    const target = layout.rows[r];
    if (target.kind !== "photos") continue;
    let best = target.items[0];
    let bestDistance = Infinity;
    for (const it of target.items) {
      const distance = Math.abs(it.x + it.width / 2 - centre);
      if (distance < bestDistance) {
        best = it;
        bestDistance = distance;
      }
    }
    return best.index;
  }
  return index;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "2024:06:15 10:00:00" or "2024-06-15 ..." -> "2024-06"; no date -> "undated"
export function monthKeyOf(capturedAt: string | undefined): string {
  const m = /^(\d{4})[-:](\d{2})/.exec(capturedAt || "");
  return m ? `${m[1]}-${m[2]}` : "undated";
}

export function monthLabel(key: string): string {
  if (key === "undated") return "No date";
  const [year, month] = key.split("-");
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}
