import { PrismaClient } from "@prisma/client";
import { MojangAPI } from "../src/api/MojangAPI";

const prisma = new PrismaClient();

const oldUsername = process.argv[2];
const newUsername = process.argv[3];

if (!oldUsername || !newUsername) {
  console.error(
    "Usage: ts-node change-user-account.ts <oldUsername> <newUsername>"
  );
  process.exit(1);
}

async function replaceUUIDs() {
  const oldUUID = await MojangAPI.usernameToUUID(oldUsername);
  const newUUID = await MojangAPI.usernameToUUID(newUsername);

  if (!oldUUID || !newUUID) {
    console.error("Failed to resolve one or both UUIDs.");
    process.exit(1);
  }

  const player = await prisma.player.findFirst({
    where: { primaryMinecraftAccount: oldUUID },
  });

  if (!player) {
    console.error(`No player found with UUID: ${oldUUID}`);
    process.exit(1);
  }

  await prisma.player.update({
    where: { id: player.id },
    data: {
      primaryMinecraftAccount: newUUID,
      latestIGN: newUsername,
    },
  });

  console.log(
    `Replaced UUID ${oldUUID} with ${newUUID} for player ${player.id}`
  );
  await prisma.$disconnect();
}

replaceUUIDs();
