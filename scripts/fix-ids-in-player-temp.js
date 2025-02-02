import { MongoClient, ObjectId } from "mongodb";
require('dotenv').config();

(async function main() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri) {
    console.error('Please set MONGODB_URI or DATABASE_URL in your environment.');
    process.exit(1);
  }

  let client;
  try {
    client = new MongoClient(uri);
    await client.connect();
    console.log('Connected to MongoDB.');

    const db = client.db();

    const seasonNumber = 1;
    let season = await db.collection('Season').findOne({ number: seasonNumber });
    if (!season) {
      const newSeasonId = new ObjectId().toHexString();
      season = {
        _id: newSeasonId,
        number: seasonNumber,
        name: `Season ${seasonNumber}`,
        startDate: new Date(),
        isActive: true,
      };
      await db.collection('Season').insertOne(season);
      console.log(`Created new Season #${seasonNumber} with _id:`, newSeasonId);
    } else {
      console.log(`Using existing Season #${seasonNumber} with _id:`, season._id);
    }

    const playerCollection = db.collection('Player');

    const playersCursor = playerCollection.find({});
    while (await playersCursor.hasNext()) {
      const playerDoc = await playersCursor.next();

      if (playerDoc._id instanceof ObjectId) {
        const stringId = playerDoc._id.toHexString();
        playerDoc._id = stringId;
      }

      delete playerDoc.elo;
      delete playerDoc.wins;
      delete playerDoc.losses;
      delete playerDoc.winStreak;
      delete playerDoc.loseStreak;
      delete playerDoc.biggestWinStreak;
      delete playerDoc.biggestLosingStreak;

      await playerCollection.replaceOne(
        { _id: playerDoc._id },
        playerDoc
      );
    }
    console.log('Player documents updated successfully.');

    const gameParticipationCollection = db.collection('GameParticipation');
    const gpCursor = gameParticipationCollection.find({});
    while (await gpCursor.hasNext()) {
      const gpDoc = await gpCursor.next();
      let updateNeeded = false;

      if (gpDoc.playerId instanceof ObjectId) {
        gpDoc.playerId = gpDoc.playerId.toHexString();
        updateNeeded = true;
      }
      if (gpDoc.gameId instanceof ObjectId) {
        gpDoc.gameId = gpDoc.gameId.toHexString();
        updateNeeded = true;
      }
      if (gpDoc._id instanceof ObjectId) {
        gpDoc._id = gpDoc._id.toHexString();
        updateNeeded = true;
      }

      if (updateNeeded) {
        await gameParticipationCollection.replaceOne(
          { _id: gpDoc._id },
          gpDoc
        );
      }
    }
    console.log('GameParticipation references updated.');

    // 4. Fix references in EloHistory as well
    const eloHistoryCollection = db.collection('EloHistory');
    const ehCursor = eloHistoryCollection.find({});
    while (await ehCursor.hasNext()) {
      const ehDoc = await ehCursor.next();
      let updateNeeded = false;

      if (ehDoc.playerId instanceof ObjectId) {
        ehDoc.playerId = ehDoc.playerId.toHexString();
        updateNeeded = true;
      }
      if (ehDoc.gameId instanceof ObjectId) {
        ehDoc.gameId = ehDoc.gameId.toHexString();
        updateNeeded = true;
      }
      if (ehDoc._id instanceof ObjectId) {
        ehDoc._id = ehDoc._id.toHexString();
        updateNeeded = true;
      }

      if (updateNeeded) {
        await eloHistoryCollection.replaceOne(
          { _id: ehDoc._id },
          ehDoc
        );
      }
    }
    console.log('EloHistory references updated.');

    console.log('Migration complete!');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    if (client) {
      await client.close();
      console.log('Disconnected from MongoDB.');
    }
  }
})();
