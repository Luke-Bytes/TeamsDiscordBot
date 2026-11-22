import { Player } from "@prisma/client";
import { prismaClient } from "../database/prismaClient";

/**
 * Keep live event applications in step with the canonical Discord->Minecraft
 * identity. Finished and withdrawn applications retain their historical IGN.
 * Both updates must commit together, or neither may commit.
 */
export async function updatePlayerIdentityAndEventSignups(
  player: Pick<
    Player,
    "id" | "discordSnowflake" | "primaryMinecraftAccount" | "latestIGN"
  >,
  oldUUID: string,
  newUUID: string,
  newUsername: string
): Promise<{ count: number }> {
  if (!player.discordSnowflake)
    throw new Error("Cannot update an account without a Discord identity.");

  return prismaClient.$transaction(async (tx) => {
    const result = await tx.player.updateMany({
      where: {
        id: player.id,
        primaryMinecraftAccount: oldUUID,
        latestIGN: player.latestIGN,
      },
      data: {
        primaryMinecraftAccount: newUUID,
        latestIGN: newUsername,
      },
    });
    if (result.count !== 1) return result;

    const activeEvents = await tx.standaloneEvent.findMany({
      where: { state: { in: ["OPEN", "CLOSED"] } },
      select: { id: true },
    });
    if (activeEvents.length)
      await tx.eventSignup.updateMany({
        where: {
          discordUserId: player.discordSnowflake,
          eventId: { in: activeEvents.map((event) => event.id) },
          status: { in: ["CONFIRMED", "RESERVE"] },
        },
        data: {
          minecraftUUID: newUUID,
          minecraftUsername: newUsername,
        },
      });
    return result;
  });
}
