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
        let player = await prismaClient.player.findFirst({
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
        return player;
      },

      async addMcAccount(
        idOrSnowflake: string,
        ign: string
      ): Promise<{ error: false } | { error: string }> {
        let player = await prismaClient.player.findFirst({
          where: {
            OR: [
              {
                id: idOrSnowflake,
              },
              {
                discordSnowflake: idOrSnowflake,
              },
            ],
          },
        });

        if (!player) {
          return {
            error: "Account not found.",
          };
        }

        if (player.minecraftAccounts.includes(ign)) {
          return {
            error: "You have already added this username.",
          };
        }

        let otherPlayers = await prismaClient.player.findMany({
          where: {
            minecraftAccounts: {
              has: ign,
            },
          },
        });

        if (otherPlayers.length > 0) {
          return {
            error: "Someone already has this username.",
          };
        }

        if (player.minecraftAccounts.length >= 4) {
          return {
            error: "You have reached the account limit.",
          };
        } else {
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

          return {
            error: false,
          };
        }
      },
    },
  },
});
