import { Snowflake } from "discord.js";
import { prismaClient } from "./prismaClient";
import { Player, PlayerStats } from "@prisma/client";
import { ConfigManager } from "../ConfigManager";

// wrapper class for Player
export class PlayerInstance {
  playerId: string;

  // season based fields from PlayerStats
  elo: number;
  wins: number;
  losses: number;
  winStreak: number;
  loseStreak: number;
  biggestWinStreak: number;
  biggestLosingStreak: number;

  // persistent Player fields
  discordSnowflake: string;
  minecraftAccounts: string[];
  primaryMinecraftAccount?: string;
  latestIGN?: string;

  // used in memory during a game
  ignUsed?: string;
  captain?: boolean;
  draftSlotPlacement?: number;

  constructor(player: Player, stats: PlayerStats) {
    this.playerId = player.id;

    // Fill from PlayerStats
    this.elo = stats.elo;
    this.wins = stats.wins;
    this.losses = stats.losses;
    this.winStreak = stats.winStreak;
    this.loseStreak = stats.loseStreak;
    this.biggestWinStreak = stats.biggestWinStreak;
    this.biggestLosingStreak = stats.biggestLosingStreak;

    // Fill from Player (persistent data)
    this.discordSnowflake = player.discordSnowflake;
    this.minecraftAccounts = player.minecraftAccounts;
    this.primaryMinecraftAccount = player.primaryMinecraftAccount ?? undefined;
    this.latestIGN = player.latestIGN ?? undefined;
  }

  public static async byDiscordSnowflake(discordSnowflake: Snowflake) {
    let player = await prismaClient.player.byDiscordSnowflake(discordSnowflake);

    if (!player) {
      player = await prismaClient.player.create({
        data: {
          discordSnowflake,
        },
      });
    }

    const config = ConfigManager.getConfig();
    const seasonNumber = config.season;

    const season = await prismaClient.season.findUnique({
      where: { number: seasonNumber },
    });
    if (!season) {
      throw new Error(
        `Season #${seasonNumber} does not exist. Please create it first.`
      );
    }

    let stats = await prismaClient.playerStats.findUnique({
      where: {
        playerId_seasonId: {
          playerId: player.id,
          seasonId: season.id,
        },
      },
    });

    if (!stats) {
      stats = await prismaClient.playerStats.create({
        data: {
          playerId: player.id,
          seasonId: season.id,
          elo: 1000,
          wins: 0,
          losses: 0,
          winStreak: 0,
          loseStreak: 0,
          biggestWinStreak: 0,
          biggestLosingStreak: 0,
        },
      });
    }

    return new PlayerInstance(player, stats);
  }

  public static async testValues(): Promise<PlayerInstance> {
    const playerCount = await prismaClient.player.count();

    const newPlayer = await prismaClient.player.create({
      data: {
        discordSnowflake: `testSnowflake${playerCount + 1}`,
        minecraftAccounts: [`Phi${playerCount + 1}`],
        latestIGN: `Phi${playerCount + 1}`,
      },
    });

    let testSeason = await prismaClient.season.findUnique({
      where: { number: 1 },
    });
    if (!testSeason) {
      testSeason = await prismaClient.season.create({
        data: {
          number: 1,
          name: "Season 1",
          startDate: new Date(),
        },
      });
    }

    const randomElo = Math.floor(Math.random() * (1500 - 800 + 1)) + 800;
    const randomWins = Math.floor(Math.random() * 21);
    const randomLosses = Math.floor(Math.random() * 21);
    const randomWinStreak = Math.floor(Math.random() * 11);
    const randomLoseStreak = Math.floor(Math.random() * 6);

    const newStats = await prismaClient.playerStats.create({
      data: {
        playerId: newPlayer.id,
        seasonId: testSeason.id,
        elo: randomElo,
        wins: randomWins,
        losses: randomLosses,
        winStreak: randomWinStreak,
        loseStreak: randomLoseStreak,
        biggestWinStreak: randomWinStreak,
        biggestLosingStreak: randomLoseStreak,
      },
    });

    const playerInstance = new PlayerInstance(newPlayer, newStats);
    playerInstance.ignUsed = `Rho${playerCount + 1}`;

    return playerInstance;
  }
}
