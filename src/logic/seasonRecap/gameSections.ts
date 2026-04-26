import { Team } from "@prisma/client";
import {
  bannedClasses,
  duration,
  formatGameHighlight,
  formatGameSummary,
  formatMinutes,
  groupBy,
  isUsefulName,
  mean,
  median,
  pct,
  percentile,
  playerName,
  prefixRows,
  pretty,
  topCounts,
} from "./formatting";
import {
  InsightSection,
  PlayerGameOutcome,
  SeasonRecapGame,
  SeasonRecapModel,
  SeasonRecapPlayer,
  SeasonRecapThresholds,
} from "./types";

export function buildMapInsights(
  games: SeasonRecapGame[],
  outcomesByPlayer: Map<string, PlayerGameOutcome[]>,
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds,
  minGames: number
): InsightSection {
  const mapRows = [
    ...groupBy(games, (g) => g.settings?.map ?? "Unknown").entries(),
  ].map(([map, rows]) => ({
    map,
    games: rows.length,
    redWins: rows.filter((g) => g.winner === Team.RED).length,
    medianDuration: median(rows.map(duration)),
  }));
  const most = [...mapRows]
    .sort((a, b) => b.games - a.games)
    .slice(0, thresholds.topLimit)
    .map((r) => `${pretty(r.map)}: ${r.games} plays`);
  const skew = [...mapRows]
    .filter((r) => r.games >= 3)
    .map((r) => ({ ...r, skew: Math.abs(r.redWins / r.games - 0.5) }))
    .sort((a, b) => b.skew - a.skew || b.games - a.games)
    .slice(0, thresholds.topLimit)
    .map(
      (r) =>
        `${pretty(r.map)}: ${r.redWins >= r.games / 2 ? "RED" : "BLUE"} ${pct(Math.max(r.redWins, r.games - r.redWins) / r.games)}`
    );
  const slowFast = [...mapRows]
    .filter((r) => r.games >= 2)
    .sort((a, b) => b.medianDuration - a.medianDuration)
    .slice(0, 1)
    .map(
      (r) =>
        `Slowest: ${pretty(r.map)} (${formatMinutes(r.medianDuration)} median)`
    );
  const specialists = [...outcomesByPlayer.entries()]
    .flatMap(([playerId, outcomes]) => {
      if (outcomes.length < minGames) return [];
      return [...groupBy(outcomes, (o) => o.map).entries()].map(
        ([map, rows]) => ({
          playerId,
          map,
          games: rows.length,
          wins: rows.filter((o) => o.won).length,
        })
      );
    })
    .filter((r) => r.games >= thresholds.minMapPlayerGames)
    .sort((a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games)
    .slice(0, thresholds.topLimit)
    .map(
      (r) =>
        `${playerName(r.playerId, playerById)} on ${pretty(r.map)}: ${pct(r.wins / r.games)} (${r.wins}/${r.games})`
    );

  return {
    title: "🗺️ Map Insights",
    lines: [
      ...prefixRows("Most played", most),
      ...prefixRows("Color skew", skew),
      ...slowFast,
      ...prefixRows("Specialists", specialists),
    ],
  };
}

export function buildBanTrends(
  games: SeasonRecapGame[],
  thresholds: SeasonRecapThresholds
): InsightSection {
  const counts = new Map<string, number>();
  const firstHalf = new Map<string, number>();
  const secondHalf = new Map<string, number>();
  games.forEach((game, index) => {
    for (const cls of bannedClasses(game)) {
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
      const bucket = index < games.length / 2 ? firstHalf : secondHalf;
      bucket.set(cls, (bucket.get(cls) ?? 0) + 1);
    }
  });
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, thresholds.topLimit)
    .map(([cls, count]) => `${pretty(cls)}: ${count} bans`);
  const risers = [...counts.keys()]
    .map((cls) => ({
      cls,
      delta: (secondHalf.get(cls) ?? 0) - (firstHalf.get(cls) ?? 0),
    }))
    .filter((r) => r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, thresholds.topLimit)
    .map((r) => `${pretty(r.cls)}: +${r.delta} in second half`);

  return {
    title: "🚫 Class Ban Trends",
    lines: [
      ...prefixRows("Most banned", top),
      ...prefixRows("Late-season risers", risers),
    ],
  };
}

export function buildGameTypeAndModifierInsights(
  games: SeasonRecapGame[]
): InsightSection {
  const typeRows = [...groupBy(games, (g) => g.type ?? "UNKNOWN").entries()]
    .filter(([, rows]) => rows.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(
      ([type, rows]) =>
        `${pretty(String(type))}: ${rows.length} games, ${formatMinutes(mean(rows.map(duration)))} avg`
    );
  const modifiers = new Map<string, SeasonRecapGame[]>();
  for (const game of games) {
    for (const modifier of game.settings?.modifiers ?? []) {
      const label = `${modifier.category}: ${modifier.name}`;
      const rows = modifiers.get(label) ?? [];
      rows.push(game);
      modifiers.set(label, rows);
    }
  }
  const modifierRows = [...modifiers.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .sort((a, b) => mean(b[1].map(duration)) - mean(a[1].map(duration)))
    .slice(0, 3)
    .map(
      ([modifier, rows]) =>
        `${modifier}: ${formatMinutes(mean(rows.map(duration)))} avg over ${rows.length}`
    );

  return {
    title: "🎲 Game Type & Modifier Notes",
    lines: [
      ...prefixRows("Types", typeRows),
      ...prefixRows("Longest modifiers", modifierRows),
    ],
  };
}

export function buildUpsetsAndCloseGames(
  games: SeasonRecapGame[],
  model: SeasonRecapModel,
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds
): InsightSection {
  const upsets = games
    .map((game) => ({ game, ctx: model.gameContexts.get(game.id)! }))
    .filter(
      ({ game, ctx }) =>
        ctx.underdogTeam === game.winner &&
        ctx.eloGap >= thresholds.underdogEloGap
    )
    .sort((a, b) => b.ctx.eloGap - a.ctx.eloGap);
  const biggest = upsets[0]
    ? [formatGameHighlight(upsets[0].game, upsets[0].ctx.eloGap)]
    : [];
  const closeWins = new Map<string, number>();
  for (const game of games) {
    const ctx = model.gameContexts.get(game.id);
    if (!ctx || !ctx.closeGame || ctx.eloGap >= thresholds.closeGameEloGap) {
      continue;
    }
    for (const gp of game.gameParticipations) {
      if (gp.team === game.winner) {
        closeWins.set(gp.playerId, (closeWins.get(gp.playerId) ?? 0) + 1);
      }
    }
  }
  const closers = [...closeWins.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, thresholds.topLimit)
    .map(
      ([playerId, wins]) =>
        `${playerName(playerId, playerById)}: ${wins} close-game wins`
    );

  return {
    title: "🐉 Upsets & Close Games",
    lines: [
      ...prefixRows("Biggest upset", biggest),
      ...prefixRows("Clutch closers", closers),
    ],
  };
}

export function buildDurationStories(
  games: SeasonRecapGame[],
  outcomesByPlayer: Map<string, PlayerGameOutcome[]>,
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds
): InsightSection {
  const sorted = [...games].sort((a, b) => duration(a) - duration(b));
  const shortest = sorted[0] ? `Shortest: ${formatGameSummary(sorted[0])}` : "";
  const longest = sorted.at(-1)
    ? `Longest: ${formatGameSummary(sorted.at(-1)!)} `
    : "";
  const durations = games.map(duration);
  const fastCutoff = percentile(durations, 0.25);
  const longCutoff = percentile(durations, 0.75);
  const fast = [...outcomesByPlayer.entries()]
    .map(([playerId, outcomes]) => {
      const rows = outcomes.filter((o) => o.durationMinutes <= fastCutoff);
      return {
        playerId,
        games: rows.length,
        wins: rows.filter((o) => o.won).length,
      };
    })
    .filter((r) => r.games >= thresholds.minFastLongGames)
    .sort((a, b) => b.wins / b.games - a.wins / a.games)
    .slice(0, thresholds.topLimit)
    .map(
      (r) =>
        `${playerName(r.playerId, playerById)}: ${pct(r.wins / r.games)} fast games`
    );
  const long = [...outcomesByPlayer.entries()]
    .map(([playerId, outcomes]) => {
      const rows = outcomes.filter((o) => o.durationMinutes >= longCutoff);
      return {
        playerId,
        games: rows.length,
        wins: rows.filter((o) => o.won).length,
      };
    })
    .filter((r) => r.games >= thresholds.minFastLongGames)
    .sort((a, b) => b.wins / b.games - a.wins / a.games)
    .slice(0, thresholds.topLimit)
    .map(
      (r) =>
        `${playerName(r.playerId, playerById)}: ${pct(r.wins / r.games)} long games`
    );

  return {
    title: "⏱️ Duration Stories",
    lines: [
      shortest,
      longest.trim(),
      ...prefixRows("Fast specialists", fast),
      ...prefixRows("Marathon players", long),
    ].filter(Boolean),
  };
}

export function buildCommunityOps(
  games: SeasonRecapGame[],
  thresholds: SeasonRecapThresholds
): InsightSection {
  const hosts = topCounts(
    games.map((g) => g.host).filter(isUsefulName),
    thresholds.topLimit
  ).map(([host, count]) => `${host}: ${count} games`);
  const organisers = topCounts(
    games.map((g) => g.organiser).filter(isUsefulName),
    thresholds.topLimit
  ).map(([organiser, count]) => `${organiser}: ${count} games`);

  return {
    title: "🧑‍💼 Community Ops",
    lines: [
      ...prefixRows("Hosts", hosts),
      ...prefixRows("Organisers", organisers),
    ],
  };
}
