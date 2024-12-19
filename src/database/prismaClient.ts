import { PrismaClient, Team } from "@prisma/client";
import { GameInstance } from "../database/GameInstance";
import { CurrentGameManager } from "../logic/CurrentGameManager";

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
    game: {
      async saveGameFromInstance(gameInstance: GameInstance) {
        const {
          gameId,
          startTime,
          endTime,
          isFinished,
          settings,
          teams,
          gameWinner,
        } = gameInstance;

        const newGameId = gameId ?? undefined; // Prisma will create a uuid, not sure if we have reason for a custom system

        const gameSettings = {
          minerushing: settings.minerushing ?? false,
          bannedClasses: settings.bannedClasses ?? [],
          map: settings.map ?? "DUELSTAL",
        };

        const redTeamParticipants = await Promise.all(
          teams.RED.map(async (playerInstance) => {
            const playerRecord = await prismaClient.player.byDiscordSnowflake(
              playerInstance.discordSnowflake
            );
            if (!playerRecord) {
              console.warn(
                `Player not found for discordSnowflake: ${playerInstance.discordSnowflake}`
              );
              return null;
            }
            const currentGame = CurrentGameManager.getCurrentGame();
            const mvpRed = currentGame.MVPPlayerRed;
            const captainRed = currentGame.getCaptainOfTeam("RED");
            return {
              ignUsed: playerInstance.ignUsed ?? "UnknownIGN",
              team: "RED",
              playerId: playerRecord.id,
              mvp: (playerInstance.ignUsed ?? "UnknownIGN") === mvpRed,
              captain:
                captainRed?.discordSnowflake === playerRecord.discordSnowflake,
            };
          })
        );

        const blueTeamParticipants = await Promise.all(
          teams.BLUE.map(async (playerInstance) => {
            const playerRecord = await prismaClient.player.byDiscordSnowflake(
              playerInstance.discordSnowflake
            );
            if (!playerRecord) {
              console.warn(
                `Player not found for discordSnowflake: ${playerInstance.discordSnowflake}`
              );
              return null;
            }
            const currentGame = CurrentGameManager.getCurrentGame();
            const mvpBlue = currentGame.MVPPlayerBlue;
            const captainBlue = currentGame.getCaptainOfTeam("BLUE");
            return {
              ignUsed: playerInstance.ignUsed ?? "UnknownIGN",
              team: "BLUE",
              playerId: playerRecord.id,
              mvp: (playerInstance.ignUsed ?? "UnknownIGN") === mvpBlue,
              captain:
                captainBlue?.discordSnowflake === playerRecord.discordSnowflake,
            };
          })
        );

        const allParticipants = [
          ...redTeamParticipants,
          ...blueTeamParticipants,
        ].filter(Boolean);

        const gameRecord = await prismaClient.game.upsert({
          where: { id: newGameId ?? "" },
          update: {
            finished: isFinished ?? false,
            startTime: startTime ?? new Date(),
            endTime: endTime ?? new Date(),
            settings: gameSettings,
          },
          create: {
            id: newGameId,
            finished: isFinished ?? false,
            startTime: startTime ?? new Date(),
            endTime: endTime ?? new Date(),
            settings: gameSettings,
            winner:
              gameWinner === "RED" || gameWinner === "BLUE"
                ? (gameWinner as Team)
                : undefined,
            participants: {
              create: allParticipants as any,
            },
          },
          include: {
            participants: true,
          },
        });
        return gameRecord;
      },
    },
  },
});
