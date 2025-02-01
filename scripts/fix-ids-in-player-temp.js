import { MongoClient } from 'mongodb';
import { config } from 'dotenv';

config()

const client = new MongoClient(process.env.DATABASE_URL);

async function fixPlayerIds() {
  try {
    await client.connect();
    const database = client.db();
    const playersCollection = database.collection('Player');

    const players = await playersCollection.find().toArray();

    for (const player of players) {
      const objectIdString = player._id.toString();

      if (!player.id || player.id !== objectIdString) {
        console.log(`Fixing player with _id: ${objectIdString}`);

        await playersCollection.updateOne(
          { _id: player._id },
          { $set: { id: objectIdString } }
        );
      }
    }

    console.log("Player ID consistency fix completed.");
  } catch (error) {
    console.error("Error during ID fix:", error);
  } finally {
    await client.close();
  }
}

fixPlayerIds();
