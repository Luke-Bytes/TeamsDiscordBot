import { PrismaClient } from "@prisma/client";

export const prismaClient = new PrismaClient().$extends({
  model: {
    player: {
      async byDiscordSnowflake(discordSnowflake: string) {
        return prismaClient.player.findUnique({
          where: {
            discordSnowflake,
          },
        });
      },
    },
  },
});
