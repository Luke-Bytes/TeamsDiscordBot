const { MongoClient } = require("mongodb");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const uri = process.env.DATABASE_URL;

async function resetDatabase() {
  try {
    console.log("Resetting database...");

    await prisma.gameParticipation.deleteMany({});
    await prisma.eloHistory.deleteMany({});

    await prisma.game.deleteMany({});

    const players = await prisma.player.findMany();
    for (const player of players) {
      await prisma.player.update({
        where: { id: player.id },
        data: {
          elo: 1000,
          wins: 0,
          losses: 0,
          winStreak: 0,
          loseStreak: 0,
          biggestWinStreak: 0,
          biggestLosingStreak: 0,
        },
      });
    }

    console.log("Database reset completed successfully.");
  } catch (error) {
    console.error("Error during reset:", error);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "reset") {
    await resetDatabase();
    return;
  }

  if (args[0] !== "save" || !args[1]) {
    console.error("Usage: script save [seasonNumber] or script reset");
    process.exit(1);
  }

  const seasonNumber = args[1];
  const seasonPrefix = `Season_${seasonNumber}`;
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db();

    const players = await prisma.player.findMany();
    const games = await prisma.game.findMany();
    const gameParticipations = await prisma.gameParticipation.findMany();
    const eloHistories = await prisma.eloHistory.findMany();

    await Promise.all([
      db.collection(`${seasonPrefix}_Player`).insertMany(players),
      db.collection(`${seasonPrefix}_Game`).insertMany(games),
      db
        .collection(`${seasonPrefix}_GameParticipation`)
        .insertMany(gameParticipations),
      db.collection(`${seasonPrefix}_EloHistory`).insertMany(eloHistories),
    ]);

    console.log(
      `Data successfully saved to collections under ${seasonPrefix}.`
    );
  } catch (error) {
    console.error("Error migrating data:", error);
  } finally {
    await client.close();
    await prisma.$disconnect();
  }
}

main();
