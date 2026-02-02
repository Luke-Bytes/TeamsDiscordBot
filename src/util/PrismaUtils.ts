import { prismaClient } from "../database/prismaClient";

export class PrismaUtils {
  static async findPlayer(identifier: string) {
    identifier = identifier.replace(/<@([^>]+)>/g, "$1");
    return await prismaClient.player.findFirst({
      where: {
        OR: [
          { discordSnowflake: identifier },
          {
            latestIGN: {
              equals: identifier,
              mode: "insensitive",
            },
          },
        ],
      },
    });
  }

  static async getPlayerData(
    identifier: string,
    fields: (keyof typeof prismaClient.player)[]
  ) {
    const player = await PrismaUtils.findPlayer(identifier);
    if (!player) return null;

    const selectFields = Object.fromEntries(
      fields.map((field) => [field, true])
    );

    return await prismaClient.player.findUnique({
      where: { id: player.id },
      select: selectFields,
    });
  }

  static async updatePunishmentsForExpiry() {
    const now = new Date();
    const punishments = await prismaClient.playerPunishment.findMany({
      where: {
        punishmentExpiry: { not: null },
      },
    });

    const punishmentsToUpdate = punishments.filter((punishment) => {
      const expiryDate = punishment.punishmentExpiry;
      if (!expiryDate) return false;
      return expiryDate.getTime() <= now.getTime();
    });

    for (const punishment of punishmentsToUpdate) {
      await prismaClient.playerPunishment.update({
        where: { id: punishment.id },
        data: { punishmentExpiry: null },
      });
    }

    return punishmentsToUpdate.length;
  }

  static async getPlayerTitle(identifier: string) {
    const player = await PrismaUtils.findPlayer(identifier);
    if (!player) return null;
    const profile = await (
      prismaClient as unknown as {
        profile?: {
          findUnique: (args: {
            where: { playerId: string };
          }) => Promise<{ title?: string | null } | null>;
        };
      }
    ).profile?.findUnique({
      where: { playerId: player.id },
    });
    return profile?.title ?? null;
  }
}
