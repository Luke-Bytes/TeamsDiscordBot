import "dotenv/config";
import { prismaClient } from "../src/database/prismaClient";
import { MojangAPI } from "../src/api/MojangAPI";

const SLEEP_MS = 500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("Starting latestIGN refresh...");
  const players = await prismaClient.player.findMany({
    select: { id: true, primaryMinecraftAccount: true, latestIGN: true },
  });

  let checked = 0;
  let updated = 0;

  for (const p of players) {
    checked++;
    const uuid = p.primaryMinecraftAccount;
    if (!uuid) continue;

    try {
      const currentIGN = await MojangAPI.uuidToUsername(uuid);
      if (currentIGN && currentIGN !== p.latestIGN) {
        await prismaClient.player.update({
          where: { id: p.id },
          data: { latestIGN: currentIGN },
        });
        updated++;
        console.log(
          `Updated ${p.id}: ${p.latestIGN ?? "<none>"} -> ${currentIGN}`
        );
      }
    } catch (e) {
      console.warn(`Failed to refresh IGN for player ${p.id}:`, e);
    }

    await sleep(SLEEP_MS);
  }

  console.log(`Finished. Checked: ${checked}, Updated: ${updated}.`);
}

main()
  .catch((e) => {
    console.error("Fatal error refreshing latestIGNs:", e);
  })
  .finally(async () => {
    await prismaClient.$disconnect();
  });
