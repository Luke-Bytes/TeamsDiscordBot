import { Game, Prisma, PrismaClient } from "@prisma/client";
import { GameInstance } from "../database/GameInstance";
import { persistCompletedMatch } from "./MatchPersistence";

async function requireActiveSeasonForPrismaExtension() {
  const season = await prismaClient.season.findFirst({
    where: { isActive: true },
    orderBy: { number: "desc" },
  });
  if (!season) {
    throw new Error("No active season found. Please activate a season first.");
  }
  return season;
}

export const prismaClient = new PrismaClient({
  log: ["info", "warn", "error"],
}).$extends({
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
                minecraftAccounts: { has: minecraftAccount },
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
          return {
            error: "This username is already registered by another user.",
          };
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

      async getPlayerStatsForCurrentSeason(playerId: string) {
        const season = await requireActiveSeasonForPrismaExtension();

        let playerStats = await prismaClient.playerStats.findUnique({
          where: {
            playerId_seasonId: {
              playerId,
              seasonId: season.id,
            },
          },
        });

        playerStats ??= await prismaClient.playerStats.create({
          data: {
            playerId,
            seasonId: season.id,
            elo: 1000,
          },
        });
        return playerStats;
      },
    },

    game: {
      async saveGameFromInstance(gameInstance: GameInstance): Promise<Game> {
        return persistCompletedMatch(gameInstance, {
          transaction: <T>(
            work: (tx: Prisma.TransactionClient) => Promise<T>
          ): Promise<T> =>
            // Extended Prisma clients have different generated delegate types,
            // though the interactive transaction implements these base operations.
            prismaClient.$transaction(
              (tx) => work(tx as unknown as Prisma.TransactionClient),
              { maxWait: 10_000, timeout: 60_000 }
            ),
          findCommitted: (matchId) =>
            prismaClient.game.findUnique({ where: { id: matchId } }),
        });
      },
    }
  },
});
