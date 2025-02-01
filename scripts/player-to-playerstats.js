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
      console.log(`Player Data (ID: ${player.id}):`, player);

      const playerElo = player.elo ?? 1000;
      const playerWins = player.wins ?? 0;
      const playerLosses = player.losses ?? 0;
      const playerWinStreak = player.winStreak ?? 0;
      const playerLoseStreak = player.loseStreak ?? 0;
      const playerBiggestWinStreak = player.biggestWinStreak ?? 0;
      const playerBiggestLosingStreak = player.biggestLosingStreak ?? 0;

      await prisma.playerStats.create({
        data: {
          playerId: player.id,
          seasonId: season.id,
          elo: playerElo,
          wins: playerWins,
          losses: playerLosses,
          winStreak: playerWinStreak,
          loseStreak: playerLoseStreak,
          biggestWinStreak: playerBiggestWinStreak,
          biggestLosingStreak: playerBiggestLosingStreak
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
