import { prismaClient } from "../database/prismaClient";

export class PrismaUtils {
  static async findPlayer(identifier: string) {
    return await prismaClient.player.findFirst({
      where: {
        OR: [{ discordSnowflake: identifier }, { latestIGN: identifier }],
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
}
