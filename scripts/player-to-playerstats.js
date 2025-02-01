import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migratePlayerDataToPlayerStats() {
  try {
    const season = await prisma.season.findFirst({
      where: { number: 1 }
    });

    if (!season) {
      console.error("Season 1 not found. Please create it before running the migration.");
      return;
    }

    const players = await prisma.player.findMany();

    console.log(`Found ${players.length} players. Migrating...`);

    for (const player of players) {
      await prisma.playerStats.create({
        data: {
          playerId: player.id,
          seasonId: season.id,
          elo: player.elo ?? 1000,
          wins: player.wins ?? 0,
          losses: player.losses ?? 0,
          winStreak: player.winStreak ?? 0,
          loseStreak: player.loseStreak ?? 0,
          biggestWinStreak: player.biggestWinStreak ?? 0,
          biggestLosingStreak: player.biggestLosingStreak ?? 0
        }
      });

      console.log(`Migrated stats for Player ${player.id}`);
    }

    console.log("Migration completed successfully.");
  } catch (error) {
    console.error("Error during migration:", error);
  } finally {
    await prisma.$disconnect();
  }
}

migratePlayerDataToPlayerStats();
