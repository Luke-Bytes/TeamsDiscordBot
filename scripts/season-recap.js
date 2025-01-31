const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const _ = require("lodash");

// Can add --database-url parameter to command or else defaults to .env
const databaseUrl = process.env.DATABASE_URL;
if (process.argv.includes("--database-url")) {
  const manualDbUrlIndex = process.argv.indexOf("--database-url") + 1;
  if (manualDbUrlIndex < process.argv.length) {
    process.env.DATABASE_URL = process.argv[manualDbUrlIndex];
    console.log(
      `Using manually provided DATABASE_URL: ${process.env.DATABASE_URL}`
    );
  } else {
    console.error("Error: --database-url flag provided without a value.");
    process.exit(1);
  }
} else {
  console.log(`Using DATABASE_URL from .env: ${databaseUrl}`);
}

const prisma = new PrismaClient();

async function generateSeasonRecap() {
  const logPath = path.resolve(__dirname, "../logs/season_recap.txt");

  if (!fs.existsSync(path.dirname(logPath))) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  }

  const logStream = fs.createWriteStream(logPath, { flags: "w" });

  const writeLog = (content) => {
    console.log(content);
    logStream.write(content + "\n");
  };

  writeLog("🎉 End of Season Recap 🎉\n");

  // Top 3 wins
  const mostWins = await prisma.player.findMany({
    orderBy: { wins: "desc" },
    take: 3,
    select: { latestIGN: true, wins: true },
  });
  if (mostWins.length > 0) {
    writeLog("🎖 Top 3 Players by Wins:");
    mostWins.forEach((player, index) =>
      writeLog(`${index + 1}. ${player.latestIGN} (${player.wins} wins)`)
    );
  }

  // Top 3 losses
  const mostLosses = await prisma.player.findMany({
    orderBy: { losses: "desc" },
    take: 3,
    select: { latestIGN: true, losses: true },
  });
  if (mostLosses.length > 0) {
    writeLog("💔 Top 3 Players by Losses:");
    mostLosses.forEach((player, index) =>
      writeLog(`${index + 1}. ${player.latestIGN} (${player.losses} losses)`)
    );
  }

  // Top 3 winning streaks
  const longestWinStreaks = await prisma.player.findMany({
    orderBy: { biggestWinStreak: "desc" },
    take: 3,
    select: { latestIGN: true, biggestWinStreak: true },
  });
  if (longestWinStreaks.length > 0) {
    writeLog("🔥 Top 3 Longest Win Streaks:");
    longestWinStreaks.forEach((player, index) =>
      writeLog(
        `${index + 1}. ${player.latestIGN} (${player.biggestWinStreak} wins)`
      )
    );
  }

  // Top 3 losing streaks
  const longestLosingStreaks = await prisma.player.findMany({
    orderBy: { biggestLosingStreak: "desc" },
    take: 3,
    select: { latestIGN: true, biggestLosingStreak: true },
  });
  if (longestLosingStreaks.length > 0) {
    writeLog("💀 Top 3 Longest Losing Streaks:");
    longestLosingStreaks.forEach((player, index) =>
      writeLog(
        `${index + 1}. ${player.latestIGN} (${player.biggestLosingStreak} losses)`
      )
    );
  }

  const totalGamesPlayed = await prisma.game.count();
  writeLog(`📊 Total Games Played: ${totalGamesPlayed}`);

  // Most Popular Maps
  const gamesMaps = await prisma.game.findMany({
    select: {
      settings: true,
    },
  });
  const mapCounts = {};
  gamesMaps.forEach((game) => {
    const map = game.settings.map;
    if (map) {
      mapCounts[map] = (mapCounts[map] || 0) + 1;
    }
  });
  const topMaps = Object.entries(mapCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (topMaps.length > 0) {
    writeLog("🌍 Most Played Maps:");
    topMaps.forEach((map, index) => {
      writeLog(`${index + 1}. ${map[0]} (${map[1]} games)`);
    });
  } else {
    writeLog("🌍 Top 3 Most Played Maps: No map data available.");
  }

  // Top 3 MVPs
  const mvpCounts = await prisma.gameParticipation.groupBy({
    by: ["playerId"],
    where: { mvp: true },
    _count: { playerId: true },
    orderBy: { _count: { playerId: "desc" } },
    take: 3,
  });
  if (mvpCounts.length > 0) {
    writeLog("🌟 Top 3 Players with Most MVPs:");
    for (const [index, mvp] of mvpCounts.entries()) {
      const player = await prisma.player.findUnique({
        where: { id: mvp.playerId },
        select: { latestIGN: true },
      });
      writeLog(
        `${index + 1}. ${player?.latestIGN} (${mvp._count.playerId} MVPs)`
      );
    }
  } else {
    writeLog("🌟 Top 3 Players with Most MVPs: No MVP data available.");
  }

  // Top 3 Biggest Comebacks (only for players who went below 950 Elo)
  const eloHistories = await prisma.eloHistory.findMany({
    select: { playerId: true, elo: true },
    orderBy: { createdAt: "asc" },
  });

  const improvementData = {};
  eloHistories.forEach(({ playerId, elo }) => {
    if (!improvementData[playerId]) {
      improvementData[playerId] = {
        minElo: elo,
        maxElo: elo,
        wentBelow950: elo < 950,
      };
    } else {
      improvementData[playerId].minElo = Math.min(
        improvementData[playerId].minElo,
        elo
      );
      improvementData[playerId].maxElo = Math.max(
        improvementData[playerId].maxElo,
        elo
      );
      if (elo < 950) {
        improvementData[playerId].wentBelow950 = true;
      }
    }
  });

  const mostImproved = Object.entries(improvementData)
    .filter(([, data]) => data.wentBelow950)
    .map(([playerId, { minElo, maxElo }]) => ({
      playerId,
      improvement: maxElo - minElo,
      minElo,
      maxElo,
    }))
    .sort((a, b) => b.improvement - a.improvement)
    .slice(0, 3);

  if (mostImproved.length > 0) {
    writeLog("📈 Top 3 Biggest Comebacks (from below 950 Elo):");
    for (const [index, data] of mostImproved.entries()) {
      const player = await prisma.player.findUnique({
        where: { id: data.playerId },
        select: { latestIGN: true },
      });
      writeLog(
        `${index + 1}. ${player?.latestIGN} (Improvement: +${data.improvement} Elo, Lowest: ${data.minElo}, Highest: ${data.maxElo})`
      );
    }
  } else {
    writeLog(
      "📈 Top 3 Most Improved Players (from below 950 Elo): No improvement data available."
    );
  }

  // Top 3 Consistent Players
  const MIN_GAMES_PLAYED = 10;

  const consistencyKings = await prisma.player.findMany({
    include: {
      eloHistories: {
        select: {
          elo: true,
        },
      },
      games: true,
    },
  });

  const consistencyData = consistencyKings
    .filter(
      (player) =>
        player.eloHistories.length > 0 &&
        player.games.length >= MIN_GAMES_PLAYED
    )
    .map((player) => {
      const elos = player.eloHistories.map((eh) => eh.elo);
      const maxElo = Math.max(...elos);
      const minElo = Math.min(...elos);
      const fluctuation = maxElo - minElo;
      return {
        latestIGN: player.latestIGN,
        fluctuation,
        gamesPlayed: player.games.length,
      };
    })
    .filter((data) => !isNaN(data.fluctuation))
    .sort((a, b) => a.fluctuation - b.fluctuation)
    .slice(0, 3);

  if (consistencyData.length > 0) {
    writeLog(
      `🎯 Top 3 Consistency Kings (Smallest Elo Fluctuation, Minimum ${MIN_GAMES_PLAYED} Games):`
    );
    consistencyData.forEach((player, index) => {
      writeLog(
        `${index + 1}. ${player.latestIGN} (Elo Fluctuation: ${player.fluctuation}, Games Played: ${player.gamesPlayed})`
      );
    });
  } else {
    writeLog(
      `🎯 Top 3 Consistency Kings: No players met the minimum ${MIN_GAMES_PLAYED} games threshold.`
    );
  }

  // Top 3 Most Active Players
  const mostActivePlayers = await prisma.player.findMany({
    select: {
      latestIGN: true,
      _count: {
        select: {
          games: true,
        },
      },
    },
    orderBy: {
      games: {
        _count: "desc",
      },
    },
    take: 3,
  });

  if (mostActivePlayers.length > 0) {
    writeLog("🏃‍♂️ Top 3 Most Active Players:");
    mostActivePlayers.forEach((player, index) => {
      writeLog(
        `${index + 1}. ${player.latestIGN} (${player._count.games} games)`
      );
    });
  } else {
    writeLog("🏃‍♂️ Top 3 Most Active Players: No data available.");
  }

  // Top 3 Captains by Win Rate
  const captainWinStats = await prisma.gameParticipation.groupBy({
    by: ["playerId"],
    where: { captain: true },
    _count: { playerId: true },
  });
  const captainWinCounts = {};
  for (const stat of captainWinStats) {
    const totalGamesAsCaptain = stat._count.playerId;
    const winsAsCaptain = await prisma.gameParticipation.count({
      where: {
        playerId: stat.playerId,
        captain: true,
        game: {
          winner: {
            equals: (
              await prisma.gameParticipation.findFirst({
                where: { playerId: stat.playerId, captain: true },
                select: { team: true },
              })
            )?.team,
          },
        },
      },
    });
    captainWinCounts[stat.playerId] = {
      winRate: (winsAsCaptain / totalGamesAsCaptain) * 100,
      totalGames: totalGamesAsCaptain,
    };
  }

  const topCaptains = Object.entries(captainWinCounts)
    .sort(([, a], [, b]) => b.winRate - a.winRate)
    .slice(0, 3);

  if (topCaptains.length > 0) {
    writeLog("👑 Top 3 Captains by Win Rate:");
    for (const [index, [playerId, data]] of topCaptains.entries()) {
      const player = await prisma.player.findUnique({
        where: { id: playerId },
        select: { latestIGN: true },
      });

      writeLog(
        `${index + 1}. ${player?.latestIGN || "Unknown"}: ${data.winRate.toFixed(
          2
        )}% win rate (${data.totalGames} games)`
      );
    }
  } else {
    writeLog("👑 Top 3 Captains by Win Rate: No captain data available.");
  }

  // Top 3 Captains by Loss Rate
  const captainsGames = await prisma.gameParticipation.findMany({
    where: { captain: true },
    select: {
      playerId: true,
      team: true,
      game: {
        select: { winner: true },
      },
    },
  });
  const captainStats = {};
  captainsGames.forEach((participation) => {
    const { playerId, team, game } = participation;
    if (!captainStats[playerId]) {
      captainStats[playerId] = {
        playerId,
        team,
        totalGames: 0,
        losses: 0,
      };
    }
    captainStats[playerId].totalGames++;
    if (game.winner !== team) {
      captainStats[playerId].losses++;
    }
  });
  const captainLossRates = Object.values(captainStats).map((stat) => {
    const lossRate = stat.totalGames > 0 ? stat.losses / stat.totalGames : 0;
    return {
      playerId: stat.playerId,
      team: stat.team,
      totalGames: stat.totalGames,
      losses: stat.losses,
      lossRate,
    };
  });
  const topCaptainsByLossRate = await Promise.all(
    captainLossRates
      .sort((a, b) => b.lossRate - a.lossRate)
      .slice(0, 3)
      .map(async (captain) => {
        const player = await prisma.player.findUnique({
          where: { id: captain.playerId },
          select: { latestIGN: true },
        });
        return {
          ...captain,
          ign: player?.latestIGN || "Unknown",
        };
      })
  );
  if (topCaptainsByLossRate.length > 0) {
    writeLog("⚓ Top 3 Captains by Loss Rate:");
    topCaptainsByLossRate.forEach((captain, index) =>
      writeLog(
        `${index + 1}. ${captain.ign} - Loss Rate: ${(
          captain.lossRate * 100
        ).toFixed(2)}% (${captain.losses}/${captain.totalGames} games)`
      )
    );
  } else {
    writeLog("⚓ Top 3 Captains by Loss Rate: No data available.");
  }

  // Team win rates
  const teamWinCounts = await prisma.game.groupBy({
    by: ["winner"],
    _count: { winner: true },
  });

  const totalGamesWithWinners = teamWinCounts.reduce(
    (sum, team) => sum + team._count.winner,
    0
  );

  if (teamWinCounts.length > 0) {
    writeLog("🔴🔵 Team Win Rates:");
    teamWinCounts.forEach((team) => {
      const teamName = team.winner === "RED" ? "RED" : "BLUE";
      const winRate = (
        (team._count.winner / totalGamesWithWinners) *
        100
      ).toFixed(2);
      writeLog(`${teamName}: ${team._count.winner} wins (${winRate}%)`);
    });
  } else {
    writeLog("🔴🔵 Team Win Rates: No team data available.");
  }

  // Best Underdog Team Victory
  async function identifyUnderdogVictories() {
    const games = await prisma.game.findMany({
      where: { finished: true },
      include: {
        gameParticipations: {
          include: { player: true },
        },
        settings: true,
      },
    });

    const underdogVictories = [];
    for (const game of games) {
      const redTeam = game.gameParticipations.filter((p) => p.team === "RED");
      const blueTeam = game.gameParticipations.filter((p) => p.team === "BLUE");
      const redTeamElo = _.meanBy(redTeam, (p) => p.player.elo);
      const blueTeamElo = _.meanBy(blueTeam, (p) => p.player.elo);
      const winner = game.winner;
      const losingTeamElo = winner === "RED" ? blueTeamElo : redTeamElo;
      const winningTeamElo = winner === "RED" ? redTeamElo : blueTeamElo;

      if (losingTeamElo > winningTeamElo) {
        underdogVictories.push({
          gameId: game.id,
          map: game.settings?.map || "Unknown Map",
          date: new Date(game.startTime).toLocaleDateString("en-GB"),
          redTeam: redTeam.map((p) => ({ ign: p.ignUsed, elo: p.player.elo })),
          blueTeam: blueTeam.map((p) => ({
            ign: p.ignUsed,
            elo: p.player.elo,
          })),
          redTeamElo: redTeamElo.toFixed(2),
          blueTeamElo: blueTeamElo.toFixed(2),
          eloDifference: Math.abs(redTeamElo - blueTeamElo).toFixed(2),
          winner,
        });
      }
    }

    const topUnderdogVictories = underdogVictories
      .sort((a, b) => b.eloDifference - a.eloDifference)
      .slice(0, 1);

    writeLog("⚔️ Best Underdog Victory:");

    for (const [index, game] of topUnderdogVictories.entries()) {
      const redTeamIGNs = game.redTeam.map((player) => player.ign).join(", ");
      const blueTeamIGNs = game.blueTeam.map((player) => player.ign).join(", ");

      const logMessage = `
Map: ${game.map} Date: ${game.date}
Winning Team: ${game.winner}
Red Team (Avg Elo: ${game.redTeamElo}): ${redTeamIGNs}
Blue Team (Avg Elo: ${game.blueTeamElo}): ${blueTeamIGNs}
Total Elo Difference: ${game.eloDifference}`;
      writeLog(logMessage);
    }
  }

  await identifyUnderdogVictories();

  // Most banned classes in order
  const games = await prisma.game.findMany({
    select: {
      settings: true,
    },
  });
  const bannedClassesCounts = {};
  games.forEach((game) => {
    const bannedClasses = game.settings?.bannedClasses || [];
    bannedClasses.forEach((cls) => {
      if (cls !== "SWAPPER") {
        bannedClassesCounts[cls] = (bannedClassesCounts[cls] || 0) + 1;
      }
    });
  });
  const sortedBannedClasses = Object.entries(bannedClassesCounts).sort(
    (a, b) => b[1] - a[1]
  );
  if (sortedBannedClasses.length > 0) {
    writeLog("🚫 Most Banned Classes (Excluding SWAPPER):");
    sortedBannedClasses.forEach(([cls, count], index) => {
      writeLog(`${index + 1}. ${cls} - ${count} ban(s)`);
    });
  } else {
    writeLog("🚫 No banned classes data available.");
  }
  const mapWinRates = {};

  const players = await prisma.player.findMany({
    select: {
      id: true,
      latestIGN: true,
      games: {
        select: {
          game: {
            select: {
              settings: { select: { map: true } },
              winner: true,
            },
          },
          team: true,
        },
      },
    },
  });

  players.forEach((player) => {
    const winRates = {};
    player.games.forEach((gameParticipation) => {
      const map = gameParticipation.game.settings.map;
      const isWinner = gameParticipation.team === gameParticipation.game.winner;
      if (!winRates[map]) {
        winRates[map] = { wins: 0, total: 0 };
      }
      winRates[map].total += 1;
      if (isWinner) winRates[map].wins += 1;
    });
    mapWinRates[player.latestIGN] = Object.entries(winRates)
      .filter(([_, data]) => data.total > 1)
      .map(([map, data]) => ({
        map,
        winRate: data.total ? data.wins / data.total : 0,
      }));
  });
  const interestingPlayers = Object.entries(mapWinRates)
    .map(([player, maps]) => {
      const highestWinRateMap = maps.reduce(
        (a, b) => (a.winRate > b.winRate ? a : b),
        {}
      );
      const lowestWinRateMap = maps.reduce(
        (a, b) => (a.winRate < b.winRate ? a : b),
        {}
      );
      return {
        player,
        highestWinRateMap,
        lowestWinRateMap,
      };
    })
    .filter(
      (p) =>
        p.highestWinRateMap.winRate > 0.75 &&
        p.lowestWinRateMap.winRate < 0.25 &&
        p.highestWinRateMap.map &&
        p.lowestWinRateMap.map
    )
    .sort((a, b) => b.highestWinRateMap.winRate - a.highestWinRateMap.winRate)
    .slice(0, 3);
  if (interestingPlayers.length > 0) {
    writeLog(
      "🎯 Top 3 Players with most contrasting map win rates (maps played more than once):"
    );
    interestingPlayers.forEach(
      ({ player, highestWinRateMap, lowestWinRateMap }, index) => {
        writeLog(
          `${index + 1}. ${player}: Highest win rate on ${highestWinRateMap.map} (${(
            highestWinRateMap.winRate * 100
          ).toFixed(2)}%) and lowest on ${lowestWinRateMap.map} (${(
            lowestWinRateMap.winRate * 100
          ).toFixed(2)}%)`
        );
      }
    );
  } else {
    writeLog(
      "🎯 No players matched the criteria for high win rates on one map and low on others."
    );
  }

  const calculateGameDurations = async () => {
    const games = await prisma.game.findMany({
      select: {
        id: true,
        startTime: true,
        endTime: true,
        settings: {
          select: {
            map: true,
          },
        },
        gameParticipations: {
          where: { captain: true },
          select: {
            team: true,
            player: {
              select: {
                latestIGN: true,
              },
            },
          },
        },
      },
    });
    const durations = games
      .filter((game) => game.startTime && game.endTime)
      .map((game) => ({
        id: game.id,
        duration: (new Date(game.endTime) - new Date(game.startTime)) / 1000,
        map: game.settings.map,
        captains: game.gameParticipations.map((participation) => ({
          team: participation.team,
          captain: participation.player.latestIGN,
        })),
      }));
    if (durations.length === 0) {
      return {
        mean: 0,
        median: 0,
        shortest: null,
        longest: null,
      };
    }
    const mean =
      durations.reduce((total, game) => total + game.duration, 0) /
      durations.length;
    durations.sort((a, b) => a.duration - b.duration);
    const middleIndex = Math.floor(durations.length / 2);
    const median =
      durations.length % 2 === 0
        ? (durations[middleIndex - 1].duration +
            durations[middleIndex].duration) /
          2
        : durations[middleIndex].duration;
    const shortest = durations[0];
    const longest = durations[durations.length - 1];
    const formatDuration = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    };

    return {
      mean: formatDuration(mean),
      median: formatDuration(median),
      shortest: {
        id: shortest.id,
        duration: formatDuration(shortest.duration),
        map: shortest.map,
        captains: shortest.captains,
      },
      longest: {
        id: longest.id,
        duration: formatDuration(longest.duration),
        map: longest.map,
        captains: longest.captains,
      },
    };
  };

  await (async () => {
    try {
      const { mean, median, shortest, longest } =
        await calculateGameDurations();

      console.log(`📊 Game Duration Statistics:`);
      console.log(`Mean Duration: ${mean}`);
      console.log(`Median Duration: ${median}`);

      if (shortest) {
        console.log(
          `Shortest Game: ${shortest.duration} on map ${shortest.map || "Unknown"}, Game ID: ${shortest.id}`
        );
        shortest.captains.forEach((captain) => {
          console.log(
            `  ${captain.team} Team Captain: ${captain.captain || "Unknown"}`
          );
        });
      }

      if (longest) {
        console.log(
          `Longest Game: ${longest.duration} on map ${longest.map || "Unknown"}, Game ID: ${longest.id}`
        );
        longest.captains.forEach((captain) => {
          console.log(
            `  ${captain.team} Team Captain: ${captain.captain || "Unknown"}`
          );
        });
      }
    } catch (error) {
      console.error("Error calculating game durations:", error);
    }
  })();

  async function findTeamEloExtremes(writeLog) {
    const games = await prisma.game.findMany({
      where: { finished: true },
      include: {
        gameParticipations: {
          include: { player: true },
        },
      },
    });

    const teamElos = games.map((game) => {
      const redTeam = game.gameParticipations.filter((p) => p.team === "RED");
      const blueTeam = game.gameParticipations.filter((p) => p.team === "BLUE");

      const redTeamElo = _.meanBy(redTeam, (p) => p.player.elo);
      const blueTeamElo = _.meanBy(blueTeam, (p) => p.player.elo);

      return {
        gameId: game.id,
        redTeam: redTeam.map((p) => ({
          ign: p.player.latestIGN,
          elo: p.player.elo,
        })),
        blueTeam: blueTeam.map((p) => ({
          ign: p.player.latestIGN,
          elo: p.player.elo,
        })),
        redTeamElo: redTeamElo.toFixed(2),
        blueTeamElo: blueTeamElo.toFixed(2),
      };
    });

    const highestEloTeam = _.maxBy(
      teamElos.flatMap((game) => [
        {
          team: "RED",
          avgElo: parseFloat(game.redTeamElo),
          players: game.redTeam,
          gameId: game.gameId,
        },
        {
          team: "BLUE",
          avgElo: parseFloat(game.blueTeamElo),
          players: game.blueTeam,
          gameId: game.gameId,
        },
      ]),
      (team) => team.avgElo
    );

    const lowestEloTeam = _.minBy(
      teamElos.flatMap((game) => [
        {
          team: "RED",
          avgElo: parseFloat(game.redTeamElo),
          players: game.redTeam,
          gameId: game.gameId,
        },
        {
          team: "BLUE",
          avgElo: parseFloat(game.blueTeamElo),
          players: game.blueTeam,
          gameId: game.gameId,
        },
      ]),
      (team) => team.avgElo
    );

    const logData = (title, team) => {
      if (team) {
        const logContent = [
          title,
          `Game ID: ${team.gameId}`,
          `Team: ${team.team}`,
          `Average Elo: ${team.avgElo}`,
          "Players:",
          ...team.players.map(
            (player) => `  - ${player.ign} (Elo: ${player.elo})`
          ),
        ];
        logContent.forEach((line) => {
          writeLog(line);
        });
      } else {
        console.log(`${title}: No data available.`);
        writeLog(`${title}: No data available.`);
      }
    };
    await logData("🏆 Team with the Highest Average Elo", highestEloTeam);
    await logData("📉 Team with the Lowest Average Elo", lowestEloTeam);
  }
  await findTeamEloExtremes(writeLog);

  async function findBestDuos() {
    const MIN_GAMES_TOGETHER = 10;

    const writeLog = (content) => {
      console.log(content);
      logStream.write(content + "\n");
    };
    const participations = await prisma.gameParticipation.findMany({
      include: {
        player: {
          select: {
            id: true,
            latestIGN: true,
            minecraftAccounts: true,
          },
        },
        game: {
          select: { winner: true },
        },
      },
    });
    const gamesById = _.groupBy(participations, "gameId");
    const duoStats = {};
    for (const [gameId, participations] of Object.entries(gamesById)) {
      const teamGroups = _.groupBy(participations, "team");
      for (const team in teamGroups) {
        const players = teamGroups[team];
        for (let i = 0; i < players.length; i++) {
          for (let j = i + 1; j < players.length; j++) {
            const playerA = players[i];
            const playerB = players[j];
            const duoKey =
              playerA.player.id < playerB.player.id
                ? `${playerA.player.id}-${playerB.player.id}`
                : `${playerB.player.id}-${playerA.player.id}`;
            if (!duoStats[duoKey]) {
              duoStats[duoKey] = {
                playerA: playerA.player,
                playerB: playerB.player,
                wins: 0,
                games: 0,
              };
            }
            duoStats[duoKey].games++;
            if (playerA.game.winner === playerA.team) {
              duoStats[duoKey].wins++;
            }
          }
        }
      }
    }
    const filteredDuos = Object.values(duoStats)
      .filter((duo) => duo.games >= MIN_GAMES_TOGETHER)
      .map((duo) => ({
        ...duo,
        winRate: (duo.wins / duo.games) * 100,
      }))
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 5);
    if (filteredDuos.length > 0) {
      writeLog("🤝 Top Best Duos (Win Rate - Minimum 10 Games Together):");
      filteredDuos.forEach((duo, index) => {
        writeLog(
          `${index + 1}. ${duo.playerA.latestIGN} & ${duo.playerB.latestIGN} - ${duo.winRate.toFixed(
            2
          )}% win rate`
        );
      });
    } else {
      writeLog("🤝 No duos found with at least 5 games together.");
    }
    logStream.end();
  }
  await findBestDuos().catch((e) => {
    console.error("Error finding best duos:", e);
  });

  // Top 5 worst performing duos
  async function findWorstDuos() {
    const MIN_GAMES_TOGETHER = 10;

    const logPath = path.resolve(__dirname, "../logs/worst_duos.txt");
    if (!fs.existsSync(path.dirname(logPath))) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
    }
    const logStream = fs.createWriteStream(logPath, { flags: "w" });

    const writeLog = (content) => {
      console.log(content);
      logStream.write(content + "\n");
    };
    const participations = await prisma.gameParticipation.findMany({
      include: {
        player: {
          select: {
            id: true,
            latestIGN: true,
            minecraftAccounts: true,
          },
        },
        game: {
          select: { winner: true },
        },
      },
    });
    const gamesById = _.groupBy(participations, "gameId");
    const duoStats = {};
    for (const [gameId, participations] of Object.entries(gamesById)) {
      const teamGroups = _.groupBy(participations, "team");
      for (const team in teamGroups) {
        const players = teamGroups[team];
        for (let i = 0; i < players.length; i++) {
          for (let j = i + 1; j < players.length; j++) {
            const playerA = players[i];
            const playerB = players[j];
            const duoKey =
              playerA.player.id < playerB.player.id
                ? `${playerA.player.id}-${playerB.player.id}`
                : `${playerB.player.id}-${playerA.player.id}`;
            if (!duoStats[duoKey]) {
              duoStats[duoKey] = {
                playerA: playerA.player,
                playerB: playerB.player,
                wins: 0,
                games: 0,
              };
            }
            duoStats[duoKey].games++;
            if (playerA.game.winner === playerA.team) {
              duoStats[duoKey].wins++;
            }
          }
        }
      }
    }
    const filteredDuos = Object.values(duoStats)
      .filter((duo) => duo.games >= MIN_GAMES_TOGETHER)
      .map((duo) => ({
        ...duo,
        winRate: (duo.wins / duo.games) * 100,
      }))
      .sort((a, b) => a.winRate - b.winRate)
      .slice(0, 5);
    if (filteredDuos.length > 0) {
      writeLog(
        "😞 Top 5 Worst Duos (Lowest Win Rate - Minimum 10 Games Together):"
      );
      filteredDuos.forEach((duo, index) => {
        writeLog(
          `${index + 1}. ${duo.playerA.latestIGN} & ${duo.playerB.latestIGN} - ${duo.winRate.toFixed(
            2
          )}% win rate`
        );
      });
    } else {
      writeLog("😞 No duos found with at least 10 games together.");
    }
    logStream.end();
  }
  await findWorstDuos().catch((e) => {
    console.error("Error finding worst duos:", e);
  });

  async function getTopWinLossRatios() {
    const logPath = path.resolve(__dirname, "../logs/season_recap.txt");

    if (!fs.existsSync(path.dirname(logPath))) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
    }

    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    const writeLog = (content) => {
      console.log(content);
      logStream.write(content + "\n");
    };

    writeLog(
      "\n🏆 Top 3 Players by Best Win/Loss Ratios (Minimum 10 Games):\n"
    );

    const players = await prisma.player.findMany({
      select: {
        id: true,
        latestIGN: true,
        wins: true,
        losses: true,
        minecraftAccounts: true,
        games: {
          select: { id: true },
        },
      },
    });

    const validRatios = players
      .filter((player) => player.games.length >= 10 && player.losses > 0)
      .map((player) => ({
        id: player.id,
        latestIGN: player.latestIGN,
        winLossRatio: player.wins / player.losses,
        wins: player.wins,
        losses: player.losses,
        minecraftAccounts: player.minecraftAccounts,
      }))
      .sort((a, b) => b.winLossRatio - a.winLossRatio)
      .slice(0, 3);
    if (validRatios.length > 0) {
      validRatios.forEach((player, index) => {
        writeLog(
          `${index + 1}. ${player.latestIGN} (Win/Loss Ratio: ${player.winLossRatio.toFixed(
            2
          )}, Wins: ${player.wins}, Losses: ${player.losses})`
        );
      });
    } else {
      writeLog("No players with valid win/loss data available.");
    }
    logStream.end();
  }
  await getTopWinLossRatios().catch((e) => {
    console.error("Error calculating top win/loss ratios:", e);
  });
  async function getTopWorstWinLossRatios() {
    const writeLog = (content) => {
      console.log(content);
      logStream.write(content + "\n");
    };
    writeLog(
      "\n💔 Top 3 Players by Worst Win/Loss Ratios (Minimum 10 Games):\n"
    );

    const players = await prisma.player.findMany({
      select: {
        id: true,
        latestIGN: true,
        wins: true,
        losses: true,
        minecraftAccounts: true,
        games: {
          select: { id: true },
        },
      },
    });
    const worstRatios = players
      .filter((player) => player.games.length >= 10 && player.losses > 0)
      .map((player) => ({
        id: player.id,
        latestIGN: player.latestIGN,
        winLossRatio: player.wins / player.losses,
        wins: player.wins,
        losses: player.losses,
        minecraftAccounts: player.minecraftAccounts,
      }))
      .sort((a, b) => a.winLossRatio - b.winLossRatio)
      .slice(0, 3);
    if (worstRatios.length > 0) {
      worstRatios.forEach((player, index) => {
        writeLog(
          `${index + 1}. ${player.latestIGN} (Win/Loss Ratio: ${player.winLossRatio.toFixed(
            2
          )}, Wins: ${player.wins}, Losses: ${player.losses})`
        );
      });
    } else {
      writeLog("No players met the minimum game or win/loss criteria.");
    }
    logStream.end();
  }
  await getTopWorstWinLossRatios().catch((e) => {
    console.error("Error calculating worst win/loss ratios:", e);
  });
}

generateSeasonRecap()
  .catch((e) => {
    console.error("Error generating season recap:", e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
