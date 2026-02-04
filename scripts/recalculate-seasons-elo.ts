#!/usr/bin/env ts-node
import { prismaClient } from "../src/database/prismaClient";
import { ConfigManager } from "../src/ConfigManager";
import { Team, type Season, Prisma } from "@prisma/client";
import { EloUtil } from "../src/util/EloUtil";
import type { GameInstance } from "../src/database/GameInstance";
import type { PlayerInstance } from "../src/database/PlayerInstance";
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
  captainBonusCount: number;
  mvpBonusCount: number;
  mvpVoteBonusCount: number;
};

type EloPlayer = Pick<
  PlayerInstance,
  "playerId" | "elo" | "winStreak" | "latestIGN"
>;

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

function buildGameContext(
  teamByPlayerId: Map<string, Team>,
  blueMean: number,
  redMean: number,
  blueExp: number,
  redExp: number
): GameInstance {
  return {
    blueMeanElo: blueMean,
    redMeanElo: redMean,
    blueExpectedScore: blueExp,
    redExpectedScore: redExp,
    getPlayersTeam: (player: PlayerInstance) =>
      teamByPlayerId.get(player.playerId) ?? null,
  } as GameInstance;
}

function calcNewEloForPlayer(
  base: PlayerState,
  playerId: string,
  latestIGN: string | null,
  team: Team,
  winner: Team,
  gameContext: GameInstance,
  isDoubleElo: boolean,
  mvp: boolean,
  captain: boolean,
  votedForAMVP?: boolean | null
): number {
  const config = ConfigManager.getConfig();
  const isWin = team === winner;
  const player: EloPlayer = {
    playerId,
    elo: base.elo,
    winStreak: base.winStreak,
    latestIGN: latestIGN ?? undefined,
  };
  const delta = EloUtil.calculateEloChange(
    gameContext,
    player as PlayerInstance,
    isWin
  );

  let newElo = base.elo;
  if (isWin) newElo += isDoubleElo ? delta * 2 : delta;
  else newElo -= delta;

  if (mvp) {
    newElo += config.mvpBonus;
  }
  if (captain) newElo += config.captainBonus;
  if (votedForAMVP) newElo += 1;

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
          captainBonusCount: 0,
          mvpBonusCount: 0,
          mvpVoteBonusCount: 0,
        });
      }
    }

    const blueElos = g.gameParticipations
      .filter((p) => p.team === Team.BLUE)
      .map((p) => state.get(p.playerId)!.elo);
    const redElos = g.gameParticipations
      .filter((p) => p.team === Team.RED)
      .map((p) => state.get(p.playerId)!.elo);
    const teamByPlayerId = new Map(
      g.gameParticipations.map((p) => [p.playerId, p.team])
    );
    const blueMean = mean(blueElos);
    const redMean = mean(redElos);
    const [blueExp, redExp] = EloUtil.calculateExpectedScore(blueMean, redMean);
    const isDouble = g.doubleElo ?? false;
    const gameContext = buildGameContext(
      teamByPlayerId,
      blueMean,
      redMean,
      blueExp,
      redExp
    );

    const after: { playerId: string; elo: number }[] = [];
    for (const gp of g.gameParticipations) {
      const ps = state.get(gp.playerId)!;
      const newElo = calcNewEloForPlayer(
        ps,
        gp.playerId,
        gp.ignUsed,
        gp.team,
        g.winner,
        gameContext,
        isDouble,
        gp.mvp,
        gp.captain,
        gp.votedForAMVP
      );
      after.push({ playerId: gp.playerId, elo: newElo });
    }

    // commit elo and update streaks/counters based on pre-game streaks
    for (const gp of g.gameParticipations) {
      const ps = state.get(gp.playerId)!;
      const isWin = gp.team === g.winner;
      ps.elo = after.find((a) => a.playerId === gp.playerId)!.elo;
      if (gp.captain) ps.captainBonusCount += 1;
      if (gp.mvp) ps.mvpBonusCount += 1;
      if (gp.votedForAMVP) ps.mvpVoteBonusCount += 1;
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
      `  - ${playerId} { elo:${ps.elo}, W:${ps.wins}, L:${ps.losses}, winStreak:${ps.winStreak}, loseStreak:${ps.loseStreak}, maxWin:${ps.biggestWinStreak}, maxLose:${ps.biggestLosingStreak}, captainBonus:${ps.captainBonusCount}, mvpBonus:${ps.mvpBonusCount}, mvpVoteBonus:${ps.mvpVoteBonusCount} }`
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
