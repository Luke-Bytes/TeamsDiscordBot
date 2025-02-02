import { MongoClient, ObjectId } from "mongodb";
import { config } from "dotenv";

async function main() {
  config();
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri) {
    console.error(
      "Please set MONGODB_URI or DATABASE_URL in your environment."
    );
    process.exit(1);
  }

  const dbName = "AnniBot";
  const client = new MongoClient(uri, { useUnifiedTopology: true });

  try {
    await client.connect();
    console.log(`Connected to MongoDB: ${uri}`);

    const db = client.db(dbName);
    console.log(`Using DB: ${db.databaseName}`);

    const seasonCollection = db.collection("Season");
    const seasonNumber = 1;
    let season = await seasonCollection.findOne({ number: seasonNumber });
    if (!season) {
      const newSeasonId = new ObjectId().toHexString();
      season = {
        _id: newSeasonId,
        number: seasonNumber,
        name: `Season ${seasonNumber}`,
        startDate: new Date(),
        isActive: true,
      };
      await seasonCollection.insertOne(season);
      console.log(`Created new Season #${seasonNumber}, _id=${newSeasonId}`);
    } else {
      console.log(`Found existing Season #${seasonNumber}, _id=${season._id}`);
    }

    const playerCol = db.collection("Player");
    const playersCursor = playerCol.find({});
    let migratedPlayers = 0;
    while (await playersCursor.hasNext()) {
      const playerDoc = await playersCursor.next();

      console.log(`---\nOriginal Player doc:`, playerDoc);

      if (playerDoc.id && playerDoc.id !== playerDoc._id) {
        console.log(
          `  Found separate \`id\` field = ${playerDoc.id}, \`_id\` = ${playerDoc._id}`
        );
        playerDoc._id = playerDoc.id;
        delete playerDoc.id;
        console.log(`  Unifying _id to ${playerDoc._id}`);
      }

      if (playerDoc._id instanceof ObjectId) {
        playerDoc._id = playerDoc._id.toHexString();
        console.log(`  Converted ObjectId to string: ${playerDoc._id}`);
      }

      delete playerDoc.elo;
      delete playerDoc.wins;
      delete playerDoc.losses;
      delete playerDoc.winStreak;
      delete playerDoc.loseStreak;
      delete playerDoc.biggestWinStreak;
      delete playerDoc.biggestLosingStreak;

      // Attempt an update using replaceOne
      const filter = { _id: playerDoc._id };
      const result = await playerCol.replaceOne(filter, playerDoc);

      console.log(
        `  replaceOne matchedCount=${result.matchedCount}, ` +
          `modifiedCount=${result.modifiedCount}`
      );
      if (result.matchedCount === 0) {
        console.warn(
          `  WARNING: No document found with _id=${playerDoc._id}. ` +
            `Check your collection name and DB.`
        );
      }

      migratedPlayers += result.modifiedCount;
    }
    console.log(
      `Migration step for Player docs completed. Updated ${migratedPlayers} documents.`
    );

    // 4) Convert references in GameParticipation
    //    If you need to unify _id or fix "playerId" "gameId" references
    const gpCol = db.collection("GameParticipation");
    const gpCursor = gpCol.find({});
    let gpUpdates = 0;
    while (await gpCursor.hasNext()) {
      const gpDoc = await gpCursor.next();
      let changed = false;

      // unify gpDoc._id if needed
      if (gpDoc._id instanceof ObjectId) {
        gpDoc._id = gpDoc._id.toHexString();
        changed = true;
      }
      // unify playerId if needed
      if (gpDoc.playerId instanceof ObjectId) {
        gpDoc.playerId = gpDoc.playerId.toHexString();
        changed = true;
      }
      // unify gameId if needed
      if (gpDoc.gameId instanceof ObjectId) {
        gpDoc.gameId = gpDoc.gameId.toHexString();
        changed = true;
      }

      if (changed) {
        const filter = { _id: gpDoc._id };
        const result = await gpCol.replaceOne(filter, gpDoc);
        gpUpdates += result.modifiedCount;
      }
    }
    console.log(
      `GameParticipation references updated. Modified ${gpUpdates} docs.`
    );

    // 5) Convert references in EloHistory
    const eloHistoryCol = db.collection("EloHistory");
    const ehCursor = eloHistoryCol.find({});
    let ehUpdates = 0;
    while (await ehCursor.hasNext()) {
      const ehDoc = await ehCursor.next();
      let changed = false;

      if (ehDoc._id instanceof ObjectId) {
        ehDoc._id = ehDoc._id.toHexString();
        changed = true;
      }
      if (ehDoc.playerId instanceof ObjectId) {
        ehDoc.playerId = ehDoc.playerId.toHexString();
        changed = true;
      }
      if (ehDoc.gameId instanceof ObjectId) {
        ehDoc.gameId = ehDoc.gameId.toHexString();
        changed = true;
      }

      if (changed) {
        const filter = { _id: ehDoc._id };
        const result = await eloHistoryCol.replaceOne(filter, ehDoc);
        ehUpdates += result.modifiedCount;
      }
    }
    console.log(`EloHistory references updated. Modified ${ehUpdates} docs.`);

    console.log("Migration complete!");
  } catch (error) {
    console.error("Migration error:", error);
  } finally {
    await client.close();
    console.log("Disconnected from MongoDB.");
  }
}

main().catch((err) => console.error(err));
