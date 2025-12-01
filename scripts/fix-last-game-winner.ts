#!/usr/bin/env ts-node
import { prismaClient } from "../src/database/prismaClient";
import { ConfigManager } from "../src/ConfigManager";
import { Team, type Season, Prisma } from "@prisma/client";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { EloUtil } from "../src/util/EloUtil";

// npx tsx scripts/fix-last-game-winner.ts
type GameWithParts = Prisma.GameGetPayload<{
  include: { gameParticipations: { include: { player: true } }; season: true };
}>;

const rl = createInterface({ input, output });

const fmt = (dt?: Date) => (dt ? new Date(dt).toLocaleString() : "n/a");
const ask = async (q: string) => (await rl.question(q)).trim();

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

async function getLastFinishedGame(
  seasonId: string
): Promise<GameWithParts | null> {
  return prismaClient.game.findFirst({
    where: { seasonId, finished: true },
    orderBy: [{ endTime: "desc" }, { startTime: "desc" }],
    include: {
      gameParticipations: { include: { player: true } },
      season: true,
    },
  });
}

function splitTeams(g: GameWithParts) {
  const red = g.gameParticipations.filter((p) => p.team === Team.RED);
  const blue = g.gameParticipations.filter((p) => p.team === Team.BLUE);
  return { red, blue };
}

type RecalcBase = {
  playerId: string;
  ign: string;
  team: Team;
  isCaptain: boolean;
  isMvp: boolean;
  preElo: number;
  preWins: number;
  preLosses: number;
  preWinStreak: number;
  preLoseStreak: number;
  preMaxWin: number;
  preMaxLose: number;
};

async function gatherPreStats(
  seasonId: string,
  gameId: string,
  parts: GameWithParts["gameParticipations"]
): Promise<RecalcBase[]> {
  const byPlayer = new Map<string, RecalcBase>();
  for (const gp of parts) {
    const playerId = gp.playerId;

    const otherParts = await prismaClient.gameParticipation.findMany({
      where: { playerId, seasonId, gameId: { not: gameId } },
      include: { game: true },
    });
    otherParts.sort(
      (a, b) =>
        new Date(a.game.endTime).getTime() - new Date(b.game.endTime).getTime()
    );

    let wins = 0,
      losses = 0,
      curW = 0,
      curL = 0,
      bestW = 0,
      bestL = 0;
    for (const op of otherParts) {
      const w = op.game.winner;
      if (!w) continue;
      if (w === op.team) {
        wins++;
        curW++;
        curL = 0;
        if (curW > bestW) bestW = curW;
      } else {
        losses++;
        curL++;
        curW = 0;
        if (curL > bestL) bestL = curL;
      }
    }

    const lastElo = await prismaClient.eloHistory.findFirst({
      where: { playerId, seasonId, gameId: { not: gameId } },
      orderBy: { createdAt: "desc" },
      select: { elo: true },
    });

    byPlayer.set(playerId, {
      playerId,
      ign: gp.ignUsed,
      team: gp.team,
      isCaptain: gp.captain,
      isMvp: gp.mvp,
      preElo: lastElo?.elo ?? 1000,
      preWins: wins,
      preLosses: losses,
      preWinStreak: curW,
      preLoseStreak: curL,
      preMaxWin: bestW,
      preMaxLose: bestL,
    });
  }
  return [...byPlayer.values()];
}

function expectedScoresFromPreElos(bases: RecalcBase[]) {
  const blueElos = bases
    .filter((b) => b.team === Team.BLUE)
    .map((b) => b.preElo);
  const redElos = bases.filter((b) => b.team === Team.RED).map((b) => b.preElo);
  const blueMean = blueElos.length
    ? Math.round(blueElos.reduce((a, b) => a + b, 0) / blueElos.length)
    : 1000;
  const redMean = redElos.length
    ? Math.round(redElos.reduce((a, b) => a + b, 0) / redElos.length)
    : 1000;
  const [blueExp, redExp] = EloUtil.calculateExpectedScore(blueMean, redMean);
  return { blueMean, redMean, blueExp, redExp };
}

function calculateAccurateNewElo(
  base: RecalcBase,
  desiredWinner: Team,
  expectations: {
    blueMean: number;
    redMean: number;
    blueExp: number;
    redExp: number;
  },
  isDoubleElo: boolean
): number {
  const config = ConfigManager.getConfig();
  const team = base.team;
  const expectedScore =
    team === Team.BLUE ? expectations.blueExp : expectations.redExp;
  const isWin = team === desiredWinner;

  const k = EloUtil.getKFactor(base.preElo);
  const actual = isWin ? 1 : 0;
  let delta = Math.abs(k * (actual - expectedScore));

  if (isWin && base.preWinStreak >= EloUtil.WIN_STREAK_MIN) {
    const winStreak = Math.min(
      base.preWinStreak,
      EloUtil.WIN_STREAK_MAX_THRESHOLD
    );
    const extra =
      winStreak > EloUtil.WIN_STREAK_MEDIUM_THRESHOLD
        ? EloUtil.BONUS_MULTIPLIER_MEDIUM +
          (winStreak - EloUtil.WIN_STREAK_MEDIUM_THRESHOLD) *
            EloUtil.BONUS_MULTIPLIER_INCREMENT_HIGH
        : 1 +
          (winStreak - (EloUtil.WIN_STREAK_MIN - 1)) *
            EloUtil.BONUS_MULTIPLIER_INCREMENT_LOW;
    delta = delta * extra;
  }

  const meanDiff = Math.abs(expectations.blueMean - expectations.redMean);
  if (meanDiff < 25) {
    const wFactor = config.underdogMultiplier;
    const adjustment = (0.5 - expectedScore) * wFactor;
    delta = isWin ? delta + delta * adjustment : delta + delta * -adjustment;
  }

  delta = Number(delta.toFixed(1));

  let newElo = base.preElo;
  if (isWin) {
    newElo += isDoubleElo ? delta * 2 : delta;
  } else {
    newElo -= delta; // losses are NOT doubled in original logic
  }

  if (base.isMvp) {
    let m = config.mvpBonus;
    if (isDoubleElo) m = m * 2;
    newElo += m;
  }
  if (base.isCaptain) {
    newElo += config.captainBonus;
  }

  return Math.round(newElo);
}

async function main() {
  const season = await resolveSeason();
  const game = await getLastFinishedGame(season.id);
  if (!game) {
    console.log(`No finished games found for season #${season.number}.`);
    await rl.close();
    await prismaClient.$disconnect();
    process.exit(0);
  }

  const { red, blue } = splitTeams(game);
  console.log("\n[SUMMARY] Latest finished game:");
  console.log(
    [
      `  Season: ${season.number}${season.isActive ? " (active)" : ""}`,
      `  Game ID: ${game.id}`,
      `  Start: ${fmt(game.startTime)}  End: ${fmt(game.endTime)}`,
      `  Current Winner: ${game.winner ?? "n/a"}  Type: ${game.type ?? "n/a"}`,
      `  Map: ${game.settings?.map ?? "n/a"}  Minerushing: ${game.settings?.minerushing ? "on" : "off"}`,
      `  Organiser: ${game.organiser ?? "n/a"}  Host: ${game.host ?? "n/a"}`,
      `  RED (${red.length}): ${red.map((p) => p.ignUsed).join(", ") || "-"}`,
      `  BLUE (${blue.length}): ${blue.map((p) => p.ignUsed).join(", ") || "-"}`,
    ].join("\n")
  );

  const desired = (
    await ask('\nEnter the CORRECT winner ("RED" or "BLUE"): ')
  ).toUpperCase();
  if (desired !== "RED" && desired !== "BLUE") {
    console.error(`[ERROR] Invalid winner "${desired}". Expected RED or BLUE.`);
    await rl.close();
    await prismaClient.$disconnect();
    process.exit(1);
  }

  const dbl = (
    await ask("Was DOUBLE ELO active for this game? (yes/no, default no): ")
  ).toLowerCase();
  const isDoubleElo = dbl === "y" || dbl === "yes";

  const pre = await gatherPreStats(season.id, game.id, game.gameParticipations);
  const exp = expectedScoresFromPreElos(pre);

  console.log(
    `\n[PLAN] Fix winner for game ${game.id} -> set winner=${desired}`
  );
  for (const b of pre) {
    const correctedElo = calculateAccurateNewElo(
      b,
      desired as Team,
      exp,
      isDoubleElo
    );
    const w = b.team === desired;
    const wins = b.preWins + (w ? 1 : 0);
    const losses = b.preLosses + (w ? 0 : 1);
    const winStreak = w ? b.preWinStreak + 1 : 0;
    const loseStreak = w ? 0 : b.preLoseStreak + 1;
    const maxW = Math.max(b.preMaxWin, winStreak);
    const maxL = Math.max(b.preMaxLose, loseStreak);
    console.log(
      `  - ${b.playerId} [IGNs: ${b.ign}; Teams: ${b.team}] preElo:${b.preElo} -> correctedElo:${correctedElo} | W:${wins} L:${losses} winStreak:${winStreak} loseStreak:${loseStreak} maxWin:${maxW} maxLose:${maxL} | MVP:${b.isMvp} Captain:${b.isCaptain}`
    );
  }

  const ok = (
    await ask(
      '\nType "yes" to APPLY (revert + reinsert with corrected winner and accurate ELO): '
    )
  ).toLowerCase();
  if (ok !== "yes") {
    console.log("Aborted. No changes made.");
    await rl.close();
    await prismaClient.$disconnect();
    process.exit(0);
  }

  await prismaClient.$transaction(async (tx) => {
    console.log(`\n[DELETE] EloHistory for game ${game.id}...`);
    const preEloCount = await tx.eloHistory.count({
      where: { gameId: game.id },
    });
    console.log(`  Rows to delete: ${preEloCount}`);
    const delElo = await tx.eloHistory.deleteMany({
      where: { gameId: game.id },
    });
    console.log(`  -> Deleted: ${delElo.count}`);

    console.log(`\n[DELETE] GameParticipations for game ${game.id}...`);
    console.log(`  Participants to delete: ${game.gameParticipations.length}`);
    const delGP = await tx.gameParticipation.deleteMany({
      where: { gameId: game.id },
    });
    console.log(`  -> Deleted: ${delGP.count}`);

    console.log(`\n[DELETE] Game record ${game.id}...`);
    await tx.game.delete({ where: { id: game.id } });
    console.log(`  -> Deleted game ${game.id}`);

    console.log(
      `\n[CREATE] Game ${game.id} with corrected winner=${desired}...`
    );
    await tx.game.create({
      data: {
        id: game.id,
        finished: true,
        startTime: game.startTime,
        endTime: game.endTime,
        settings: game.settings,
        winner: desired as Team,
        type: game.type ?? null,
        organiser: game.organiser ?? null,
        host: game.host ?? null,
        participantsIGNs: game.participantsIGNs ?? [],
        season: { connect: { id: season.id } },
        gameParticipations: {
          create: game.gameParticipations.map((gp) => ({
            ignUsed: gp.ignUsed,
            team: gp.team,
            player: { connect: { id: gp.playerId } },
            mvp: gp.mvp,
            captain: gp.captain,
            season: { connect: { id: season.id } },
          })),
        },
      },
    });
    console.log(
      `  -> Recreated game ${game.id} and ${game.gameParticipations.length} participations`
    );

    const corrected = pre.map((b) => {
      const newElo = calculateAccurateNewElo(
        b,
        desired as Team,
        exp,
        isDoubleElo
      );
      const w = b.team === (desired as Team);
      const wins = b.preWins + (w ? 1 : 0);
      const losses = b.preLosses + (w ? 0 : 1);
      const winStreak = w ? b.preWinStreak + 1 : 0;
      const loseStreak = w ? 0 : b.preLoseStreak + 1;
      const biggestWinStreak = Math.max(b.preMaxWin, winStreak);
      const biggestLosingStreak = Math.max(b.preMaxLose, loseStreak);
      return {
        ...b,
        newElo,
        wins,
        losses,
        winStreak,
        loseStreak,
        biggestWinStreak,
        biggestLosingStreak,
      };
    });

    console.log(
      `\n[CREATE] EloHistory (corrected) for ${corrected.length} players...`
    );
    for (const s of corrected) {
      await tx.eloHistory.create({
        data: {
          playerId: s.playerId,
          gameId: game.id,
          elo: s.newElo,
          seasonId: season.id,
        },
      });
      console.log(
        `  - EloHistory: ${s.playerId} [IGNs: ${s.ign}; Teams: ${s.team}] -> elo:${s.newElo}`
      );
    }

    console.log(`\n[UPSERT] PlayerStats updates...`);
    for (const s of corrected) {
      const prev = await tx.playerStats.findUnique({
        where: {
          playerId_seasonId: { playerId: s.playerId, seasonId: season.id },
        },
      });
      const remaining = await tx.gameParticipation.count({
        where: { playerId: s.playerId, seasonId: season.id },
      });
      if (!remaining) {
        console.log(
          `  - ${s.playerId}: unexpected remaining=0 after recreation -> creating stats anyway`
        );
      }
      if (prev) {
        console.log(
          `  - ${s.playerId} BEFORE { elo:${prev.elo}, W:${prev.wins}, L:${prev.losses}, winStreak:${prev.winStreak}, loseStreak:${prev.loseStreak}, maxWin:${prev.biggestWinStreak}, maxLose:${prev.biggestLosingStreak} }`
        );
      } else {
        console.log(`  - ${s.playerId} BEFORE { none } -> will CREATE`);
      }
      await tx.playerStats.upsert({
        where: {
          playerId_seasonId: { playerId: s.playerId, seasonId: season.id },
        },
        update: {
          elo: s.newElo,
          wins: s.wins,
          losses: s.losses,
          winStreak: s.winStreak,
          loseStreak: s.loseStreak,
          biggestWinStreak: s.biggestWinStreak,
          biggestLosingStreak: s.biggestLosingStreak,
        },
        create: {
          playerId: s.playerId,
          seasonId: season.id,
          elo: s.newElo,
          wins: s.wins,
          losses: s.losses,
          winStreak: s.winStreak,
          loseStreak: s.loseStreak,
          biggestWinStreak: s.biggestWinStreak,
          biggestLosingStreak: s.biggestLosingStreak,
        },
      });
      console.log(
        `      AFTER  { elo:${s.newElo}, W:${s.wins}, L:${s.losses}, winStreak:${s.winStreak}, loseStreak:${s.loseStreak}, maxWin:${s.biggestWinStreak}, maxLose:${s.biggestLosingStreak} }`
      );
    }
  });

  console.log(
    `\n[OK] Fixed winner for game ${game.id} with accurate Elo recomputation. Reverted old rows and inserted corrected Game, Participations, EloHistory, and PlayerStats.`
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
