#!/usr/bin/env ts-node
import { prismaClient } from "../src/database/prismaClient";
import { ConfigManager } from "../src/ConfigManager";
import { Team, Prisma, type Season } from "@prisma/client";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type GameWithParts = Prisma.GameGetPayload<{
  include: { gameParticipations: { include: { player: true } }; season: true };
}>;

const rl = createInterface({ input, output });

async function resolveSeason(): Promise<Season> {
  const cfg = ConfigManager?.getConfig?.();
  if (cfg?.season) {
    const s = await prismaClient.season.findUnique({
      where: { number: cfg.season },
    });
    if (s) return s;
  }
  const active = await prismaClient.season.findFirst({
    where: { isActive: true },
    orderBy: { number: "desc" },
  });
  if (active) return active;
  const latest = await prismaClient.season.findFirst({
    orderBy: { number: "desc" },
  });
  if (!latest) throw new Error("No seasons found.");
  return latest;
}

async function getLastGame(
  seasonId: string,
  finishedOnly = true
): Promise<GameWithParts | null> {
  return prismaClient.game.findFirst({
    where: { seasonId, ...(finishedOnly ? { finished: true } : {}) },
    orderBy: [{ endTime: "desc" }, { startTime: "desc" }],
    include: {
      gameParticipations: { include: { player: true } },
      season: true,
    },
  });
}

function fmt(dt?: Date) {
  return dt ? new Date(dt).toLocaleString() : "n/a";
}

function partitionTeams(g: GameWithParts) {
  const red = g.gameParticipations.filter((p) => p.team === Team.RED);
  const blue = g.gameParticipations.filter((p) => p.team === Team.BLUE);
  return { red, blue };
}

async function recomputeStatsForPlayersExcludingGame(
  seasonId: string,
  gameId: string,
  playerIds: string[]
) {
  const updates: {
    playerId: string;
    wins: number;
    losses: number;
    winStreak: number;
    loseStreak: number;
    biggestWinStreak: number;
    biggestLosingStreak: number;
    elo: number;
  }[] = [];

  for (const playerId of playerIds) {
    const parts = await prismaClient.gameParticipation.findMany({
      where: { playerId, seasonId, gameId: { not: gameId } },
      include: { game: true },
    });
    parts.sort(
      (a, b) =>
        new Date(a.game.endTime).getTime() - new Date(b.game.endTime).getTime()
    );

    let wins = 0,
      losses = 0,
      curWin = 0,
      curLose = 0,
      bestWin = 0,
      bestLose = 0;
    for (const gp of parts) {
      const w = gp.game.winner;
      if (!w) continue;
      if (w === gp.team) {
        wins++;
        curWin++;
        curLose = 0;
        if (curWin > bestWin) bestWin = curWin;
      } else {
        losses++;
        curLose++;
        curWin = 0;
        if (curLose > bestLose) bestLose = curLose;
      }
    }

    const lastElo = await prismaClient.eloHistory.findFirst({
      where: { playerId, seasonId, gameId: { not: gameId } },
      orderBy: { createdAt: "desc" },
      select: { elo: true },
    });

    updates.push({
      playerId,
      wins,
      losses,
      winStreak: curWin,
      loseStreak: curLose,
      biggestWinStreak: bestWin,
      biggestLosingStreak: bestLose,
      elo: lastElo?.elo ?? 1000,
    });
  }
  return updates;
}

async function main() {
  const season = await resolveSeason();
  console.log(
    `[INFO] Resolved season #${season.number} id=${season.id} isActive=${season.isActive}`
  );

  const finishedOnly = true;
  const game = await getLastGame(season.id, finishedOnly);
  if (!game) {
    console.log(
      `No ${finishedOnly ? "finished " : ""}games found for season #${season.number}.`
    );
    process.exit(0);
  }

  const { red, blue } = partitionTeams(game);
  console.log("\n[SUMMARY] Most recent saved game (candidate for revert):");
  console.log(
    [
      `  Season: ${season.number}${season.isActive ? " (active)" : ""}`,
      `  Game ID: ${game.id}`,
      `  Start: ${fmt(game.startTime)}  End: ${fmt(game.endTime)}`,
      `  Winner: ${game.winner ?? "n/a"}  Type: ${game.type ?? "n/a"}`,
      `  Map: ${game.settings?.map ?? "n/a"}  Minerushing: ${game.settings?.minerushing ? "on" : "off"}`,
      `  Organiser: ${game.organiser ?? "n/a"}  Host: ${game.host ?? "n/a"}`,
      `  RED (${red.length}): ${red.map((p) => p.ignUsed).join(", ") || "-"}`,
      `  BLUE (${blue.length}): ${blue.map((p) => p.ignUsed).join(", ") || "-"}`,
    ].join("\n")
  );

  const confirm = (
    await rl.question(
      '\nType "yes" to revert this game (anything else aborts): '
    )
  )
    .trim()
    .toLowerCase();
  if (confirm !== "yes") {
    console.log("[ABORT] User did not confirm. No changes made.");
    await rl.close();
    await prismaClient.$disconnect();
    process.exit(0);
  }

  const affectedPlayerIds = Array.from(
    new Set(game.gameParticipations.map((p) => p.playerId))
  );
  const byPlayer = new Map<string, { igns: Set<string>; teams: Set<string> }>();
  for (const gp of game.gameParticipations) {
    const v = byPlayer.get(gp.playerId) ?? {
      igns: new Set<string>(),
      teams: new Set<string>(),
    };
    v.igns.add(gp.ignUsed);
    v.teams.add(gp.team);
    byPlayer.set(gp.playerId, v);
  }
  const label = (playerId: string) => {
    const meta = byPlayer.get(playerId);
    const igns = meta ? [...meta.igns].join(", ") : "-";
    const teams = meta ? [...meta.teams].join(", ") : "-";
    return `${playerId} [IGNs: ${igns}; Teams: ${teams}]`;
  };

  const recalculated = await recomputeStatsForPlayersExcludingGame(
    season.id,
    game.id,
    affectedPlayerIds
  );
  console.log(`\n[PLAN] Reverting game ${game.id} (season #${season.number})`);
  console.log(`[PLAN] Affected players (${affectedPlayerIds.length}):`);
  for (const u of recalculated) {
    console.log(
      `  - ${label(u.playerId)} -> { elo:${u.elo}, W:${u.wins}, L:${u.losses}, winStreak:${u.winStreak}, loseStreak:${u.loseStreak}, maxWin:${u.biggestWinStreak}, maxLose:${u.biggestLosingStreak} }`
    );
  }

  await prismaClient.$transaction(async (tx) => {
    console.log(`\n[DELETE] EloHistory for game ${game.id}...`);
    const preElo = await tx.eloHistory.count({ where: { gameId: game.id } });
    console.log(`  Rows to delete: ${preElo}`);
    const delElo = await tx.eloHistory.deleteMany({
      where: { gameId: game.id },
    });
    console.log(`  -> Deleted: ${delElo.count}`);

    console.log(`\n[DELETE] GameParticipations for game ${game.id}...`);
    console.log(`  Participants:`);
    for (const gp of game.gameParticipations) {
      console.log(
        `   - gpId:${gp.id} player:${gp.playerId} ign:${gp.ignUsed} team:${gp.team}`
      );
    }
    const preGP = await tx.gameParticipation.count({
      where: { gameId: game.id },
    });
    console.log(`  Rows to delete: ${preGP}`);
    const delGP = await tx.gameParticipation.deleteMany({
      where: { gameId: game.id },
    });
    console.log(`  -> Deleted: ${delGP.count}`);

    console.log(`\n[DELETE] Game record ${game.id}...`);
    await tx.game.delete({ where: { id: game.id } });
    console.log(`  -> Deleted game ${game.id}`);

    console.log(`\n[UPSERT] PlayerStats adjustments:`);
    for (const u of recalculated) {
      const remaining = await tx.gameParticipation.count({
        where: { playerId: u.playerId, seasonId: season.id },
      });
      const prev = await tx.playerStats.findUnique({
        where: {
          playerId_seasonId: { playerId: u.playerId, seasonId: season.id },
        },
      });

      if (remaining === 0) {
        if (prev) {
          console.log(
            `  - ${label(u.playerId)}: no remaining games -> DELETE PlayerStats { elo:${prev.elo}, W:${prev.wins}, L:${prev.losses}, winStreak:${prev.winStreak}, loseStreak:${prev.loseStreak}, maxWin:${prev.biggestWinStreak}, maxLose:${prev.biggestLosingStreak} }`
          );
          await tx.playerStats.deleteMany({
            where: { playerId: u.playerId, seasonId: season.id },
          });
        } else {
          console.log(
            `  - ${label(u.playerId)}: no remaining games -> nothing to delete (no PlayerStats row)`
          );
        }
        continue;
      }

      console.log(`  - ${label(u.playerId)}: remainingGames=${remaining}`);
      if (prev)
        console.log(
          `      BEFORE { elo:${prev.elo}, W:${prev.wins}, L:${prev.losses}, winStreak:${prev.winStreak}, loseStreak:${prev.loseStreak}, maxWin:${prev.biggestWinStreak}, maxLose:${prev.biggestLosingStreak} }`
        );
      else console.log(`      BEFORE { none } -> will CREATE`);

      await tx.playerStats.upsert({
        where: {
          playerId_seasonId: { playerId: u.playerId, seasonId: season.id },
        },
        update: {
          elo: u.elo,
          wins: u.wins,
          losses: u.losses,
          winStreak: u.winStreak,
          loseStreak: u.loseStreak,
          biggestWinStreak: u.biggestWinStreak,
          biggestLosingStreak: u.biggestLosingStreak,
        },
        create: {
          playerId: u.playerId,
          seasonId: season.id,
          elo: u.elo,
          wins: u.wins,
          losses: u.losses,
          winStreak: u.winStreak,
          loseStreak: u.loseStreak,
          biggestWinStreak: u.biggestWinStreak,
          biggestLosingStreak: u.biggestLosingStreak,
        },
      });

      console.log(
        `      AFTER  { elo:${u.elo}, W:${u.wins}, L:${u.losses}, winStreak:${u.winStreak}, loseStreak:${u.loseStreak}, maxWin:${u.biggestWinStreak}, maxLose:${u.biggestLosingStreak} }`
      );
    }
  });

  console.log(
    `\n[OK] Reverted game ${game.id}. Deleted EloHistory, GameParticipation and Game records.`
  );
  console.log(
    `[OK] PlayerStats updated/removed for ${recalculated.length} player(s).`
  );
  await rl.close();
  await prismaClient.$disconnect();
}

main().catch(async (e) => {
  console.error("[ERROR]", e);
  try {
    await rl.close();
  } catch (closeErr) {
    console.warn("[WARN] rl.close() failed:", closeErr);
  }
  try {
    await prismaClient.$disconnect();
  } catch (discErr) {
    console.warn("[WARN] prismaClient.$disconnect() failed:", discErr);
  }
  process.exit(1);
});
