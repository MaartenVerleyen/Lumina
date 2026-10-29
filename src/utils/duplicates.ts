// What the kept copy of a duplicate set gets from the extras before they go: the highest stars, a pick, the
// first colour label and caption, and every tag and person. Mirrors stage_duplicate_extras in duplicates.rs
// (tests/duplicates.test.ts).
export interface MergeablePhoto {
  rating: number;
  flag: "pick" | "reject" | null;
  color_label: "red" | "yellow" | "green" | "blue" | null;
  ai_caption: string;
  tags: string[];
  people: string[];
}

export function mergeIntoKeeper<T extends MergeablePhoto>(keep: T, extras: MergeablePhoto[]): T {
  const union = (lists: string[][]) => Array.from(new Set(lists.flat())).sort();
  return {
    ...keep,
    rating: Math.max(keep.rating, ...extras.map((e) => e.rating)),
    flag: keep.flag ?? (extras.some((e) => e.flag === "pick") ? "pick" : null),
    color_label: keep.color_label ?? extras.find((e) => e.color_label)?.color_label ?? null,
    ai_caption: keep.ai_caption || extras.find((e) => e.ai_caption)?.ai_caption || "",
    tags: union([keep.tags, ...extras.map((e) => e.tags)]),
    people: union([keep.people, ...extras.map((e) => e.people)]),
  };
}
