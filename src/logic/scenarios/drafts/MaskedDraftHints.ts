/** Only display descriptions are persisted; raw historical facts stay private. */
export const MYSTERY_HINT = "Mystery card";
const MIN_COHORT = 3;

export interface MaskedClue {
  label: string;
  /** Lower means more interesting or strategically useful. */
  priority: number;
  family?: "partner" | "map" | "captain" | "mvp" | "form";
}

/**
 * Give each card one or two genuine historical clues. Evaluate the entire
 * combined label, not each clue in isolation. Reserve a cohort for each
 * distinct eligible label, then use any remaining compatible cards to fill
 * those cohorts. The shuffled card order supplies variety without changing
 * a clue after publication. No unique or two-person mystery group either.
 */
export function buildMaskedHints(
  cards: Readonly<Record<string, string>>,
  clues: ReadonlyMap<string, readonly MaskedClue[]>,
): Record<string, string> {
  const entries = Object.entries(cards);
  const result = Object.fromEntries(entries.map(([card]) => [card, MYSTERY_HINT]));
  if (entries.length < MIN_COHORT) return result;

  const groups = new Map<string, { priority: number; cards: string[] }>();
  for (const [card, id] of entries) {
    const facts = clues.get(id) ?? [];
    const options = [...facts];
    // Pair independent dimensions only. Keep the whole description inside
    // Discord's 100-character select label, including the card ID.
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const a = facts[i];
        const b = facts[j];
        if (!a.family || !b.family || a.family === b.family) continue;
        const [first, second] = [a, b].sort((x, y) => x.priority - y.priority || x.label.localeCompare(y.label));
        const label = `${first.label} · ${second.label}`;
        if (label.length > 90) continue;
        options.push({ label, priority: first.priority - 0.25 + Math.min(second.priority, 6) * 0.02 });
      }
    }
    for (const clue of options) {
      const group = groups.get(clue.label) ?? { priority: clue.priority, cards: [] };
      if (!group.cards.includes(card)) group.cards.push(card);
      groups.set(clue.label, group);
    }
  }
  const ordered = [...groups.entries()].filter(([, group]) => group.cards.length >= MIN_COHORT)
    .sort((a, b) => a[1].priority - b[1].priority || a[1].cards.length - b[1].cards.length ||
      a[0].localeCompare(b[0]));
  const used = new Set<string>();

  for (const [label, group] of ordered) {
    const eligible = group.cards.filter((card) => result[card] === MYSTERY_HINT);
    if (eligible.length < MIN_COHORT) continue;
    for (const card of eligible.slice(0, MIN_COHORT)) result[card] = label;
    used.add(label);
  }
  for (const [label, group] of ordered) {
    if (!used.has(label)) continue;
    for (const card of group.cards) if (result[card] === MYSTERY_HINT) result[card] = label;
  }
  const hidden = Object.values(result).filter((label) => label === MYSTERY_HINT).length;
  if (hidden > 0 && hidden < MIN_COHORT) {
    // Suppress an entire cohort to avoid a distinctive "missing data" card.
    const leastUseful = [...ordered].reverse().find(([label]) => used.has(label))?.[0];
    for (const [card, label] of Object.entries(result)) if (label === leastUseful) result[card] = MYSTERY_HINT;
  }
  return result;
}
