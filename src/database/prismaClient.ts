import { gameType, Prisma, PrismaClient, Team } from "@prisma/client";
import { GameInstance } from "../database/GameInstance";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { Elo } from "../logic/Elo";

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
          organiser,
          host,
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
              const player = await prismaClient.player.findUnique({
                where: { id: playerRecord.id },
              });

              await prismaClient.player.update({
                where: { id: playerRecord.id },
                data: {
                  wins: { increment: 1 },
                  winStreak: { increment: 1 },
                  loseStreak: 0,
                  biggestWinStreak: Math.max(
                    player!.winStreak + 1,
                    player!.biggestWinStreak
                  ),
                },
              });
            } else if (team === losingTeam) {
              const player = await prismaClient.player.findUnique({
                where: { id: playerRecord.id },
              });

              await prismaClient.player.update({
                where: { id: playerRecord.id },
                data: {
                  losses: { increment: 1 },
                  loseStreak: { increment: 1 },
                  winStreak: 0,
                  biggestLosingStreak: Math.max(
                    player!.loseStreak + 1,
                    player!.biggestLosingStreak
                  ),
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
            organiser: organiser,
            host: host,
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
            organiser: organiser,
            host: host,
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
        const game = GameInstance.getInstance();
        const meanEloDifference = Math.abs(
          (game.blueMeanElo ?? 0) - (game.redMeanElo ?? 0)
        );
        if (meanEloDifference < 25) {
          console.log(
            `Mean Elo difference (${meanEloDifference}) is less than 25. Skipping weighting adjustments.`
          );
        } else {
          console.log(
            `Mean Elo difference (${meanEloDifference}) is greater than 25. Adding weighting adjustments.`
          );

        if (CurrentGameManager.getCurrentGame().isDoubleElo) {
          console.log("Double elo is active this game!");
        }
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
