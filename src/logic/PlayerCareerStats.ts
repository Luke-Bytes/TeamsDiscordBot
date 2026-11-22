import { SeasonType, Team } from "@prisma/client";
import { prismaClient } from "../database/prismaClient";

/**
 * The read-only, saved-record equivalent of the detailed /stats counters.
 * Lifetime wins/losses and streak records come from PlayerStats (also used
 * for titles and leaderboards); match achievements use the same participation
 * conditions as /stats detailed:true. Do not load entire season recaps for a
 * single career question.
 */
export async function getSavedPlayerCareerStats(player: {
  id: string;
  latestIGN: string | null;
}) {
  const where = { playerId: player.id };
  const completed = {
    playerId: player.id,
    game: { is: { finished: true } },
  };
  const won = {
    OR: [
      { team: Team.RED, game: { is: { finished: true, winner: Team.RED } } },
      { team: Team.BLUE, game: { is: { finished: true, winner: Team.BLUE } } },
    ],
  };
  const [
    totals,
    mvps,
    captainGames,
    captainWins,
    doubleEloWins,
    bestRanked,
    lastGame,
  ] = await Promise.all([
    prismaClient.playerStats.aggregate({
      where,
      _sum: { wins: true, losses: true },
      _max: { biggestWinStreak: true, biggestLosingStreak: true },
      _count: { _all: true },
    }),
    prismaClient.gameParticipation.count({
      where: { ...completed, mvp: true },
    }),
    prismaClient.gameParticipation.count({
      where: { ...completed, captain: true },
    }),
    prismaClient.gameParticipation.count({
      where: { playerId: player.id, captain: true, ...won },
    }),
    prismaClient.gameParticipation.count({
      where: {
        playerId: player.id,
        game: { is: { finished: true, doubleElo: true } },
        OR: won.OR,
      },
    }),
    prismaClient.playerStats.findFirst({
      where: {
        playerId: player.id,
        season: {
          is: { OR: [{ type: SeasonType.RANKED }, { type: null }] },
        },
      },
      orderBy: { elo: "desc" },
      select: { elo: true, season: { select: { number: true } } },
    }),
    prismaClient.gameParticipation.findFirst({
      where: completed,
      orderBy: { game: { endTime: "desc" } },
      select: { game: { select: { endTime: true } } },
    }),
  ]);
  if (!totals._count._all)
    return {
      status: "no_stats" as const,
      player: player.latestIGN ?? "Unknown",
      scope: "saved bot records across all seasons",
    };

  const wins = totals._sum.wins ?? 0;
  const losses = totals._sum.losses ?? 0;
  const gamesPlayed = wins + losses;
  return {
    status: "ok" as const,
    player: player.latestIGN ?? "Unknown",
    scope: "saved bot records across all seasons",
    wins,
    losses,
    gamesPlayed,
    winRatePercent:
      gamesPlayed > 0 ? Number(((wins / gamesPlayed) * 100).toFixed(1)) : null,
    seasonsWithStats: totals._count._all,
    bestSingleSeasonWinStreak: totals._max.biggestWinStreak ?? 0,
    bestSingleSeasonLosingStreak: totals._max.biggestLosingStreak ?? 0,
    mvps,
    captainGames,
    captainWins,
    captainWinRatePercent:
      captainGames > 0
        ? Number(((captainWins / captainGames) * 100).toFixed(1))
        : null,
    doubleEloWins,
    highestSavedRankedSeasonElo: bestRanked
      ? { season: bestRanked.season.number, elo: bestRanked.elo }
      : null,
    mostRecentFinishedGameAt: lastGame?.game.endTime.toISOString() ?? null,
    notes: [
      "Cumulative bot PlayerStats, not REST_API-only records or live games.",
      "Streak maxima are within individual seasons, not a cross-season continuous streak.",
      "Highest Ranked Elo is a saved season rating, not the highest Elo reached mid-season.",
      "Match achievements count saved finished games only.",
    ],
  };
}
