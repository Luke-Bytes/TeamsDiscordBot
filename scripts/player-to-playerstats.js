import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migratePlayerDataToPlayerStats() {
  try {
    const season = await prisma.season.findFirst({
      where: { number: 1 }
    });

    if (!season) {
      console.error("Season not found. Please create it before running the migration.");
      return;
    }

    const players = await prisma.player.findMany();

    console.log(`Found ${players.length} players. Migrating...`);

    for (const player of players) {
      await prisma.playerStats.create({
        data: {
          playerId: player.id,
          seasonId: season.id,
          elo: player.elo,
          wins: player.wins,
          losses: player.losses,
          winStreak: player.winStreak,
          loseStreak: player.loseStreak,
          biggestWinStreak: player.biggestWinStreak,
          biggestLosingStreak: player.biggestLosingStreak
        }
      });

      console.log(`PlayerStats created for Player ${player.id}`);
    }

    console.log("Migration completed successfully.");
  } catch (error) {
    console.error("Error during migration:", error);
  } finally {
    await prisma.$disconnect();
  }
}

migratePlayerDataToPlayerStats();
