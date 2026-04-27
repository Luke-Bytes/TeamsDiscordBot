import { Team } from "@prisma/client";
import { escapeIgn } from "../../util/Utils";
import { buildSeasonRecapModel } from "./model";
import { loadSeasonRecapData } from "./SeasonRecap";
import {
  DEFAULT_SEASON_RECAP_THRESHOLDS,
  PlayerGameOutcome,
  SeasonRecapData,
  SeasonRecapGame,
  SeasonRecapPlayer,
  SeasonRecapPlayerStats,
} from "./types";
import { formatDate, groupBy, pct, pretty } from "./formatting";

export type PersonalWrappedField = {
  name: string;
  value: string;
  inline?: boolean;
};

export type PersonalSeasonWrappedResult = {
  seasonNumber: number;
  playerName: string;
  title: string;
  description: string;
  fields: PersonalWrappedField[];
  footer: string;
  summary: {
    games: number;
    wins: number;
    losses: number;
    winRate: number;
    finalElo: number;
    rank: number;
    totalPlayers: number;
    percentile: number;
    seasonType: string;
  };
};

type RelationshipRow = {
  playerId: string;
  games: number;
  wins: number;
};

export async function generatePersonalSeasonWrapped(options: {
  seasonNumber: number;
  playerId: string;
}): Promise<PersonalSeasonWrappedResult | null> {
  const data = await loadSeasonRecapData(options.seasonNumber);
  return generatePersonalSeasonWrappedFromData(data, options.playerId);
}

export function generatePersonalSeasonWrappedFromData(
  data: SeasonRecapData,
  playerId: string
): PersonalSeasonWrappedResult | null {
  const games = data.games
    .filter((game) => game.finished)
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const stats = data.playerStats.find((row) => row.playerId === playerId);
  if (!stats || totalGames(stats) === 0) return null;

  const playerById = collectPlayers(data, games);
  const thresholds = DEFAULT_SEASON_RECAP_THRESHOLDS;
  const model = buildSeasonRecapModel(games, data.histories, thresholds);
  const outcomes = model.outcomesByPlayer.get(playerId) ?? [];
  if (!outcomes.length) return null;

  const personalGames = games.filter((game) =>
    game.gameParticipations.some((gp) => gp.playerId === playerId)
  );
  const histories = data.histories
    .filter((history) => history.playerId === playerId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const eloTrail = [1000, ...histories.map((history) => history.elo)];
  const peakElo = Math.max(...eloTrail);
  const lowElo = Math.min(...eloTrail);
  const rank = calculateRank(data.playerStats, stats);
  const totalPlayers = data.playerStats.filter(
    (row) => totalGames(row) > 0
  ).length;
  const percentileValue =
    totalPlayers > 0 ? ((totalPlayers - rank) / totalPlayers) * 100 : 0;
  const mvpCount = outcomes.filter((outcome) => outcome.mvp).length;
  const closeWins = outcomes.filter(
    (outcome) => outcome.closeGame && outcome.won
  ).length;
  const underdogWins = outcomes.filter(
    (outcome) => outcome.underdog && outcome.won
  ).length;
  const captainGames = outcomes.filter((outcome) => outcome.captain);
  const draft = buildDraftSummary(personalGames, playerId);
  const mapSummary = buildMapSummary(outcomes);
  const relationships = buildRelationships(games, playerId);
  const seasonType = chooseSeasonType({
    stats,
    outcomes,
    mvpCount,
    closeWins,
    underdogWins,
    captainGames,
    draft,
    mapSummary,
  });
  const playerName = displayName(playerId, playerById);
  const highlights = buildHighlights({
    stats,
    outcomes,
    peakElo,
    lowElo,
    mvpCount,
    closeWins,
    underdogWins,
    captainGames,
    mapSummary,
    draft,
    relationships,
    playerById,
    memorableGame: findMemorableGame(personalGames, playerId, model),
  });

  return {
    seasonNumber: data.seasonNumber,
    playerName,
    title: `Season ${data.seasonNumber} Wrapped: ${playerName}`,
    description: `Your season type: **${seasonType}**`,
    fields: [
      {
        name: "Record",
        value: `${stats.wins}W-${stats.losses}L (${pct(winRate(stats))})`,
        inline: true,
      },
      {
        name: "Elo",
        value: `${stats.elo} final (${formatSigned(stats.elo - 1000)})`,
        inline: true,
      },
      {
        name: "Rank",
        value: `#${rank}/${totalPlayers} (${percentileValue.toFixed(1)}%)`,
        inline: true,
      },
      {
        name: "Highlights",
        value: highlights.join("\n"),
      },
    ],
    footer: `Season ${data.seasonNumber} • ${outcomes.length} games played`,
    summary: {
      games: outcomes.length,
      wins: stats.wins,
      losses: stats.losses,
      winRate: winRate(stats),
      finalElo: stats.elo,
      rank,
      totalPlayers,
      percentile: percentileValue,
      seasonType,
    },
  };
}

function collectPlayers(data: SeasonRecapData, games: SeasonRecapGame[]) {
  const playerById = new Map<string, SeasonRecapPlayer>();
  for (const stats of data.playerStats) {
    if (stats.player) playerById.set(stats.playerId, stats.player);
  }
  for (const game of games) {
    for (const gp of game.gameParticipations) {
      if (gp.player) playerById.set(gp.playerId, gp.player);
    }
  }
  return playerById;
}

function buildHighlights(context: {
  stats: SeasonRecapPlayerStats;
  outcomes: PlayerGameOutcome[];
  peakElo: number;
  lowElo: number;
  mvpCount: number;
  closeWins: number;
  underdogWins: number;
  captainGames: PlayerGameOutcome[];
  mapSummary: ReturnType<typeof buildMapSummary>;
  draft: ReturnType<typeof buildDraftSummary>;
  relationships: ReturnType<typeof buildRelationships>;
  playerById: Map<string, SeasonRecapPlayer>;
  memorableGame: string | null;
}) {
  const {
    stats,
    outcomes,
    peakElo,
    lowElo,
    mvpCount,
    closeWins,
    underdogWins,
    captainGames,
    mapSummary,
    draft,
    relationships,
    playerById,
    memorableGame,
  } = context;
  const lines = [
    `Played ${outcomes.length} games with a best win streak of ${stats.biggestWinStreak}.`,
    `Elo range: ${lowElo}-${peakElo}, finishing ${formatSigned(stats.elo - 1000)} from the season start.`,
  ];

  if (mvpCount > 0) lines.push(`Collected ${mvpCount} MVP${plural(mvpCount)}.`);
  if (closeWins > 0) {
    lines.push(`Won ${closeWins} close game${plural(closeWins)}.`);
  }
  if (underdogWins > 0) {
    lines.push(
      `Pulled off ${underdogWins} underdog win${plural(underdogWins)}.`
    );
  }
  if (captainGames.length > 0) {
    const captainWins = captainGames.filter((outcome) => outcome.won).length;
    lines.push(
      `Captained ${captainGames.length} time${plural(captainGames.length)} at ${pct(captainWins / captainGames.length)}.`
    );
  }
  if (mapSummary.best) {
    lines.push(
      `Best map: ${pretty(mapSummary.best.map)} (${mapSummary.best.wins}W-${mapSummary.best.games - mapSummary.best.wins}L).`
    );
  } else if (mapSummary.mostPlayed) {
    lines.push(
      `Most played map: ${pretty(mapSummary.mostPlayed.map)} (${mapSummary.mostPlayed.games} games).`
    );
  }
  if (draft.draftedGames > 0) {
    lines.push(
      `Average draft pick: ${draft.averageSlot.toFixed(1)} over ${draft.draftedGames} draft${plural(draft.draftedGames)}.`
    );
  }
  if (relationships.bestTeammate) {
    lines.push(
      `Best duo: ${displayName(relationships.bestTeammate.playerId, playerById)} (${relationships.bestTeammate.wins}W-${relationships.bestTeammate.games - relationships.bestTeammate.wins}L).`
    );
  } else if (relationships.frequentTeammate) {
    lines.push(
      `Most common teammate: ${displayName(relationships.frequentTeammate.playerId, playerById)} (${relationships.frequentTeammate.games} games).`
    );
  }
  if (relationships.bestOpponent) {
    lines.push(
      `Best matchup: ${displayName(relationships.bestOpponent.playerId, playerById)} (${relationships.bestOpponent.wins}W-${relationships.bestOpponent.games - relationships.bestOpponent.wins}L).`
    );
  }
  if (memorableGame) lines.push(memorableGame);

  return lines.slice(0, 7);
}

function buildMapSummary(outcomes: PlayerGameOutcome[]) {
  const rows = [...groupBy(outcomes, (outcome) => outcome.map).entries()].map(
    ([map, mapOutcomes]) => ({
      map,
      games: mapOutcomes.length,
      wins: mapOutcomes.filter((outcome) => outcome.won).length,
    })
  );
  const mostPlayed =
    [...rows].sort(
      (a, b) =>
        b.games - a.games || b.wins - a.wins || a.map.localeCompare(b.map)
    )[0] ?? null;
  const best =
    [...rows]
      .filter((row) => row.games >= 2)
      .sort(
        (a, b) =>
          b.wins / b.games - a.wins / a.games ||
          b.games - a.games ||
          a.map.localeCompare(b.map)
      )[0] ?? null;
  return { mostPlayed, best };
}

function buildDraftSummary(games: SeasonRecapGame[], playerId: string) {
  const slots = games
    .map(
      (game) =>
        game.gameParticipations.find((gp) => gp.playerId === playerId)
          ?.draftSlotPlacement
    )
    .filter((slot): slot is number => typeof slot === "number");
  return {
    draftedGames: slots.length,
    averageSlot: slots.length
      ? slots.reduce((sum, slot) => sum + slot, 0) / slots.length
      : 0,
    firstPicks: slots.filter((slot) => slot === Math.min(...slots)).length,
    latePicks: slots.filter((slot) => slot >= 4).length,
  };
}

function buildRelationships(games: SeasonRecapGame[], playerId: string) {
  const teammates = new Map<string, RelationshipRow>();
  const opponents = new Map<string, RelationshipRow>();

  for (const game of games) {
    const playerGp = game.gameParticipations.find(
      (gp) => gp.playerId === playerId
    );
    if (!playerGp) continue;
    const won = playerGp.team === game.winner;
    for (const gp of game.gameParticipations) {
      if (gp.playerId === playerId) continue;
      const bucket = gp.team === playerGp.team ? teammates : opponents;
      const row = bucket.get(gp.playerId) ?? {
        playerId: gp.playerId,
        games: 0,
        wins: 0,
      };
      row.games += 1;
      if (won) row.wins += 1;
      bucket.set(gp.playerId, row);
    }
  }

  return {
    frequentTeammate: topRelationship([...teammates.values()], "games"),
    bestTeammate: topRelationship(
      [...teammates.values()].filter((row) => row.games >= 2),
      "rate"
    ),
    bestOpponent: topRelationship(
      [...opponents.values()].filter((row) => row.games >= 2 && row.wins > 0),
      "rate"
    ),
  };
}

function findMemorableGame(
  games: SeasonRecapGame[],
  playerId: string,
  model: ReturnType<typeof buildSeasonRecapModel>
) {
  const rows = games
    .map((game) => {
      const gp = game.gameParticipations.find(
        (row) => row.playerId === playerId
      );
      const context = model.gameContexts.get(game.id);
      if (!gp || !context) return null;
      return { game, gp, context };
    })
    .filter(
      (
        row
      ): row is {
        game: SeasonRecapGame;
        gp: SeasonRecapGame["gameParticipations"][number];
        context: NonNullable<ReturnType<typeof model.gameContexts.get>>;
      } => row !== null
    )
    .sort((a, b) => b.context.eloGap - a.context.eloGap);

  const upset = rows.find(
    (row) =>
      row.context.underdogTeam === row.gp.team &&
      row.gp.team === row.game.winner
  );
  if (upset) {
    return `Signature game: ${pretty(upset.game.settings?.map ?? "Unknown")} on ${formatDate(upset.game.startTime)}, an underdog win by ${Math.round(upset.context.eloGap)} average Elo.`;
  }

  const mvpGame = rows.find((row) => row.gp.mvp);
  if (mvpGame) {
    return `Signature game: MVP on ${pretty(mvpGame.game.settings?.map ?? "Unknown")} (${formatDate(mvpGame.game.startTime)}).`;
  }

  const closeWin = rows.find(
    (row) => row.context.closeGame && row.gp.team === row.game.winner
  );
  if (closeWin) {
    return `Signature game: close win on ${pretty(closeWin.game.settings?.map ?? "Unknown")} (${formatDate(closeWin.game.startTime)}).`;
  }

  return null;
}

function chooseSeasonType(context: {
  stats: SeasonRecapPlayerStats;
  outcomes: PlayerGameOutcome[];
  mvpCount: number;
  closeWins: number;
  underdogWins: number;
  captainGames: PlayerGameOutcome[];
  draft: ReturnType<typeof buildDraftSummary>;
  mapSummary: ReturnType<typeof buildMapSummary>;
}) {
  const scores = [
    { label: "MVP Magnet", score: context.mvpCount * 5 },
    { label: "Clutch Closer", score: context.closeWins * 4 },
    { label: "Underdog Story", score: context.underdogWins * 4 },
    { label: "Captain Material", score: context.captainGames.length * 3 },
    {
      label: "Map Specialist",
      score: context.mapSummary.best
        ? (context.mapSummary.best.wins / context.mapSummary.best.games) * 6
        : 0,
    },
    {
      label: "Draft Steal",
      score:
        context.draft.draftedGames >= 2 && context.draft.averageSlot >= 4
          ? 5
          : 0,
    },
    { label: "Hot Streak", score: context.stats.biggestWinStreak * 2 },
  ].sort((a, b) => b.score - a.score);

  return scores[0]?.score > 0 ? scores[0].label : "Season Regular";
}

function calculateRank(
  playerStats: SeasonRecapPlayerStats[],
  stats: SeasonRecapPlayerStats
) {
  return (
    playerStats.filter((row) => totalGames(row) > 0 && row.elo > stats.elo)
      .length + 1
  );
}

function topRelationship(rows: RelationshipRow[], mode: "games" | "rate") {
  if (!rows.length) return null;
  return [...rows].sort((a, b) => {
    if (mode === "rate") {
      return (
        b.wins / b.games - a.wins / a.games ||
        b.wins - a.wins ||
        b.games - a.games ||
        a.playerId.localeCompare(b.playerId)
      );
    }
    return (
      b.games - a.games ||
      b.wins - a.wins ||
      a.playerId.localeCompare(b.playerId)
    );
  })[0];
}

function displayName(
  playerId: string,
  players: Map<string, SeasonRecapPlayer>
) {
  void playerId;
  return escapeIgn(players.get(playerId)?.latestIGN ?? "Unknown Player");
}

function totalGames(stats: SeasonRecapPlayerStats) {
  return stats.wins + stats.losses;
}

function winRate(stats: SeasonRecapPlayerStats) {
  const games = totalGames(stats);
  return games ? stats.wins / games : 0;
}

function formatSigned(value: number) {
  return value > 0 ? `+${value}` : `${value}`;
}

function plural(count: number) {
  return count === 1 ? "" : "s";
}
