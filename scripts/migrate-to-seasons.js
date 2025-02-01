import { PrismaClient } from "@prisma/client";
import { MongoClient } from "mongodb";

const prisma = new PrismaClient();
const mongo = new MongoClient(process.env.DATABASE_URL);

async function main() {
  const season1 = await prisma.season.create({
    data: {
      number: 1,
      name: "Season 1",
      startDate: new Date("2024-12-28"),
      isActive: true,
    },
  });

  await mongo.connect();
  const db = mongo.db();
  const playersCollection = db.collection("Player");

  const players = await playersCollection.find({}).toArray();

  for (const p of players) {
    const oldElo = p.elo ?? 1000;
    const oldWins = p.wins ?? 0;
    const oldLosses = p.losses ?? 0;
    const oldWinStreak = p.winStreak ?? 0;
    const oldLoseStreak = p.loseStreak ?? 0;
    const oldBiggestWinStreak = p.biggestWinStreak ?? 0;
    const oldBiggestLosingStreak = p.biggestLosingStreak ?? 0;

    await prisma.playerStats.create({
      data: {
        playerId: p._id.toString(),
        seasonId: season1.id,
        elo: oldElo,
        wins: oldWins,
        losses: oldLosses,
        winStreak: oldWinStreak,
        loseStreak: oldLoseStreak,
        biggestWinStreak: oldBiggestWinStreak,
        biggestLosingStreak: oldBiggestLosingStreak,
      },
    });
  }

  await prisma.game.updateMany({
    data: { seasonId: season1.id },
  });

  await prisma.gameParticipation.updateMany({
    data: { seasonId: season1.id },
  });

  await prisma.eloHistory.updateMany({
    data: { seasonId: season1.id },
  });

  console.log("Migration to Season 1 complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongo.close();
  });
