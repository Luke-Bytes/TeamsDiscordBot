/* eslint-disable no-console */
import { PrismaClient, Team } from "@prisma/client";
import { ConfigManager } from "../src/ConfigManager";

const prisma = new PrismaClient();

const MIN_DUO_GAMES = 3;
const MIN_CAPTAIN_GAMES = 3;
const MIN_MVP_GAMES = 3;
const MIN_FAST_LONG_GAMES = 5;
const CLOSE_GAME_ELO_GAP = 25;
const TOP_BANNED_CLASSES = 5;

type LeaderboardRow = { label: string; value: string };

async function getSeasonId(seasonNumberOverride?: number) {
  const seasonNumber =
    seasonNumberOverride ?? ConfigManager.getConfig().season;
  const seasonRecord = await prisma.season.findUnique({
    where: { number: seasonNumber },
  });
  if (!seasonRecord) {
    throw new Error(`Season ${seasonNumber} not found. Create it first.`);
  }
  return { seasonId: seasonRecord.id, seasonNumber: seasonRecord.number };
}

async function getSeasonGames(seasonId: string) {
  return prisma.game.findMany({
    where: { seasonId, finished: true },
    include: { gameParticipations: true },
    orderBy: { startTime: "asc" },
  });
}

async function getSeasonPlayerStats(seasonId: string) {
  return prisma.playerStats.findMany({
    where: { seasonId },
    include: { player: true },
  });
}

async function getSeasonEloHistory(seasonId: string) {
  return prisma.eloHistory.findMany({
    where: { seasonId },
    orderBy: { createdAt: "asc" },
  });
}

function formatLeaderboard(title: string, rows: LeaderboardRow[]) {
  if (!rows.length) return `**${title}:** No data.`;
  const lines = rows.map((row, idx) => ` ${idx + 1}. ${row.label} — ${row.value}`);
  return `**${title}:**\n${lines.join("\n")}`;
}

function formatSingleStat(title: string, value: string | null) {
  return `**${title}:** ${value ?? "No data."}`;
}

function header(seasonNumber: number) {
  return [
    "==============================",
    `**Season ${seasonNumber} Recap**`,
    "==============================",
  ].join("\n");
}

function playerLabel(latestIGN?: string | null, discordSnowflake?: string) {
  return latestIGN ?? `Player ${discordSnowflake ?? "unknown"}`;
}

function percentile(values: number[], pct: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(pct * sorted.length)));
  return sorted[idx];
}

function combinePlayers(a: string, b: string) {
  return [a, b].sort().join("::");
}

async function main() {
  try {
    const seasonArg = process.argv[2];
    const seasonNumberOverride =
      seasonArg && Number.isInteger(Number(seasonArg))
        ? Number(seasonArg)
        : undefined;

    const { seasonId, seasonNumber } = await getSeasonId(
      seasonNumberOverride
    );
    const [games, playerStats, histories] = await Promise.all([
      getSeasonGames(seasonId),
      getSeasonPlayerStats(seasonId),
      getSeasonEloHistory(seasonId),
    ]);

    const playersById = new Map(playerStats.map((ps) => [ps.playerId, ps.player]));
    const historyByGamePlayer = new Map(
      histories.map((h) => [`${h.gameId}:${h.playerId}`, h])
    );

    const preEloByGamePlayer = new Map<string, number>();
    const lastEloByPlayer = new Map<string, number>();
    for (const game of games) {
      for (const gp of game.gameParticipations) {
        const key = `${game.id}:${gp.playerId}`;
        const preElo = lastEloByPlayer.get(gp.playerId) ?? 1000;
        preEloByGamePlayer.set(key, preElo);
        const postHistory = historyByGamePlayer.get(key);
        if (postHistory) {
          lastEloByPlayer.set(gp.playerId, postHistory.elo);
        }
      }
    }

    const sections: string[] = [];
    const topElo = [...playerStats]
      .sort((a, b) => b.elo - a.elo)
      .slice(0, 3)
      .map((ps) => ({
        label: playerLabel(ps.player?.latestIGN, ps.player?.discordSnowflake),
        value: `${ps.elo} Elo`,
      }));
    sections.push(formatLeaderboard("Top Elo", topElo));

    const eloSpreadByPlayer = new Map<string, { min: number; max: number }>();
    for (const ps of playerStats) {
      eloSpreadByPlayer.set(ps.playerId, { min: 1000, max: 1000 });
    }
    for (const h of histories) {
      const spread = eloSpreadByPlayer.get(h.playerId) ?? { min: 1000, max: 1000 };
      spread.min = Math.min(spread.min, h.elo);
      spread.max = Math.max(spread.max, h.elo);
      eloSpreadByPlayer.set(h.playerId, spread);
    }
    const biggestClimb = [...eloSpreadByPlayer.entries()]
      .map(([pid, spread]) => ({
        pid,
        delta: spread.max - spread.min,
      }))
      .sort((a, b) => b.delta - a.delta)[0];
    sections.push(
      formatSingleStat(
        "Biggest Elo climb",
        biggestClimb
          ? `${playerLabel(
              playersById.get(biggestClimb.pid)?.latestIGN,
              playersById.get(biggestClimb.pid)?.discordSnowflake
            )} (+${biggestClimb.delta})`
          : null
      )
    );

    const winStreakTop = playerStats
      .filter((ps) => ps.biggestWinStreak > 0)
      .sort((a, b) => b.biggestWinStreak - a.biggestWinStreak)
      .slice(0, 3)
      .map((ps) => ({
        label: playerLabel(
          ps.player?.latestIGN,
          ps.player?.discordSnowflake
        ),
        value: `${ps.biggestWinStreak}`,
      }));
    const loseStreakTop = playerStats
      .filter((ps) => ps.biggestLosingStreak > 0)
      .sort((a, b) => b.biggestLosingStreak - a.biggestLosingStreak)
      .slice(0, 3)
      .map((ps) => ({
        label: playerLabel(
          ps.player?.latestIGN,
          ps.player?.discordSnowflake
        ),
        value: `${ps.biggestLosingStreak}`,
      }));
    sections.push(formatLeaderboard("Longest win streaks", winStreakTop));
    sections.push(formatLeaderboard("Longest losing streaks", loseStreakTop));

    const mvpCounts = new Map<string, { mvps: number; games: number }>();
    const captainStats = new Map<
      string,
      { caps: number; capWins: number; longestCapWinStreak: number }
    >();
    const capStreakTrack = new Map<string, number>();
    const supportCounts = {
      host: new Map<string, number>(),
      organiser: new Map<string, number>(),
    };
    const mapCounts = new Map<string, number>();
    const bannedCounts = new Map<string, number>();
    const duoSame = new Map<
      string,
      { a: string; b: string; games: number; wins: number }
    >();
    const duoOpp = new Map<
      string,
      { a: string; b: string; meetings: number; winsA: number; winsB: number }
    >();
    const clutchWins = new Map<string, number>();
    const fastLongStats = new Map<
      string,
      { fastGames: number; fastWins: number; longGames: number; longWins: number }
    >();

    const gameDurations = games.map(
      (g) => (new Date(g.endTime).getTime() - new Date(g.startTime).getTime()) / 60000
    );
    const fastCutoff = percentile(gameDurations, 0.25);
    const longCutoff = percentile(gameDurations, 0.75);

    for (const game of games) {
      const durationMinutes =
        (new Date(game.endTime).getTime() - new Date(game.startTime).getTime()) / 60000;
      const isFast = durationMinutes <= fastCutoff;
      const isLong = durationMinutes >= longCutoff;

      const red = game.gameParticipations.filter((gp) => gp.team === Team.RED);
      const blue = game.gameParticipations.filter((gp) => gp.team === Team.BLUE);

      if (game.settings?.map) {
        mapCounts.set(game.settings.map, (mapCounts.get(game.settings.map) ?? 0) + 1);
      }

      const banned = game.settings?.bannedClasses ?? [];
      for (const cls of banned) {
        bannedCounts.set(cls, (bannedCounts.get(cls) ?? 0) + 1);
      }
      const teamBans = game.settings?.bannedClassesByTeam as
        | { RED?: string[]; BLUE?: string[] }
        | undefined;
      if (teamBans?.RED) {
        for (const cls of teamBans.RED) {
          bannedCounts.set(cls, (bannedCounts.get(cls) ?? 0) + 1);
        }
      }
      if (teamBans?.BLUE) {
        for (const cls of teamBans.BLUE) {
          bannedCounts.set(cls, (bannedCounts.get(cls) ?? 0) + 1);
        }
      }
      if (game.host) {
        supportCounts.host.set(game.host, (supportCounts.host.get(game.host) ?? 0) + 1);
      }
      if (game.organiser) {
        supportCounts.organiser.set(
          game.organiser,
          (supportCounts.organiser.get(game.organiser) ?? 0) + 1
        );
      }

      const teams = [red, blue];
      for (const team of teams) {
        for (let i = 0; i < team.length; i += 1) {
          for (let j = i + 1; j < team.length; j += 1) {
            const a = team[i];
            const b = team[j];
            const key = combinePlayers(a.playerId, b.playerId);
            const record = duoSame.get(key) ?? { a: a.playerId, b: b.playerId, games: 0, wins: 0 };
            record.games += 1;
            if (game.winner && game.winner === a.team) record.wins += 1;
            duoSame.set(key, record);
          }
        }
      }

      for (const a of red) {
        for (const b of blue) {
          const key = combinePlayers(a.playerId, b.playerId);
          const record = duoOpp.get(key) ?? {
            a: a.playerId,
            b: b.playerId,
            meetings: 0,
            winsA: 0,
            winsB: 0,
          };
          record.meetings += 1;
          if (game.winner === Team.RED) record.winsA += 1;
          if (game.winner === Team.BLUE) record.winsB += 1;
          duoOpp.set(key, record);
        }
      }

      const redPreMean =
        red.reduce(
          (sum, gp) => sum + (preEloByGamePlayer.get(`${game.id}:${gp.playerId}`) ?? 1000),
          0
        ) / Math.max(1, red.length);
      const bluePreMean =
        blue.reduce(
          (sum, gp) => sum + (preEloByGamePlayer.get(`${game.id}:${gp.playerId}`) ?? 1000),
          0
        ) / Math.max(1, blue.length);
      const closeGame = Math.abs(redPreMean - bluePreMean) < CLOSE_GAME_ELO_GAP;

      for (const gp of game.gameParticipations) {
        const record = mvpCounts.get(gp.playerId) ?? { mvps: 0, games: 0 };
        record.games += 1;
        if (gp.mvp) record.mvps += 1;
        mvpCounts.set(gp.playerId, record);

        const capRecord =
          captainStats.get(gp.playerId) ??
          { caps: 0, capWins: 0, longestCapWinStreak: 0 };
        if (gp.captain) {
          capRecord.caps += 1;
          if (game.winner && game.winner === gp.team) {
            capRecord.capWins += 1;
            const streak = (capStreakTrack.get(gp.playerId) ?? 0) + 1;
            capStreakTrack.set(gp.playerId, streak);
            capRecord.longestCapWinStreak = Math.max(capRecord.longestCapWinStreak, streak);
          } else {
            capStreakTrack.set(gp.playerId, 0);
          }
          captainStats.set(gp.playerId, capRecord);
        }

        if (closeGame && game.winner && game.winner === gp.team) {
          clutchWins.set(gp.playerId, (clutchWins.get(gp.playerId) ?? 0) + 1);
        }

        if (isFast || isLong) {
          const fastLong = fastLongStats.get(gp.playerId) ?? {
            fastGames: 0,
            fastWins: 0,
            longGames: 0,
            longWins: 0,
          };
          if (isFast) {
            fastLong.fastGames += 1;
            if (game.winner && game.winner === gp.team) fastLong.fastWins += 1;
          }
          if (isLong) {
            fastLong.longGames += 1;
            if (game.winner && game.winner === gp.team) fastLong.longWins += 1;
          }
          fastLongStats.set(gp.playerId, fastLong);
        }
      }
    }

    const mvpTop = [...mvpCounts.entries()]
      .sort((a, b) => b[1].mvps - a[1].mvps)
      .slice(0, 3)
      .map(([pid, data]) => ({
        label: playerLabel(
          playersById.get(pid)?.latestIGN,
          playersById.get(pid)?.discordSnowflake
        ),
        value: `${data.mvps} MVPs`,
      }));
    sections.push(formatLeaderboard("MVP leaderboard", mvpTop));

    const mvpRate = [...mvpCounts.entries()]
      .filter(([, data]) => data.games >= MIN_MVP_GAMES && data.mvps > 0)
      .map(([pid, data]) => ({
        pid,
        rate: data.mvps / data.games,
      }))
      .sort((a, b) => b.rate - a.rate)[0];
    sections.push(
      formatSingleStat(
        "Highest MVP rate (min 3 games)",
        mvpRate
          ? `${playerLabel(
              playersById.get(mvpRate.pid)?.latestIGN,
              playersById.get(mvpRate.pid)?.discordSnowflake
            )} (${(mvpRate.rate * 100).toFixed(1)}%)`
          : null
      )
    );

    const mostCaps = [...captainStats.entries()]
      .sort((a, b) => b[1].caps - a[1].caps)
      .slice(0, 3)
      .map(([pid, data]) => ({
        label: playerLabel(
          playersById.get(pid)?.latestIGN,
          playersById.get(pid)?.discordSnowflake
        ),
        value: `${data.caps} caps`,
      }));
    sections.push(formatLeaderboard("Most captain appearances", mostCaps));

    const bestCapWinRate = [...captainStats.entries()]
      .filter(([, data]) => data.caps >= MIN_CAPTAIN_GAMES && data.capWins > 0)
      .map(([pid, data]) => ({
        pid,
        rate: data.capWins / data.caps,
        caps: data.caps,
      }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 3)
      .map((entry) => ({
        label: playerLabel(
          playersById.get(entry.pid)?.latestIGN,
          playersById.get(entry.pid)?.discordSnowflake
        ),
        value: `${(entry.rate * 100).toFixed(1)}% over ${entry.caps} caps`,
      }));
    sections.push(formatLeaderboard("Best captain win rate (min 3 caps)", bestCapWinRate));

    const longestCapStreak = [...captainStats.entries()]
      .sort((a, b) => b[1].longestCapWinStreak - a[1].longestCapWinStreak)
      .slice(0, 3)
      .map(([pid, data]) => ({
        label: playerLabel(
          playersById.get(pid)?.latestIGN,
          playersById.get(pid)?.discordSnowflake
        ),
        value: `${data.longestCapWinStreak}`,
      }));
    sections.push(formatLeaderboard("Longest captain win streaks", longestCapStreak));

    const topHosts = [...supportCounts.host.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 1)
      .map(([name, count]) => ({ label: name, value: `${count} games` }));
    sections.push(formatLeaderboard("Most games hosted", topHosts));

    const topOrganisers = [...supportCounts.organiser.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 1)
      .map(([name, count]) => ({ label: name, value: `${count} games` }));
    sections.push(formatLeaderboard("Most games organised", topOrganisers));

    const mapUsage = [...mapCounts.entries()].sort((a, b) => b[1] - a[1]);
    const mostMaps = mapUsage.slice(0, 3).map(([map, count]) => ({
      label: map,
      value: `${count} plays`,
    }));
    const leastMap = mapUsage.at(-1);
    sections.push(formatLeaderboard("Most played maps", mostMaps));
    sections.push(
      formatSingleStat(
        "Least played map",
        leastMap ? `${leastMap[0]} (${leastMap[1]} plays)` : null
      )
    );

    const topBans = [...bannedCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_BANNED_CLASSES)
      .map(([cls, count]) => ({ label: cls, value: `${count} bans` }));
    sections.push(formatLeaderboard(`Most banned classes (top ${TOP_BANNED_CLASSES})`, topBans));

    const duoDominance = [...duoSame.values()]
      .filter((d) => d.games >= MIN_DUO_GAMES)
      .map((d) => ({
        ...d,
        rate: d.wins / d.games,
      }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 3)
      .map((d) => ({
        label: `${playerLabel(
          playersById.get(d.a)?.latestIGN,
          playersById.get(d.a)?.discordSnowflake
        )} + ${playerLabel(
          playersById.get(d.b)?.latestIGN,
          playersById.get(d.b)?.discordSnowflake
        )}`,
        value: `${(d.rate * 100).toFixed(1)}% win rate (${d.wins}/${d.games})`,
      }));
    sections.push(formatLeaderboard("Duo dominance", duoDominance));

    const duoDoom = [...duoSame.values()]
      .filter((d) => d.games >= MIN_DUO_GAMES)
      .map((d) => ({
        ...d,
        rate: d.wins / d.games,
      }))
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 3)
      .map((d) => ({
        label: `${playerLabel(
          playersById.get(d.a)?.latestIGN,
          playersById.get(d.a)?.discordSnowflake
        )} + ${playerLabel(
          playersById.get(d.b)?.latestIGN,
          playersById.get(d.b)?.discordSnowflake
        )}`,
        value: `${(d.rate * 100).toFixed(1)}% win rate (${d.wins}/${d.games})`,
      }));
    sections.push(formatLeaderboard("Duo doom", duoDoom));

    const crossfire = [...duoOpp.values()]
      .sort((a, b) => b.meetings - a.meetings)
      .slice(0, 3)
      .map((pair) => {
        const leader =
          pair.winsA === pair.winsB
            ? "tied"
            : pair.winsA > pair.winsB
            ? playerLabel(
                playersById.get(pair.a)?.latestIGN,
                playersById.get(pair.a)?.discordSnowflake
              )
            : playerLabel(
                playersById.get(pair.b)?.latestIGN,
                playersById.get(pair.b)?.discordSnowflake
              );
        return {
          label: `${playerLabel(
            playersById.get(pair.a)?.latestIGN,
            playersById.get(pair.a)?.discordSnowflake
          )} vs ${playerLabel(
            playersById.get(pair.b)?.latestIGN,
            playersById.get(pair.b)?.discordSnowflake
          )}`,
          value: `${pair.meetings} meetings — leader: ${leader}`,
        };
      });
    sections.push(formatLeaderboard("Crossfire (most head-to-heads)", crossfire));

    const clutch = [...clutchWins.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([pid, wins]) => ({
        label: playerLabel(
          playersById.get(pid)?.latestIGN,
          playersById.get(pid)?.discordSnowflake
        ),
        value: `${wins} close-game wins`,
      }));
    sections.push(formatLeaderboard("Clutch closers (<25 Elo gap)", clutch));

    const fastWinRates = [...fastLongStats.entries()]
      .filter(([, data]) => data.fastGames >= MIN_FAST_LONG_GAMES)
      .map(([pid, data]) => ({
        pid,
        rate: data.fastWins / data.fastGames,
        games: data.fastGames,
      }))
      .sort((a, b) => b.rate - a.rate)[0];
    sections.push(
      formatSingleStat(
        `Fast game specialist (min ${MIN_FAST_LONG_GAMES} fast games)`,
        fastWinRates
          ? `${playerLabel(
              playersById.get(fastWinRates.pid)?.latestIGN,
              playersById.get(fastWinRates.pid)?.discordSnowflake
            )} (${(fastWinRates.rate * 100).toFixed(1)}% over ${
              fastWinRates.games
            } fast games)`
          : null
      )
    );

    const longWinRates = [...fastLongStats.entries()]
      .filter(([, data]) => data.longGames >= MIN_FAST_LONG_GAMES)
      .map(([pid, data]) => ({
        pid,
        rate: data.longWins / data.longGames,
        games: data.longGames,
      }))
      .sort((a, b) => b.rate - a.rate)[0];
    sections.push(
      formatSingleStat(
        `Marathoner (min ${MIN_FAST_LONG_GAMES} long games)`,
        longWinRates
          ? `${playerLabel(
              playersById.get(longWinRates.pid)?.latestIGN,
              playersById.get(longWinRates.pid)?.discordSnowflake
            )} (${(longWinRates.rate * 100).toFixed(1)}% over ${
              longWinRates.games
            } long games)`
          : null
      )
    );

    const announcement = `${header(seasonNumber)}\n\n${sections.join("\n\n")}`;
    console.log(announcement);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
