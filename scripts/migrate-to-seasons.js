import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_NAME = 'AnniBot';

async function addSeasonToCollections(seasonId, seasonNumber) {
  const client = new MongoClient(DATABASE_URL);
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);

    const collections = ['Game', 'GameParticipation', 'EloHistory', 'PlayerStats'];

    for (const collectionName of collections) {
      const collection = db.collection(collectionName);

      const updateResult = await collection.updateMany(
        { seasonId: { $exists: false } },
        { $set: { seasonId: seasonId } }
      );

      console.log(`Updated ${updateResult.modifiedCount} documents in ${collectionName}`);
    }

  } catch (error) {
    console.error("Error updating collections:", error);
  } finally {
    await client.close();
  }
}

async function getSeasonIdByNumber(seasonNumber) {
  const client = new MongoClient(DATABASE_URL);
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const season = await db.collection('Season').findOne({ number: seasonNumber });
    if (!season) {
      throw new Error(`Season with number ${seasonNumber} not found.`);
    }
    return season._id.toString();
  } catch (error) {
    console.error("Error fetching seasonId:", error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

(async () => {
  const seasonNumber = parseInt(process.argv[2], 10);
  if (isNaN(seasonNumber)) {
    console.error("Please provide a valid season number.");
    process.exit(1);
  }

  const seasonId = await getSeasonIdByNumber(seasonNumber);
  await addSeasonToCollections(seasonId, seasonNumber);
})();
