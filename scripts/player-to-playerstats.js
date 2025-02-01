import { MongoClient } from 'mongodb';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const client = new MongoClient(process.env.DATABASE_URL);

async function migratePlayerDataToPlayerStats() {
  try {
    await client.connect();
    const database = client.db();
    const playersCollection = database.collection('Player');

    const players = await playersCollection.find().toArray();

    console.log(`Found ${players.length} players. Migrating...`);

    const season = await prisma.season.findFirst({
      where: { number: 1 }
    });

    if (!season) {
      console.error("Season 1 not found. Please create it before running the migration.");
      return;
    }

    for (const player of players) {
      console.log(`Player Data (ID: ${player._id}):`, player);

      await prisma.playerStats.create({
        data: {
          playerId: player._id.toString(),
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

      console.log(`Migrated stats for Player ${player._id}`);
    }

    console.log("Migration completed successfully.");
  } catch (error) {
    console.error("Error during migration:", error);
  } finally {
    await client.close();
    await prisma.$disconnect();
  }
}

migratePlayerDataToPlayerStats();
