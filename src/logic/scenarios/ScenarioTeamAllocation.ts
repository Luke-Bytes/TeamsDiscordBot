import type { GameInstance } from "../../database/GameInstance";
import type { ScenarioTeamProposal } from "./ScenarioTypes";

export interface ScenarioPair { a: string; b: string }
export interface AllocationResult {
  proposal: ScenarioTeamProposal;
  kept: ScenarioPair[];
  split: ScenarioPair[];
}

/** Deterministic bounded beam search, with pairs as indivisible units whenever feasible. */
export function allocateScenarioTeams(
  game: GameInstance,
  archetypes: Record<string, string> = {},
  pairs: ScenarioPair[] = [],
): AllocationResult {
  const roster = [...game.getPlayers()].sort((a, b) => a.discordSnowflake.localeCompare(b.discordSnowflake));
  if (roster.length < 2) throw new Error("At least two registered players are required.");
  const ids = roster.map((p) => p.discordSnowflake);
  const idSet = new Set(ids);
  const redCaptain = game.getCaptainOfTeam("RED")?.discordSnowflake;
  const blueCaptain = game.getCaptainOfTeam("BLUE")?.discordSnowflake;
  if (redCaptain && blueCaptain && redCaptain === blueCaptain) throw new Error("Captains must differ.");
  const confirmed = pairs.filter(({ a, b }) => a !== b && idSet.has(a) && idSet.has(b));
  const seen = new Set<string>();
  const valid = confirmed.filter(({ a, b }) => {
    if (seen.has(a) || seen.has(b)) return false;
    seen.add(a); seen.add(b); return true;
  });
  const teamCapacity = Math.floor(roster.length / 2);
  const elo = new Map(roster.map((p) => [p.discordSnowflake, Number.isFinite(p.elo) ? p.elo : 1000]));
  const total = roster.reduce((sum, p) => sum + (elo.get(p.discordSnowflake) ?? 1000), 0);
  const desired = total * teamCapacity / roster.length;
  let preserved = valid.filter(({ a, b }) =>
    !(a === redCaptain && b === blueCaptain || a === blueCaptain && b === redCaptain));
  const makeGroups = (): string[][] => {
    const paired = new Set(preserved.flatMap((p) => [p.a, p.b]));
    return [...preserved.map((p) => [p.a, p.b]), ...ids.filter((id) => !paired.has(id)).map((id) => [id])]
      .sort((a, b) => (b.reduce((v, id) => v + (elo.get(id) ?? 1000), 0) -
        a.reduce((v, id) => v + (elo.get(id) ?? 1000), 0)) || a.join().localeCompare(b.join()));
  };
  type Candidate = { red: string[]; blue: string[]; redSum: number; variety: Record<string, number> };
  const score = (c: Candidate, final = false): number => {
    const diff = final
      ? Math.abs(c.redSum / c.red.length - (total - c.redSum) / c.blue.length)
      : Math.abs(c.redSum - desired * c.red.length / teamCapacity) / Math.max(1, c.red.length);
    const diversity = Object.values(c.variety).reduce((s, v) => s + Math.abs(v), 0);
    return diff + diversity * 8;
  };
  let result: Candidate | undefined;
  for (let attempt = 0; attempt <= valid.length; attempt++) {
    let states = new Map<number, Candidate[]>([[0, [{ red: [], blue: [], redSum: 0, variety: {} }]]]);
    for (const group of makeGroups()) {
      const next = new Map<number, Candidate[]>();
      const forcedRed = group.includes(redCaptain ?? "");
      const forcedBlue = group.includes(blueCaptain ?? "");
      for (const [_, variants] of states) for (const candidate of variants) {
        for (const side of ["RED", "BLUE"] as const) {
          if (side === "RED" && forcedBlue || side === "BLUE" && forcedRed) continue;
          const red = side === "RED" ? [...candidate.red, ...group] : candidate.red;
          const blue = side === "BLUE" ? [...candidate.blue, ...group] : candidate.blue;
          if (red.length > teamCapacity || blue.length > roster.length - teamCapacity) continue;
          const variety = { ...candidate.variety };
          for (const id of group) {
            const kind = archetypes[id] ?? "Unclassified";
            variety[kind] = (variety[kind] ?? 0) + (side === "RED" ? 1 : -1);
          }
          const entry = { red, blue, redSum: candidate.redSum +
            (side === "RED" ? group.reduce((sum, id) => sum + (elo.get(id) ?? 1000), 0) : 0), variety };
          const bucket = next.get(red.length) ?? [];
          bucket.push(entry);
          bucket.sort((a, b) => score(a) - score(b) || a.red.join().localeCompare(b.red.join()));
          if (bucket.length > 32) bucket.length = 32;
          next.set(red.length, bucket);
        }
      }
      states = next;
    }
    result = (states.get(teamCapacity) ?? []).sort((a, b) =>
      score(a, true) - score(b, true) || a.red.join().localeCompare(b.red.join()))[0];
    if (result) break;
    if (!preserved.length) break;
    // Break the smallest-numbered feasible pair only if a valid roster split is impossible.
    preserved = preserved.slice(1);
  }
  if (!result) throw new Error("No legal balanced team assignment fits captain constraints.");
  const red = result.red.sort(), blue = result.blue.sort();
  const redSet = new Set(red);
  return {
    proposal: { red, blue, undecided: [], method: "BALANCE" },
    kept: valid.filter(({ a, b }) => redSet.has(a) === redSet.has(b)),
    split: valid.filter(({ a, b }) => redSet.has(a) !== redSet.has(b)),
  };
}
