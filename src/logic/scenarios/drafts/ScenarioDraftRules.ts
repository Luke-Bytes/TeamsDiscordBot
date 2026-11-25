import { randomInt } from "node:crypto";

export type DraftTeam = "RED" | "BLUE";
export function snakeTurn(index: number, first: DraftTeam): DraftTeam {
  if (index < 0 || !Number.isInteger(index)) throw new Error("Invalid pick index.");
  const firstTurn = index === 0 || Math.floor((index + 1) / 2) % 2 === 0;
  return firstTurn ? first : first === "RED" ? "BLUE" : "RED";
}
export function shuffle<T>(source: readonly T[], rng: (max: number) => number = randomInt): T[] {
  const items = [...source];
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new Error("Invalid random index.");
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
export function rouletteOffer(
  undrafted: readonly string[], rng: (max: number) => number = randomInt,
): string[] {
  if (new Set(undrafted).size !== undrafted.length)
    throw new Error("Draft contains duplicate candidates.");
  return shuffle(undrafted, rng).slice(0, Math.min(3, undrafted.length));
}
export function maskedCards(ids: readonly string[], rng: (max: number) => number = randomInt) {
  const sorted = [...ids].sort();
  const shuffled = shuffle(sorted, rng);
  return Object.fromEntries(shuffled.map((id, index) =>
    [`M${String(index + 1).padStart(2, "0")}`, id])) as Record<string, string>;
}
