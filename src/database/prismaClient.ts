import { gameType, Prisma, PrismaClient, Team } from "@prisma/client";
import { GameInstance } from "../database/GameInstance";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { Elo } from "../logic/Elo";
import { ConfigManager } from "../ConfigManager";

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
        const config = ConfigManager.getConfig();
        const seasonNumber = config.season;
        const season = await prismaClient.season.findUnique({
          where: { number: seasonNumber },
        });

        if (!season) {
          throw new Error(
            `Season with number=${seasonNumber} not found. Please create it first.`
          );
        }

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
          isDoubleElo,
        } = gameInstance;

        const config = ConfigManager.getConfig();
        const seasonNumber = config.season;
        const season = await prismaClient.season.findUnique({
          where: { number: seasonNumber },
        });
        if (!season) {
          throw new Error(
            `Season with number=${seasonNumber} not found. Please create it first.`
          );
        }

        const gameSettings = {
          organiserBannedClasses: settings.organiserBannedClasses ?? [],
          sharedCaptainBannedClasses: settings.sharedCaptainBannedClasses ?? [],
          nonSharedCaptainBannedClasses:
            settings.nonSharedCaptainBannedClasses ?? {
              RED: [],
              BLUE: [],
            },
          map: settings.map ?? "DUELSTAL",
          modifiers: settings.modifiers ?? [],
          delayedBan: settings.delayedBan ?? 0,
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
            const losingTeam: Team | null =
              winningTeam === "RED"
                ? "BLUE"
                : winningTeam === "BLUE"
                  ? "RED"
                  : null;

            const pStats =
              await prismaClient.player.getPlayerStatsForCurrentSeason(
                playerRecord.id
              );

            if (winningTeam && team === winningTeam) {
              playerInstance.wins += 1;
              playerInstance.winStreak += 1;
              playerInstance.loseStreak = 0;
              playerInstance.biggestWinStreak = Math.max(
                playerInstance.winStreak,
                playerInstance.biggestWinStreak
              );

              await prismaClient.playerStats.update({
                where: {
                  playerId_seasonId: {
                    playerId: playerRecord.id,
                    seasonId: pStats.seasonId,
                  },
                },
                data: {
                  wins: { increment: 1 },
                  winStreak: { increment: 1 },
                  loseStreak: 0,
                  biggestWinStreak: Math.max(
                    pStats.winStreak + 1,
                    pStats.biggestWinStreak
                  ),
                },
              });
            } else if (losingTeam && team === losingTeam) {
              playerInstance.losses += 1;
              playerInstance.loseStreak += 1;
              playerInstance.winStreak = 0;
              playerInstance.biggestLosingStreak = Math.max(
                playerInstance.loseStreak,
                playerInstance.biggestLosingStreak
              );

              await prismaClient.playerStats.update({
                where: {
                  playerId_seasonId: {
                    playerId: playerRecord.id,
                    seasonId: pStats.seasonId,
                  },
                },
                data: {
                  losses: { increment: 1 },
                  loseStreak: { increment: 1 },
                  winStreak: 0,
                  biggestLosingStreak: Math.max(
                    pStats.loseStreak + 1,
                    pStats.biggestLosingStreak
                  ),
                },
              });
            }

            const mvp =
              (team === "RED" &&
                currentGame.MVPPlayerRed === playerInstance.ignUsed) ||
              (team === "BLUE" &&
                currentGame.MVPPlayerBlue === playerInstance.ignUsed);
            const votedForAMVP = currentGame.hasVotedMvp(
              playerInstance.discordSnowflake
            );

            return {
              ignUsed: playerInstance.ignUsed ?? "UnknownIGN",
              team,
              player: { connect: { id: playerRecord.id } },
              mvp,
              votedForAMVP,
              captain: playerInstance.captain === true,
              draftSlotPlacement:
                playerInstance.draftSlotPlacement ?? undefined,
              season: { connect: { id: season.id } },
            } as Prisma.GameParticipationCreateWithoutGameInput;
          })
        );

        const validParticipants = allParticipants.filter(
          (p): p is Prisma.GameParticipationCreateWithoutGameInput => p !== null
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
            organiser: organiser ?? undefined,
            host: host ?? undefined,
            doubleElo: isDoubleElo,
            participantsIGNs: validParticipants.map(
              (p) => p.ignUsed || "UnknownIGN"
            ),
            redTeamPlan: gameInstance.redTeamPlan ?? undefined,
            blueTeamPlan: gameInstance.blueTeamPlan ?? undefined,
            gameParticipations: {
              create: validParticipants,
            },
            season: { connect: { id: season.id } },
          },
          create: {
            id: gameId,
            finished: isFinished ?? false,
            startTime: startTime ?? new Date(),
            endTime: endTime ?? new Date(),
            settings: gameSettings,
            winner: (() => {
              if (gameWinner === "RED" || gameWinner === "BLUE") {
                return gameWinner as Team;
              }
              throw new Error(
                "Attempted to save a game without a winner (gameWinner was not RED/BLUE)."
              );
            })(),
            type: teamsDecidedBy as gameType | null,
            organiser: organiser ?? "Unknown",
            host: host ?? "Unknown",
            doubleElo: isDoubleElo,
            participantsIGNs: validParticipants.map(
              (p) => p.ignUsed ?? "UnknownIGN"
            ),
            redTeamPlan: gameInstance.redTeamPlan ?? undefined,
            blueTeamPlan: gameInstance.blueTeamPlan ?? undefined,
            gameParticipations: {
              create: validParticipants,
            },
            season: { connect: { id: season.id } },
          },
          include: {
            gameParticipations: true,
          },
        });

        const eloManager = new Elo();
        const currentGame = CurrentGameManager.getCurrentGame();

        const meanEloDifference = Math.abs(
          (gameInstance.blueMeanElo ?? 0) - (gameInstance.redMeanElo ?? 0)
        );
        if (meanEloDifference < 25) {
          console.log(
            `Mean Elo difference (${meanEloDifference}) < 25. Skipping weighting adjustments.`
          );
        } else {
          console.log(
            `Mean Elo difference (${meanEloDifference}) >= 25. Applying weighting adjustments.`
          );
        }

        if (currentGame.isDoubleElo) {
          console.log("Double Elo is active this game!");
        }

        for (const playerInstance of [...teams.RED, ...teams.BLUE]) {
          eloManager.applyEloUpdate(playerInstance);

          const playerRecord = await prismaClient.player.byDiscordSnowflake(
            playerInstance.discordSnowflake
          );
          if (!playerRecord) continue;

          const pStats =
            await prismaClient.player.getPlayerStatsForCurrentSeason(
              playerRecord.id
            );
          await prismaClient.playerStats.update({
            where: {
              playerId_seasonId: {
                playerId: playerRecord.id,
                seasonId: pStats.seasonId,
              },
            },
            data: { elo: playerInstance.elo },
          });

          await prismaClient.eloHistory.create({
            data: {
              playerId: playerRecord.id,
              gameId: gameRecord.id,
              elo: playerInstance.elo,
              seasonId: season.id,
            },
          });
        }
        return gameRecord;
      },
    },
  },
});
