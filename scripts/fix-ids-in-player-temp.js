import { MongoClient } from 'mongodb';
import { config } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

config()

const client = new MongoClient(process.env.DATABASE_URL);
async function fixMigratedPlayerRecords() {
  try {
    await client.connect();
    const database = client.db();
    const playersCollection = database.collection('Player');

    const players = await playersCollection.find().toArray();

    for (const player of players) {
      if (player._id.toString() === player.id && player.id.length === 36) {
        continue;
      }

      console.log(`Fixing player with ObjectId _id: ${player._id}`);

      const newId = uuidv4();

      // Replace the existing record with the new UUID-based record
      await playersCollection.deleteOne({ _id: player._id });
      await playersCollection.insertOne({
        _id: newId,
        id: newId,
        ...player,
      });

      console.log(`Migrated player _id: ${player._id} to new UUID: ${newId}`);
    }

    console.log("Migration of Player records to UUIDs completed successfully.");
  } catch (error) {
    console.error("Error during migration:", error);
  } finally {
    await client.close();
  }
}

fixMigratedPlayerRecords();
