#!/usr/bin/env ts-node
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Prisma } from "@prisma/client";
import { prismaClient } from "../src/database/prismaClient";
import {
  commitTeamCorrection,
  loadTeamCorrection,
} from "../src/database/LastGameTeamCorrection";
import { parseTeamCorrectionArgs } from "../src/util/TeamCorrectionArgs";

// Example: npx tsx scripts/fix-last-game-teams.ts --move Alice=RED --move Bob=BLUE
// Optional: --remove PlayerName; --season 3; legacy games: --double-elo yes|no.
// Preview is read-only. --apply enables a yes/no confirmation of the shown game.
async function main() {
  const { moves, options, apply } = parseTeamCorrectionArgs(
    process.argv.slice(2)
  );
  const transaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prismaClient.$transaction(
      (tx) => work(tx as unknown as Prisma.TransactionClient),
      { maxWait: 10_000, timeout: 60_000 }
    );
  const plan = await transaction((tx) =>
    loadTeamCorrection(tx, moves, options)
  );
  console.log(
    `Season #${plan.season.number}; game ${plan.game.id}; ended ${plan.game.endTime.toISOString()}`
  );
  console.log(
    `Winner: ${plan.game.winner}; rated: ${plan.rated}; double Elo: ${plan.doubleElo ?? "n/a"}`
  );
  console.table(
    plan.updates.map((u) => ({
      player: u.ign,
      playerId: u.playerId,
      from: u.from,
      to: u.to ?? "REMOVED",
      mvp: u.mvp,
      captain: u.captain,
      votedForAMVP: u.votedForAMVP,
      oldElo: u.old.elo,
      newElo: u.next.elo,
      wins: `${u.old.wins} -> ${u.next.wins}`,
      losses: `${u.old.losses} -> ${u.next.losses}`,
      winStreak: `${u.old.winStreak} -> ${u.next.winStreak}`,
      loseStreak: `${u.old.loseStreak} -> ${u.next.loseStreak}`,
      biggestWinStreak: `${u.old.biggestWinStreak} -> ${u.next.biggestWinStreak}`,
      biggestLosingStreak: `${u.old.biggestLosingStreak} -> ${u.next.biggestLosingStreak}`,
    }))
  );
  if (!apply) {
    console.log(
      "Preview only. Add --apply to confirm and commit these corrections."
    );
    return;
  }
  const rl = createInterface({ input, output });
  try {
    const confirmation = await rl.question(
      "Apply these changes to the latest saved game shown above? (yes/no, default no): "
    );
    if (!["yes", "y"].includes(confirmation.trim().toLowerCase())) {
      console.log("Aborted. No changes made.");
      return;
    }
    await commitTeamCorrection(transaction, plan, moves, options);
    console.log(
      "Corrected roster and recalculated stats, including restoring removed players' pre-game stats. Winner and remaining MVP/voting flags preserved."
    );
  } finally {
    rl.close();
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Team correction failed."
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaClient.$disconnect();
  });
