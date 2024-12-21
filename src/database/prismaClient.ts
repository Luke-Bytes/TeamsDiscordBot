import { gameType, Prisma, PrismaClient, Team } from "@prisma/client";
import { GameInstance } from "../database/GameInstance";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { Elo } from "logic/Elo";

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
          teamsDecidedBy,
        } = gameInstance;

        const gameSettings = {
          minerushing: settings.minerushing ?? false,
          bannedClasses: settings.bannedClasses ?? [],
          map: settings.map ?? "DUELSTAL",
        };

        const allParticipants = await Promise.all(
          [...teams.RED, ...teams.BLUE].map(async (playerInstance) => {
            const playerRecord = await prismaClient.player.byDiscordSnowflake(
              playerInstance.discordSnowflake
            );

            if (!playerRecord) {
              console.warn(
                `Player not found for discordSnowflake: ${playerInstance.discordSnowflake}`
              );
              return null;
            }

            const team = teams.RED.includes(playerInstance) ? "RED" : "BLUE";

            const currentGame = CurrentGameManager.getCurrentGame();
            const winningTeam = currentGame.gameWinner;
            const losingTeam = winningTeam === "RED" ? "BLUE" : "RED";

            if (team === winningTeam) {
              await prismaClient.player.update({
                where: { id: playerRecord.id },
                data: {
                  wins: { increment: 1 },
                  winStreak: { increment: 1 },
                },
              });
            } else if (team === losingTeam) {
              await prismaClient.player.update({
                where: { id: playerRecord.id },
                data: {
                  losses: { increment: 1 },
                  winStreak: 0,
                },
              });
            }
            const mvp =
              (team === "RED" &&
                currentGame.MVPPlayerRed === playerInstance.ignUsed) ||
              (team === "BLUE" &&
                currentGame.MVPPlayerBlue === playerInstance.ignUsed);

            return {
              ignUsed: playerInstance.ignUsed ?? "UnknownIGN",
              team,
              player: {
                connect: { id: playerRecord.id },
              },
              mvp,
              captain: playerInstance.captain === true,
            } as Prisma.GameParticipationCreateWithoutGameInput;
          })
        );

        const validParticipants = allParticipants.filter(
          (
            participant
          ): participant is Prisma.GameParticipationCreateWithoutGameInput =>
            participant !== null
        );

        const gameRecord = await prismaClient.game.upsert({
          where: { id: gameId ?? "" },
          update: {
            finished: isFinished ?? false,
            startTime: startTime ?? new Date(),
            endTime: endTime ?? new Date(),
            settings: gameSettings,
            winner:
              gameWinner === "RED" || gameWinner === "BLUE"
                ? (gameWinner as Team)
                : undefined,
            type: teamsDecidedBy as gameType | null,
            participantsIGNs: validParticipants.map(
              (p) => p?.ignUsed || "UnknownIGN"
            ),
            gameParticipations: {
              create: validParticipants,
            },
          },
          create: {
            id: gameId,
            finished: isFinished ?? false,
            startTime: startTime ?? new Date(),
            endTime: endTime ?? new Date(),
            settings: gameSettings,
            winner:
              gameWinner === "RED" || gameWinner === "BLUE"
                ? (gameWinner as Team)
                : undefined,
            type: teamsDecidedBy as gameType | null,
            participantsIGNs: validParticipants.map(
              (p) => p?.ignUsed ?? "UnknownIGN"
            ),
            gameParticipations: {
              create: validParticipants,
            },
          },
          include: {
            gameParticipations: true,
          },
        });

        const eloManager = new Elo();

        for (const playerInstance of [...teams.RED, ...teams.BLUE]) {
          eloManager.applyEloUpdate(playerInstance);

          await prismaClient.player.update({
            where: { discordSnowflake: playerInstance.discordSnowflake },
            data: { elo: playerInstance.elo },
          });

          await prismaClient.eloHistory.create({
            data: {
              playerId: playerInstance.playerId,
              gameId: gameRecord.id,
              elo: playerInstance.elo,
            },
          });
        }

        return gameRecord;
      },
    },
  },
});
