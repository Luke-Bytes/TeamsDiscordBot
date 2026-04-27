import {
  formatSeasonSpan,
  groupBy,
  pct,
  playerName,
  prefixRows,
  totalGames,
} from "./formatting";
import {
  InsightSection,
  PlayerGameOutcome,
  SeasonRecapEloHistory,
  SeasonRecapGame,
  SeasonRecapPlayer,
  SeasonRecapPlayerStats,
  SeasonRecapThresholds,
} from "./types";

export function buildSnapshot(
  seasonNumber: number,
  games: SeasonRecapGame[],
  playerCount: number,
  dateRange: string
): InsightSection {
  return {
    title: `🎉 Friendly Wars Season ${seasonNumber} Recap`,
    lines: [
      `Season ${seasonNumber} ran from ${dateRange} across ${formatSeasonSpan(games)}.`,
      `${games.length} finished games were played by ${playerCount} players.`,
      "Here are the storylines, standout runs, draft patterns, and community moments that shaped the season.",
    ],
  };
}

export function buildEloStorylines(
  playerStats: SeasonRecapPlayerStats[],
  histories: SeasonRecapEloHistory[],
  outcomesByPlayer: Map<string, PlayerGameOutcome[]>,
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds,
  minGames: number
): InsightSection {
  const historyByPlayer = groupBy(histories, (h) => h.playerId);
  const topElo = playerStats
    .filter((ps) => totalGames(ps) >= minGames)
    .sort((a, b) => b.elo - a.elo)
    .slice(0, thresholds.topLimit)
    .map((ps) => `${playerName(ps.playerId, playerById)}: ${ps.elo} Elo`);

  const climbs = [...historyByPlayer.entries()]
    .map(([playerId, rows]) => {
      const elos = [1000, ...rows.map((r) => r.elo)];
      const lowest = Math.min(...elos);
      const final = elos.at(-1)!;
      return {
        playerId,
        delta: final - lowest,
        final,
        lowest,
        games: outcomesByPlayer.get(playerId)?.length ?? 0,
      };
    })
    .filter((r) => r.games >= minGames && r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, thresholds.topLimit)
    .map(
      (r) =>
        `${playerName(r.playerId, playerById)}: +${r.delta} from season low (${r.lowest} → ${r.final})`
    );

  const drops = [...historyByPlayer.entries()]
    .map(([playerId, rows]) => {
      const elos = [1000, ...rows.map((r) => r.elo)];
      return {
        playerId,
        delta: Math.max(...elos) - elos.at(-1)!,
        games: outcomesByPlayer.get(playerId)?.length ?? 0,
      };
    })
    .filter((r) => r.games >= minGames && r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, thresholds.topLimit)
    .map((r) => `${playerName(r.playerId, playerById)}: -${r.delta} from peak`);

  return {
    title: "📈 Elo Storylines",
    lines: [
      ...prefixRows("Top Elo", topElo),
      ...prefixRows("Biggest Elo Recoveries", climbs),
      ...prefixRows("Biggest Elo Drops", drops),
    ],
  };
}

export function buildFormTrends(
  playerStats: SeasonRecapPlayerStats[],
  outcomesByPlayer: Map<string, PlayerGameOutcome[]>,
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds,
  minGames: number
): InsightSection {
  const winStreaks = playerStats
    .filter((ps) => totalGames(ps) >= minGames && ps.biggestWinStreak > 0)
    .sort((a, b) => b.biggestWinStreak - a.biggestWinStreak)
    .slice(0, thresholds.topLimit)
    .map(
      (ps) => `${playerName(ps.playerId, playerById)}: ${ps.biggestWinStreak}`
    );
  const losingStreaks = playerStats
    .filter((ps) => totalGames(ps) >= minGames && ps.biggestLosingStreak > 0)
    .sort((a, b) => b.biggestLosingStreak - a.biggestLosingStreak)
    .slice(0, thresholds.topLimit)
    .map(
      (ps) =>
        `${playerName(ps.playerId, playerById)}: ${ps.biggestLosingStreak}`
    );
  const finishers = [...outcomesByPlayer.entries()]
    .map(([playerId, outcomes]) => {
      const tail = outcomes.slice(Math.floor(outcomes.length * 0.66));
      const wins = tail.filter((o) => o.won).length;
      return {
        playerId,
        games: outcomes.length,
        tailGames: tail.length,
        wins,
        rate: tail.length ? wins / tail.length : 0,
      };
    })
    .filter((r) => r.games >= minGames && r.tailGames >= 2)
    .sort((a, b) => b.rate - a.rate || b.wins - a.wins)
    .slice(0, thresholds.topLimit)
    .map(
      (r) =>
        `${playerName(r.playerId, playerById)}: ${pct(r.rate)} over final ${r.tailGames} games`
    );

  return {
    title: "🔥 Form Trends",
    lines: [
      ...prefixRows("Biggest Win Streaks", winStreaks),
      ...prefixRows("Biggest Losing Streaks", losingStreaks),
      ...prefixRows("Best Final-Third Win Rate", finishers),
    ],
  };
}

export function buildCaptainImpact(
  outcomesByPlayer: Map<string, PlayerGameOutcome[]>,
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds
): InsightSection {
  const rows = [...outcomesByPlayer.entries()].map(([playerId, outcomes]) => {
    const captainGames = outcomes.filter((o) => o.captain);
    return {
      playerId,
      caps: captainGames.length,
      wins: captainGames.filter((o) => o.won).length,
      underdogWins: captainGames.filter((o) => o.underdog && o.won).length,
    };
  });
  const most = rows
    .filter((r) => r.caps > 0)
    .sort((a, b) => b.caps - a.caps)
    .slice(0, thresholds.topLimit)
    .map((r) => `${playerName(r.playerId, playerById)}: ${r.caps} caps`);
  const best = rows
    .filter((r) => r.caps >= thresholds.minCaptainGames)
    .sort((a, b) => b.wins / b.caps - a.wins / a.caps || b.caps - a.caps)
    .slice(0, thresholds.topLimit)
    .map(
      (r) =>
        `${playerName(r.playerId, playerById)}: ${pct(r.wins / r.caps)} (${r.wins}/${r.caps})`
    );
  const underdogs = rows
    .filter((r) => r.underdogWins > 0)
    .sort((a, b) => b.underdogWins - a.underdogWins)
    .slice(0, thresholds.topLimit)
    .map(
      (r) =>
        `${playerName(r.playerId, playerById)}: ${r.underdogWins} upset wins`
    );

  return {
    title: "👑 Captain Impact",
    lines: [
      ...prefixRows("Most trusted", most),
      ...prefixRows("Best rate", best),
      ...prefixRows("Upset captains", underdogs),
    ],
  };
}

export function buildMvpTrends(
  outcomesByPlayer: Map<string, PlayerGameOutcome[]>,
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds,
  minGames: number
): InsightSection {
  const rows = [...outcomesByPlayer.entries()].map(([playerId, outcomes]) => ({
    playerId,
    games: outcomes.length,
    mvps: outcomes.filter((o) => o.mvp).length,
  }));
  const leaders = rows
    .filter((r) => r.mvps > 0)
    .sort((a, b) => b.mvps - a.mvps)
    .slice(0, thresholds.topLimit)
    .map((r) => `${playerName(r.playerId, playerById)}: ${r.mvps} MVPs`);
  const rates = rows
    .filter(
      (r) => r.games >= Math.max(thresholds.minMvpGames, minGames) && r.mvps > 0
    )
    .sort((a, b) => b.mvps / b.games - a.mvps / a.games || b.mvps - a.mvps)
    .slice(0, thresholds.topLimit)
    .map(
      (r) =>
        `${playerName(r.playerId, playerById)}: ${pct(r.mvps / r.games)} (${r.mvps}/${r.games})`
    );
  return {
    title: "🌟 MVP Trends",
    lines: [
      ...prefixRows("Most MVPs", leaders),
      ...prefixRows("Highest MVP Rate", rates),
    ],
  };
}

export function buildMvpVotingFun(
  games: SeasonRecapGame[],
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds
): InsightSection {
  const votesByPlayer = new Map<string, { voted: number; games: number }>();
  const teamVoteRates: number[] = [];

  for (const game of games) {
    for (const gp of game.gameParticipations) {
      const row = votesByPlayer.get(gp.playerId) ?? { voted: 0, games: 0 };
      row.games += 1;
      if (gp.votedForAMVP) row.voted += 1;
      votesByPlayer.set(gp.playerId, row);
    }

    for (const team of new Set(game.gameParticipations.map((gp) => gp.team))) {
      const teamPlayers = game.gameParticipations.filter(
        (gp) => gp.team === team
      );
      if (!teamPlayers.length) continue;
      const voted = teamPlayers.filter((gp) => gp.votedForAMVP).length;
      teamVoteRates.push(voted / teamPlayers.length);
    }
  }

  const topVoters = [...votesByPlayer.entries()]
    .filter(([, row]) => row.voted > 0)
    .sort((a, b) => b[1].voted - a[1].voted || b[1].games - a[1].games)
    .slice(0, thresholds.topLimit)
    .map(
      ([playerId, row]) =>
        `${playerName(playerId, playerById)}: voted in ${row.voted}/${row.games} games`
    );
  const averageVoteRate =
    teamVoteRates.length > 0
      ? teamVoteRates.reduce((sum, rate) => sum + rate, 0) /
        teamVoteRates.length
      : 0;

  return {
    title: "🗳️ MVP Voting",
    lines: [
      ...prefixRows("Most Reliable Voters", topVoters),
      teamVoteRates.length
        ? `Average team ballot turnout: ${pct(averageVoteRate)} of players voted.`
        : "",
    ].filter(Boolean),
  };
}

export function buildDraftOrderInsights(
  games: SeasonRecapGame[],
  playerById: Map<string, SeasonRecapPlayer>,
  thresholds: SeasonRecapThresholds
): InsightSection {
  const rows = new Map<
    string,
    {
      draftedGames: number;
      firstPicks: number;
      lastPicks: number;
      slotTotal: number;
    }
  >();

  for (const game of games) {
    const drafted = game.gameParticipations.filter(
      (gp) => typeof gp.draftSlotPlacement === "number"
    );
    if (!drafted.length) continue;

    const slots = drafted.map((gp) => gp.draftSlotPlacement!);
    const firstSlot = Math.min(...slots);
    const lastSlot = Math.max(...slots);

    for (const gp of drafted) {
      const row = rows.get(gp.playerId) ?? {
        draftedGames: 0,
        firstPicks: 0,
        lastPicks: 0,
        slotTotal: 0,
      };
      row.draftedGames += 1;
      row.slotTotal += gp.draftSlotPlacement!;
      if (gp.draftSlotPlacement === firstSlot) row.firstPicks += 1;
      if (gp.draftSlotPlacement === lastSlot) row.lastPicks += 1;
      rows.set(gp.playerId, row);
    }
  }

  const minDraftedGames = Math.max(2, thresholds.minCaptainGames);
  const firstPicks = [...rows.entries()]
    .filter(([, row]) => row.firstPicks > 0)
    .sort((a, b) => b[1].firstPicks - a[1].firstPicks)
    .slice(0, thresholds.topLimit)
    .map(
      ([playerId, row]) =>
        `${playerName(playerId, playerById)}: ${row.firstPicks} first picks`
    );
  const lastPicks = [...rows.entries()]
    .filter(([, row]) => row.lastPicks > 0)
    .sort((a, b) => b[1].lastPicks - a[1].lastPicks)
    .slice(0, thresholds.topLimit)
    .map(
      ([playerId, row]) =>
        `${playerName(playerId, playerById)}: ${row.lastPicks} final picks`
    );
  const earliestAverage = [...rows.entries()]
    .filter(([, row]) => row.draftedGames >= minDraftedGames)
    .sort(
      (a, b) =>
        a[1].slotTotal / a[1].draftedGames -
          b[1].slotTotal / b[1].draftedGames ||
        b[1].draftedGames - a[1].draftedGames
    )
    .slice(0, thresholds.topLimit)
    .map(([playerId, row]) => {
      const average = row.slotTotal / row.draftedGames;
      return `${playerName(playerId, playerById)}: avg pick ${average.toFixed(1)} over ${row.draftedGames} drafts`;
    });

  return {
    title: "📋 Draft Board",
    lines: [
      ...prefixRows("First off the board", firstPicks),
      ...prefixRows("Final picks", lastPicks),
      ...prefixRows("Earliest average pick", earliestAverage),
    ],
  };
}
