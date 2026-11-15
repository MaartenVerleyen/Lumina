// Checking faces one by one on the phone: what a drag of the card says when the finger lets go. Right is yes,
// left is no, up is someone else. Far enough (a third of the width, a quarter of the height) or a quick flick
// counts; anything less springs back. Down means nothing.

export type SwipeAnswer = "yes" | "no" | "else";

// How far the card was dragged (px) and how fast it was moving when let go (px per ms), in a card area of
// width × height
export function swipeAnswer(dx: number, dy: number, vx: number, vy: number, width: number, height: number): SwipeAnswer | null {
  // A flick must also have moved a little, so a tap that jitters isn't an answer
  const FLICK = 0.6;
  const MOVED = 40;
  const upwards = -dy > Math.abs(dx);
  if (upwards) {
    if (-dy > height / 4 || (vy < -FLICK && -dy > MOVED)) return "else";
    return null;
  }
  if (Math.abs(dx) <= Math.abs(dy)) return null;
  if (dx > width / 3 || (vx > FLICK && dx > MOVED)) return "yes";
  if (-dx > width / 3 || (vx < -FLICK && -dx > MOVED)) return "no";
  return null;
}

// How the card leans while dragged: up to 12° either way, by how far across it is
export function swipeTilt(dx: number, width: number): number {
  if (width <= 0) return 0;
  return Math.max(-12, Math.min(12, (dx / width) * 24));
}

// Which answer the card shows while dragged (its colour and word), before it counts
export function swipeHint(dx: number, dy: number): SwipeAnswer | null {
  const SHOW = 24;
  if (-dy > Math.abs(dx) && -dy > SHOW) return "else";
  if (dx > SHOW && dx > Math.abs(dy)) return "yes";
  if (-dx > SHOW && -dx > Math.abs(dy)) return "no";
  return null;
}
