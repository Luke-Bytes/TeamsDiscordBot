import { AnniMap } from "@prisma/client";
import type { MaskedClue } from "./MaskedDraftHints";

export interface MaskedHistoryRow {
  playerId: string;
  gameId: string;
  team: string;
  captain: boolean;
  mvp: boolean;
  game: { winner: string; endTime: Date; settings: { map: string } | null } | null;
}
type Counts = { games: number; wins: number };
type CaptainIds = { RED: string; BLUE: string };
const MIN_SAMPLE = 5;
const maps = new Set<string>(Object.values(AnniMap));

function countResult<K>(counts: Map<K, Counts>, key: K, won: boolean): void {
  const entry = counts.get(key) ?? { games: 0, wins: 0 };
  entry.games++;
  if (won) entry.wins++;
  counts.set(key, entry);
}

function winBand(c: Counts): string {
  if (c.wins * 5 >= c.games * 4) return "80%+";
  if (c.wins * 5 >= c.games * 3) return "60-79%";
  if (c.wins * 5 >= c.games * 2) return "40-59%";
  return "Under 40%";
}

/** Return all joint highest rates with a meaningful sample and positive record. */
function bestRates<K>(counts: Map<K, Counts>): K[] {
  const eligible = [...counts].filter(([, c]) =>
    c.games >= MIN_SAMPLE && c.wins * 5 >= c.games * 3);
  const best: K[] = [];
  let top: Counts | undefined;
  for (const [key, c] of eligible) {
    const cmp = top ? c.wins * top.games - top.wins * c.games : 1;
    if (cmp > 0) { best.length = 0; top = c; }
    if (cmp >= 0) best.push(key);
  }
  return best;
}

function mapLabel(map: string): string {
  const lower = map.replace(/1V1$/, "").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function historyClues(
  rows: readonly MaskedHistoryRow[],
  partners: Map<string, Counts>,
  captains: CaptainIds,
  currentMap?: string,
): MaskedClue[] {
  const clues: MaskedClue[] = [];
  const add = (label: string, priority: number, family: MaskedClue["family"]) =>
    clues.push({ label, priority, family });
  const best = bestRates(partners);
  // Team colours only identify the two CURRENT, publicly known captains.
  for (const side of ["RED", "BLUE"] as const) {
    const captain = captains[side];
    const c = partners.get(captain);
    if (!c || c.games < MIN_SAMPLE) continue;
    if (best.includes(captain))
      add(`Top lobby win-rate partner: ${side} captain (60%+ wins)`, 0, "partner");
    add(`${side} captain: ${winBand(c)} wins together`, 1, "partner");
    if (c.wins * 5 >= c.games * 3)
      add(`${side} captain: 60%+ wins together`, 2, "partner");
    if (c.games >= 10)
      add(`Played 10+ games with ${side} captain`, 3, "partner");
  }
  const red = partners.get(captains.RED);
  const blue = partners.get(captains.BLUE);
  if (red && blue && red.games >= MIN_SAMPLE && blue.games >= MIN_SAMPLE) {
    const difference = red.wins * blue.games - blue.wins * red.games;
    if (Math.abs(difference) * 5 >= red.games * blue.games) {
      const side = difference > 0 ? "RED" : "BLUE";
      const other = side === "RED" ? "BLUE" : "RED";
      add(`20+ pts higher win rate with ${side} captain than ${other}`, 0, "partner");
    }
  }
  const mostPlayed = Math.max(0, ...[...partners.values()].map((c) => c.games));
  for (const side of ["RED", "BLUE"] as const) {
    if (mostPlayed >= 8 && partners.get(captains[side])?.games === mostPlayed)
      add(`Most-played lobby teammate: ${side} captain`, 3, "partner");
  }

  const byMap = new Map<string, Counts>();
  let captainGames = 0;
  let captainWins = 0;
  let mvpLosses = 0;
  let mvpAwards = 0;
  for (const row of rows) {
    const game = row.game!;
    const won = game.winner === row.team;
    const map = game.settings?.map;
    if (map && maps.has(map)) countResult(byMap, map, won);
    if (row.mvp === true) {
      mvpAwards++;
      if (!won) mvpLosses++;
    }
    if (row.captain === true) {
      captainGames++;
      if (won) captainWins++;
    }
  }
  const today = currentMap && maps.has(currentMap) ? byMap.get(currentMap) : undefined;
  if (today && currentMap) {
    if (today.games >= MIN_SAMPLE) {
      add(`${mapLabel(currentMap)}: ${winBand(today)} wins`, 0, "map");
      if (today.wins * 5 >= today.games * 3)
        add(`${mapLabel(currentMap)}: 60%+ wins`, 2, "map");
      add(`Played ${mapLabel(currentMap)} 5+ times`, 3, "map");
    }
    if (today.games >= 10) add(`Played ${mapLabel(currentMap)} 10+ times`, 2, "map");
  }
  const bestMaps = bestRates(byMap);
  if (bestMaps.length === 1 && bestMaps[0] !== currentMap)
    add(`Top win-rate map: ${mapLabel(bestMaps[0])} (60%+ wins)`, 3, "map");
  const mostMapGames = Math.max(0, ...[...byMap.values()].map((c) => c.games));
  if (mostMapGames >= 10) {
    for (const [map, c] of byMap)
      if (c.games === mostMapGames && map !== currentMap)
        add(`Most-played map: ${mapLabel(map)}`, 4, "map");
  }

  if (captainGames >= 5) {
    add(`${winBand({ games: captainGames, wins: captainWins })} wins as captain`, 4, "captain");
    add("Captained 5+ games", 5, "captain");
  }
  if (mvpAwards >= 5) add("Earned MVP in 5+ matches", 4, "mvp");
  if (mvpLosses >= 2) add("Earned MVP in 2+ losses", 4, "mvp");

  // Recent results are useful for hedging, but lower priority than teammate
  // or map context. Tied times make a last-ten window ambiguous at its edge.
  const chronological = [...rows].sort((a, b) => b.game!.endTime.getTime() - a.game!.endTime.getTime());
  if (chronological.length >= 10 &&
      (chronological.length === 10 ||
        chronological[9].game!.endTime.getTime() > chronological[10].game!.endTime.getTime())) {
    const recent = chronological.slice(0, 10);
    const wins = recent.filter((row) => row.game!.winner === row.team).length;
    const mvps = recent.filter((row) => row.mvp === true).length;
    if (wins >= 6) add(`Won ${wins >= 8 ? "8-10" : "6-7"} of last 10 games`, 6, "form");
    else if (wins <= 3) add("Won 0-3 of last 10 games", 6, "form");
    else add("Won 4-5 of last 10 games", 6, "form");
    if (mvps >= 2) add("MVP in 2+ of last 10 games", 4, "mvp");
  }
  return clues;
}

/** Build factual clues from one frozen roster's recorded matches, never from profiles. */
export function deriveMaskedClues(
  rows: readonly MaskedHistoryRow[],
  roster: readonly string[],
  captains: CaptainIds,
  currentMap?: string,
): Map<string, MaskedClue[]> {
  const rosterSet = new Set(roster);
  const history = new Map<string, Map<string, MaskedHistoryRow>>();
  const teams = new Map<string, MaskedHistoryRow[]>();
  for (const row of rows) {
    const game = row.game;
    if (!rosterSet.has(row.playerId) || !game ||
        !["RED", "BLUE"].includes(row.team) || !["RED", "BLUE"].includes(game.winner) ||
        !(game.endTime instanceof Date) || !Number.isFinite(game.endTime.getTime())) continue;
    const own = history.get(row.playerId) ?? new Map<string, MaskedHistoryRow>();
    if (own.has(row.gameId)) continue;
    own.set(row.gameId, row);
    history.set(row.playerId, own);
    const key = `${row.gameId}:${row.team}`;
    const side = teams.get(key) ?? [];
    side.push(row);
    teams.set(key, side);
  }
  const partners = new Map<string, Map<string, Counts>>();
  for (const side of teams.values()) {
    for (const player of side) {
      const counts = partners.get(player.playerId) ?? new Map<string, Counts>();
      for (const teammate of side) {
        if (player.playerId !== teammate.playerId)
          countResult(counts, teammate.playerId, player.game!.winner === player.team);
      }
      partners.set(player.playerId, counts);
    }
  }
  return new Map(roster.filter((id) => id !== captains.RED && id !== captains.BLUE)
    .map((id) => [id, historyClues(
      [...(history.get(id)?.values() ?? [])], partners.get(id) ?? new Map(), captains, currentMap,
    )]));
}
