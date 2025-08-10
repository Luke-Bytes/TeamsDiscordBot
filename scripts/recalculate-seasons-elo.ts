#!/usr/bin/env ts-node
import { prismaClient } from "../src/database/prismaClient";
import { ConfigManager } from "../src/ConfigManager";
import { Team, type Season, Prisma } from "@prisma/client";
import { EloUtil } from "../src/util/EloUtil";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type GameWithParts = Prisma.GameGetPayload<{
  include: { gameParticipations: true; season: true };
}>;

type PlayerState = {
  elo: number;
  wins: number;
  losses: number;
  winStreak: number;
  loseStreak: number;
  biggestWinStreak: number;
  biggestLosingStreak: number;
};

const rl = createInterface({ input, output });
const fmt = (dt?: Date) => (dt ? new Date(dt).toLocaleString() : "n/a");

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

async function getFinishedGames(seasonId: string): Promise<GameWithParts[]> {
  return prismaClient.game.findMany({
    where: { seasonId, finished: true },
    orderBy: [{ endTime: "asc" }, { startTime: "asc" }],
    include: { gameParticipations: true, season: true },
  });
}

function mean(arr: number[]) {
  return arr.length
    ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
    : 1000;
}

function calcNewEloForPlayer(
  base: PlayerState,
  team: Team,
  winner: Team,
  blueMean: number,
  redMean: number,
  blueExp: number,
  redExp: number,
  isDoubleElo: boolean,
  mvp: boolean,
  captain: boolean
): number {
  const config = ConfigManager.getConfig();
  const expected = team === Team.BLUE ? blueExp : redExp;
  const isWin = team === winner;

  const k = EloUtil.getKFactor(base.elo);
  let delta = Math.abs(k * ((isWin ? 1 : 0) - expected));

  if (isWin && base.winStreak >= EloUtil.WIN_STREAK_MIN) {
    const ws = Math.min(base.winStreak, EloUtil.WIN_STREAK_MAX_THRESHOLD);
    const bonus =
      ws > EloUtil.WIN_STREAK_MEDIUM_THRESHOLD
        ? EloUtil.BONUS_MULTIPLIER_MEDIUM +
          (ws - EloUtil.WIN_STREAK_MEDIUM_THRESHOLD) *
            EloUtil.BONUS_MULTIPLIER_INCREMENT_HIGH
        : 1 +
          (ws - (EloUtil.WIN_STREAK_MIN - 1)) *
            EloUtil.BONUS_MULTIPLIER_INCREMENT_LOW;
    delta = delta * bonus;
  }

  const meanDiff = Math.abs(blueMean - redMean);
  if (meanDiff < 25) {
    const adj = (0.5 - expected) * config.underdogMultiplier;
    delta = isWin ? delta + delta * adj : delta + delta * -adj;
  }

  delta = Number(delta.toFixed(1));

  let newElo = base.elo;
  if (isWin) newElo += isDoubleElo ? delta * 2 : delta;
  else newElo -= delta;

  if (mvp) {
    let m = config.mvpBonus;
    if (isDoubleElo) m *= 2;
    newElo += m;
  }
  if (captain) newElo += config.captainBonus;

  return Math.trunc(newElo);
}

async function main() {
  const season = await resolveSeason();
  const games = await getFinishedGames(season.id);
  if (!games.length) {
    console.log(`No finished games found for season #${season.number}.`);
    process.exit(0);
  }

  console.log(
    `[INFO] Season #${season.number} (${season.id}) | Games: ${games.length}`
  );

  const state = new Map<string, PlayerState>();
  const perGameAfter = new Map<string, { playerId: string; elo: number }[]>();

  for (const g of games) {
    if (!g.winner) {
      console.warn(`[SKIP] Game ${g.id} has no winner set. Skipping.`);
      continue;
    }

    for (const gp of g.gameParticipations) {
      if (!state.has(gp.playerId)) {
        state.set(gp.playerId, {
          elo: 1000,
          wins: 0,
          losses: 0,
          winStreak: 0,
          loseStreak: 0,
          biggestWinStreak: 0,
          biggestLosingStreak: 0,
        });
      }
    }

    const blueElos = g.gameParticipations
      .filter((p) => p.team === Team.BLUE)
      .map((p) => state.get(p.playerId)!.elo);
    const redElos = g.gameParticipations
      .filter((p) => p.team === Team.RED)
      .map((p) => state.get(p.playerId)!.elo);
    const blueMean = mean(blueElos);
    const redMean = mean(redElos);
    const [blueExp, redExp] = EloUtil.calculateExpectedScore(blueMean, redMean);
    const isDouble = g.doubleElo ?? false;

    const after: { playerId: string; elo: number }[] = [];
    for (const gp of g.gameParticipations) {
      const ps = state.get(gp.playerId)!;
      const newElo = calcNewEloForPlayer(
        ps,
        gp.team,
        g.winner,
        blueMean,
        redMean,
        blueExp,
        redExp,
        isDouble,
        gp.mvp,
        gp.captain
      );
      after.push({ playerId: gp.playerId, elo: newElo });
    }

    // commit elo and update streaks/counters based on pre-game streaks
    for (const gp of g.gameParticipations) {
      const ps = state.get(gp.playerId)!;
      const isWin = gp.team === g.winner;
      ps.elo = after.find((a) => a.playerId === gp.playerId)!.elo;
      if (isWin) {
        ps.wins += 1;
        ps.winStreak += 1;
        ps.loseStreak = 0;
        if (ps.winStreak > ps.biggestWinStreak)
          ps.biggestWinStreak = ps.winStreak;
      } else {
        ps.losses += 1;
        ps.loseStreak += 1;
        ps.winStreak = 0;
        if (ps.loseStreak > ps.biggestLosingStreak)
          ps.biggestLosingStreak = ps.loseStreak;
      }
    }

    perGameAfter.set(g.id, after);
    console.log(
      `[PLAN] ${fmt(g.startTime)} -> ${fmt(g.endTime)} | game=${g.id} winner=${g.winner} doubleElo=${isDouble}`
    );
    for (const a of after)
      console.log(`  - player:${a.playerId} eloAfter:${a.elo}`);
  }

  console.log("\n[PLAN] Final PlayerStats:");
  for (const [playerId, ps] of state) {
    console.log(
      `  - ${playerId} { elo:${ps.elo}, W:${ps.wins}, L:${ps.losses}, winStreak:${ps.winStreak}, loseStreak:${ps.loseStreak}, maxWin:${ps.biggestWinStreak}, maxLose:${ps.biggestLosingStreak} }`
    );
  }

  const confirm = (
    await rl.question(
      '\nType "yes" to APPLY recompute (update/create EloHistory and PlayerStats): '
    )
  )
    .trim()
    .toLowerCase();
  if (confirm !== "yes") {
    console.log("Aborted. No changes made.");
    await rl.close();
    await prismaClient.$disconnect();
    process.exit(0);
  }

  for (const g of games) {
    const after = perGameAfter.get(g.id);
    if (!after) continue;
    await prismaClient.$transaction(async (tx) => {
      for (const a of after) {
        const existing = await tx.eloHistory.findFirst({
          where: { playerId: a.playerId, gameId: g.id, seasonId: g.seasonId },
          select: { id: true },
        });
        if (existing) {
          await tx.eloHistory.update({
            where: { id: existing.id },
            data: { elo: a.elo },
          });
          console.log(
            `[WRITE] EloHistory.update id=${existing.id} player=${a.playerId} game=${g.id} -> elo=${a.elo}`
          );
        } else {
          const created = await tx.eloHistory.create({
            data: {
              playerId: a.playerId,
              gameId: g.id,
              seasonId: g.seasonId,
              elo: a.elo,
            },
          });
          console.log(
            `[WRITE] EloHistory.create id=${created.id} player=${a.playerId} game=${g.id} -> elo=${a.elo}`
          );
        }
      }
    });
  }

  await prismaClient.$transaction(async (tx) => {
    for (const [playerId, ps] of state) {
      await tx.playerStats.upsert({
        where: { playerId_seasonId: { playerId, seasonId: season.id } },
        update: {
          elo: ps.elo,
          wins: ps.wins,
          losses: ps.losses,
          winStreak: ps.winStreak,
          loseStreak: ps.loseStreak,
          biggestWinStreak: ps.biggestWinStreak,
          biggestLosingStreak: ps.biggestLosingStreak,
        },
        create: {
          playerId,
          seasonId: season.id,
          elo: ps.elo,
          wins: ps.wins,
          losses: ps.losses,
          winStreak: ps.winStreak,
          loseStreak: ps.loseStreak,
          biggestWinStreak: ps.biggestWinStreak,
          biggestLosingStreak: ps.biggestLosingStreak,
        },
      });
      console.log(
        `[WRITE] PlayerStats.upsert player=${playerId} season=${season.id} -> elo=${ps.elo} W=${ps.wins} L=${ps.losses} ws=${ps.winStreak}/${ps.biggestWinStreak} ls=${ps.loseStreak}/${ps.biggestLosingStreak}`
      );
    }
  });

  console.log(
    "\n[OK] Recomputed EloHistory for all finished games and PlayerStats for the season."
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
