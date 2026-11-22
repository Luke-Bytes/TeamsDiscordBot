import { SeasonType, Team } from "@prisma/client";
import { prismaClient } from "../database/prismaClient";
import { SeasonService } from "../database/SeasonService";

/**
 * A small public candidate pool, not a made-up overall skill ranking.
 * Draws from independent career-win, current-season and finished-game MVP
 * signals so an open-ended draft question cannot default to wins alone.
 */
export async function getPlayerPerformanceShortlist() {
  const season = await SeasonService.getActiveSeason();
  const ranked = season?.type !== SeasonType.RELAXED;
  const [careerLeaders, seasonLeaders, mvpLeaders] = await Promise.all([
    prismaClient.playerStats.groupBy({
      by: ["playerId"],
      _sum: { wins: true },
      orderBy: { _sum: { wins: "desc" } },
      take: 4,
    }),
    season
      ? prismaClient.playerStats.findMany({
          where: {
            seasonId: season.id,
            OR: [{ wins: { gt: 0 } }, { losses: { gt: 0 } }],
          },
          orderBy: ranked
            ? [{ elo: "desc" }]
            : [{ wins: "desc" }, { biggestWinStreak: "desc" }],
          take: 4,
          select: { playerId: true },
        })
      : Promise.resolve([]),
    prismaClient.gameParticipation.groupBy({
      by: ["playerId"],
      where: { mvp: true, game: { is: { finished: true } } },
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
      take: 4,
    }),
  ]);
  const signals = new Map<string, string[]>();
  const register = (id: string, signal: string) => {
    const found = signals.get(id);
    if (found) found.push(signal);
    else signals.set(id, [signal]);
  };
  careerLeaders.forEach((p) => register(p.playerId, "career wins"));
  seasonLeaders.forEach((p) =>
    register(
      p.playerId,
      ranked ? "current Ranked Elo" : "current Relaxed activity"
    )
  );
  mvpLeaders.forEach((p) => register(p.playerId, "finished-game MVPs"));
  const ids = [...signals.keys()];
  if (!ids.length)
    return { status: "no_stats", notes: "No candidate records found" };

  const winner = [
    {
      team: Team.RED,
      game: { is: { finished: true, winner: Team.RED } },
    },
    {
      team: Team.BLUE,
      game: { is: { finished: true, winner: Team.BLUE } },
    },
  ];
  const [players, totals, mvps, captains, captainWins, current] =
    await Promise.all([
      prismaClient.player.findMany({
        where: { id: { in: ids } },
        select: { id: true, latestIGN: true },
      }),
      prismaClient.playerStats.groupBy({
        by: ["playerId"],
        where: { playerId: { in: ids } },
        _sum: { wins: true, losses: true },
        _max: { biggestWinStreak: true },
      }),
      prismaClient.gameParticipation.groupBy({
        by: ["playerId"],
        where: {
          playerId: { in: ids },
          mvp: true,
          game: { is: { finished: true } },
        },
        _count: { _all: true },
      }),
      prismaClient.gameParticipation.groupBy({
        by: ["playerId"],
        where: {
          playerId: { in: ids },
          captain: true,
          game: { is: { finished: true } },
        },
        _count: { _all: true },
      }),
      prismaClient.gameParticipation.groupBy({
        by: ["playerId"],
        where: { playerId: { in: ids }, captain: true, OR: winner },
        _count: { _all: true },
      }),
      season
        ? prismaClient.playerStats.findMany({
            where: { seasonId: season.id, playerId: { in: ids } },
            select: {
              playerId: true,
              wins: true,
              losses: true,
              elo: true,
              winStreak: true,
            },
          })
        : Promise.resolve([]),
    ]);
  const names = new Map(players.map((p) => [p.id, p.latestIGN]));
  const record = new Map(totals.map((r) => [r.playerId, r]));
  const mvpCount = new Map(mvps.map((r) => [r.playerId, r._count._all]));
  const captainCount = new Map(
    captains.map((r) => [r.playerId, r._count._all])
  );
  const captainWinsCount = new Map(
    captainWins.map((r) => [r.playerId, r._count._all])
  );
  const seasonStats = new Map(current.map((r) => [r.playerId, r]));
  return {
    status: "ok",
    season: season?.number ?? null,
    seasonType: season?.type ?? null,
    selection:
      "Up to 4 leaders each by career wins, current season standing and MVP count; not an overall ranking",
    candidates: ids
      .filter((id) => names.get(id))
      .map((id) => {
        const row = record.get(id);
        const wins = row?._sum.wins ?? 0;
        const losses = row?._sum.losses ?? 0;
        const games = wins + losses;
        const captainGames = captainCount.get(id) ?? 0;
        const played = seasonStats.get(id);
        return {
          player: names.get(id),
          selectedFor: signals.get(id),
          career: {
            wins,
            losses,
            games,
            winRatePercent:
              games > 0 ? Number(((wins / games) * 100).toFixed(1)) : null,
            bestSeasonWinStreak: row?._max.biggestWinStreak ?? 0,
            mvps: mvpCount.get(id) ?? 0,
            captainGames,
            captainWins: captainWinsCount.get(id) ?? 0,
          },
          currentSeason: played
            ? {
                wins: played.wins,
                losses: played.losses,
                elo: ranked ? played.elo : null,
                winStreak: played.winStreak,
              }
            : null,
        };
      }),
    notes:
      "Saved bot records only (Ranked and Relaxed career combined); season Elo is null for Relaxed; MVP/captain counts use finished games. A shortlist is not a full-player ranking. Compare win rates with sample sizes; Elo is a current saved season rating, not peak ability. No role fit or team synergy is verified.",
  };
}
