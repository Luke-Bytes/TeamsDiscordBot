import { Team } from "@prisma/client";
import { duoName, pairKey, pct, playerName, prefixRows } from "./formatting";
import {
  InsightSection,
  SeasonRecapGame,
  SeasonRecapPlayer,
  SeasonRecapThresholds,
} from "./types";

export function buildDuoChemistry(
  games: SeasonRecapGame[],
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds
): InsightSection {
  const duos = new Map<
    string,
    { a: string; b: string; games: number; wins: number }
  >();
  for (const game of games) {
    for (const team of [Team.RED, Team.BLUE]) {
      const players = game.gameParticipations.filter((gp) => gp.team === team);
      for (let i = 0; i < players.length; i += 1) {
        for (let j = i + 1; j < players.length; j += 1) {
          const a = players[i].playerId;
          const b = players[j].playerId;
          const key = pairKey(a, b);
          const row = duos.get(key) ?? { a, b, games: 0, wins: 0 };
          row.games += 1;
          if (game.winner === team) row.wins += 1;
          duos.set(key, row);
        }
      }
    }
  }

  const qualified = [...duos.values()].filter(
    (d) => d.games >= thresholds.minDuoGames
  );
  const best = [...qualified]
    .sort((a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games)
    .slice(0, thresholds.topLimit)
    .map(
      (d) =>
        `${duoName(d.a, d.b, playerById)}: ${pct(d.wins / d.games)} win rate (${d.wins}W-${d.games - d.wins}L)`
    );
  const worst = [...qualified]
    .sort((a, b) => a.wins / a.games - b.wins / b.games || b.games - a.games)
    .slice(0, thresholds.topLimit)
    .map(
      (d) =>
        `${duoName(d.a, d.b, playerById)}: ${pct((d.games - d.wins) / d.games)} loss rate (${d.wins}W-${d.games - d.wins}L)`
    );
  const frequent = [...duos.values()]
    .sort((a, b) => b.games - a.games)
    .slice(0, thresholds.topLimit)
    .map((d) => `${duoName(d.a, d.b, playerById)}: ${d.games} games`);

  return {
    title: "🤝 Teammate Records",
    lines: [
      ...prefixRows("Most Likely To Win Together", best),
      ...prefixRows("Most Likely To Lose Together", worst),
      ...prefixRows("Most Games Together", frequent),
    ],
  };
}

export function buildRivalries(
  games: SeasonRecapGame[],
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds
): InsightSection {
  const pairs = new Map<
    string,
    { a: string; b: string; games: number; winsA: number; winsB: number }
  >();
  for (const game of games) {
    const red = game.gameParticipations.filter((gp) => gp.team === Team.RED);
    const blue = game.gameParticipations.filter((gp) => gp.team === Team.BLUE);
    for (const redPlayer of red) {
      for (const bluePlayer of blue) {
        const key = pairKey(redPlayer.playerId, bluePlayer.playerId);
        const row = pairs.get(key) ?? {
          a: key.split("::")[0],
          b: key.split("::")[1],
          games: 0,
          winsA: 0,
          winsB: 0,
        };
        row.games += 1;
        const winner =
          game.winner === redPlayer.team
            ? redPlayer.playerId
            : bluePlayer.playerId;
        if (winner === row.a) row.winsA += 1;
        else row.winsB += 1;
        pairs.set(key, row);
      }
    }
  }

  const frequent = [...pairs.values()]
    .sort((a, b) => b.games - a.games)
    .slice(0, thresholds.topLimit)
    .map((p) => `${duoName(p.a, p.b, playerById)}: ${p.games} meetings`);
  const oneSided = [...pairs.values()]
    .filter((p) => p.games >= thresholds.minDuoGames)
    .map((p) => ({ ...p, edge: Math.abs(p.winsA - p.winsB) }))
    .sort((a, b) => b.edge - a.edge || b.games - a.games)
    .slice(0, thresholds.topLimit)
    .map((p) => {
      const leader = p.winsA >= p.winsB ? p.a : p.b;
      return `${duoName(p.a, p.b, playerById)}: ${playerName(leader, playerById)} leads ${Math.max(p.winsA, p.winsB)}-${Math.min(p.winsA, p.winsB)}`;
    });
  const bestHeadToHead = [...pairs.values()]
    .filter((p) => p.games >= thresholds.minDuoGames)
    .flatMap((p) => [
      {
        playerId: p.a,
        opponentId: p.b,
        wins: p.winsA,
        losses: p.winsB,
        games: p.games,
      },
      {
        playerId: p.b,
        opponentId: p.a,
        wins: p.winsB,
        losses: p.winsA,
        games: p.games,
      },
    ])
    .filter((p) => p.wins > p.losses)
    .sort((a, b) => b.wins / b.games - a.wins / a.games || b.wins - a.wins)
    .slice(0, thresholds.topLimit)
    .map(
      (p) =>
        `${playerName(p.playerId, playerById)} vs ${playerName(p.opponentId, playerById)}: ${p.wins}W-${p.losses}L`
    );

  return {
    title: "⚔️ Head-To-Head Records",
    lines: [
      ...prefixRows("Most Common Matchups", frequent),
      ...prefixRows("Best Head-To-Head Records", bestHeadToHead),
      ...prefixRows("Most One-Sided Matchups", oneSided),
    ],
  };
}
