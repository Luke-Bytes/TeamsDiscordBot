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

      async byMinecraftAccount(minecraftAccount: string) {
        return await prismaClient.player.findFirst({
          where: {
            OR: [
              {
                minecraftAccounts: {
                  has: minecraftAccount,
                },
              },
              {
                primaryMinecraftAccount: minecraftAccount,
              },
            ],
          },
        });
      },

      async addMcAccount(
        discordSnowflake: string,
        ign: string
      ): Promise<{ error: false } | { error: string }> {
        let player = await prismaClient.player.findFirst({
          where: { discordSnowflake },
        });

        if (!player) {
          player = await prismaClient.player.create({
            data: { discordSnowflake },
          });
        }

        if (player.minecraftAccounts.includes(ign)) {
          return { error: "You have already added this username." };
        }

        const otherPlayers = await prismaClient.player.findMany({
          where: {
            minecraftAccounts: { has: ign },
          },
        });

        if (otherPlayers.length) {
          return { error: "This user is already registered by another user." };
        }

        player.minecraftAccounts.push(ign);
        if (player.minecraftAccounts.length === 1) {
          player.primaryMinecraftAccount = ign;
        }

        await prismaClient.player.update({
          where: { id: player.id },
          data: {
            minecraftAccounts: player.minecraftAccounts,
            primaryMinecraftAccount: player.primaryMinecraftAccount,
          },
        });

        return { error: false };
      },
    },
  },
});
