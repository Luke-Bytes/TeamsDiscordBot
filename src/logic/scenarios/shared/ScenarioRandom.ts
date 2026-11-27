/** Random sources are injectable for deterministic offline tests. */
export type ScenarioRandom = () => number;

export function sampleDistinct<T>(
  items: readonly T[],
  count: number,
  random: ScenarioRandom = Math.random
): T[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > items.length)
    throw new Error("Invalid sample size.");
  const pool = [...items];
  for (let i = 0; i < count; i++) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1)
      throw new Error("Invalid random source.");
    const j = i + Math.floor(value * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}
