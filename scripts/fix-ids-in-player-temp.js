import { MongoClient } from 'mongodb';
import { config } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

config()

const client = new MongoClient(process.env.DATABASE_URL);
async function fixPlayerIds() {
  try {
    await client.connect();
    const database = client.db();
    const playersCollection = database.collection('Player');

    const players = await playersCollection.find().toArray();

    for (const player of players) {
      if (player.id && player.id.length === 36) {
        continue;
      }

      console.log(`Fixing player with ObjectId _id: ${player._id}`);

      const newId = uuidv4();

      await playersCollection.deleteOne({ _id: player._id });

      await playersCollection.insertOne({
        id: newId,
        ...player,
        _id: undefined,
      });

      console.log(`Migrated player from ObjectId to new UUID id: ${newId}`);
    }

    console.log("Migration of Player records to UUIDs completed successfully.");
  } catch (error) {
    console.error("Error during migration:", error);
  } finally {
    await client.close();
  }
}

fixPlayerIds();
