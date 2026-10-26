// Command palette search (pure, unit-tested)

export interface PaletteAction {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  shortcut?: string;
  // Hidden when false (e.g. "Stop face scan" while no scan runs)
  enabled?: boolean;
  run: () => void;
}

const MAX_RESULTS = 60;

// Every word typed must appear in the label, group or keywords; matches at the start of the label rank first
export function rankActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const enabled = actions.filter((a) => a.enabled !== false);
  if (words.length === 0) return enabled.slice(0, MAX_RESULTS);
  const scored: { action: PaletteAction; score: number }[] = [];
  for (const action of enabled) {
    const label = action.label.toLowerCase();
    const haystack = `${label} ${action.group.toLowerCase()} ${(action.keywords || "").toLowerCase()}`;
    let score = 0;
    let ok = true;
    for (const w of words) {
      const inLabel = label.indexOf(w);
      if (inLabel === 0) score += 0;
      else if (inLabel > 0) score += label[inLabel - 1] === " " ? 1 : 3;
      else if (haystack.includes(w)) score += 6;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push({ action, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.action.label.length - b.action.label.length)
    .slice(0, MAX_RESULTS)
    .map((s) => s.action);
}

