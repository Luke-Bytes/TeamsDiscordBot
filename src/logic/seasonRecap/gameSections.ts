import {
  bannedClasses,
  formatGameHighlight,
  groupBy,
  isUsefulName,
  pct,
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
  }));
  const uniqueMapCount = mapRows.length;
  const most = [...mapRows]
    .sort((a, b) => b.games - a.games)
    .slice(0, thresholds.topLimit)
    .map((r) => `${pretty(r.map)}: ${r.games} plays`);
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
      `${uniqueMapCount} unique maps were played this season.`,
      ...prefixRows("Most played", most),
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
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([type, rows]) => `${pretty(String(type))}: ${rows.length} games`);
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
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([modifier, rows]) => `${modifier}: ${rows.length} games`);

  return {
    title: "🎲 Game Type & Modifier Notes",
    lines: [
      ...prefixRows("Types", typeRows),
      ...prefixRows("Most common modifiers", modifierRows),
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
  const underdogWins = new Map<string, number>();
  for (const { game } of upsets) {
    for (const gp of game.gameParticipations) {
      if (gp.team === game.winner) {
        underdogWins.set(gp.playerId, (underdogWins.get(gp.playerId) ?? 0) + 1);
      }
    }
  }
  const underdogPlayers = [...underdogWins.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, thresholds.topLimit)
    .map(
      ([playerId, wins]) =>
        `${playerName(playerId, playerById)}: ${wins} underdog wins`
    );
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
      ...prefixRows("Biggest Upset", biggest),
      ...prefixRows("Most Underdog Wins", underdogPlayers),
      closers.length
        ? `Clutch closers are players with the most wins in games where the teams were within ${thresholds.closeGameEloGap} average Elo.`
        : "",
      ...prefixRows("Clutch closers", closers),
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
  ).map(([host]) => host);
  const organisers = topCounts(
    games.map((g) => g.organiser).filter(isUsefulName),
    thresholds.topLimit
  ).map(([organiser]) => organiser);

  return {
    title: "🙌 Organisers & Hosts",
    lines: [
      "A big thank you to everyone who organised and hosted games this season!",
      organisers.length
        ? `A special shoutout to ${organisers.join(", ")} for making one of the biggest organiser impacts this season.`
        : "",
      hosts.length
        ? `And especially to ${hosts.join(", ")} for being some of the most active hosts.`
        : "",
    ].filter(Boolean),
  };
}
