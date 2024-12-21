import { Snowflake } from "discord.js";
import { prismaClient } from "./prismaClient.js";
import { Player } from "@prisma/client";
import { MojangAPI } from "api/MojangAPI";

// wrapper class for Player
export class PlayerInstance {
  playerId: string;
  elo: number;
  wins: number;
  losses: number;
  discordSnowflake: string;
  minecraftAccounts: string[];
  primaryMinecraftAccount?: string;
  latestIGN?: string;

  ignUsed?: string; //in the in-memory game.
  captain?: boolean;

  constructor(data: Player) {
    this.playerId = data.id;
    this.elo = data.elo;
    this.wins = data.wins;
    this.losses = data.losses;
    this.discordSnowflake = data.discordSnowflake;
    this.minecraftAccounts = data.minecraftAccounts;
    this.primaryMinecraftAccount = data.primaryMinecraftAccount ?? undefined;
    this.latestIGN = data.latestIGN ?? undefined;
  }

  public static async byDiscordSnowflake(discordSnowflake: Snowflake) {
    let player = await prismaClient.player.byDiscordSnowflake(discordSnowflake);

    if (player) return new PlayerInstance(player);

    return new PlayerInstance(
      await prismaClient.player.create({
        data: {
          discordSnowflake: discordSnowflake,
        },
      })
    );
  }

  public static async byMinecraftAccount(minecraftAccount: string) {}

  public static async testValues(): Promise<PlayerInstance> {
    const playerCount = await prismaClient.player.count();

    const randomElo = Math.floor(Math.random() * (1500 - 800 + 1)) + 800;
    const randomWins = Math.floor(Math.random() * 21);
    const randomLosses = Math.floor(Math.random() * 21);

    const newPlayer = await prismaClient.player.create({
      data: {
        discordSnowflake: `testSnowflake${playerCount + 1}`,
        elo: randomElo,
        wins: randomWins,
        losses: randomLosses,
        minecraftAccounts: [`Phi${playerCount + 1}`],
      },
    });

    const playerInstance = new PlayerInstance(newPlayer);
    playerInstance.ignUsed = `Rho${playerCount + 1}`;
    return playerInstance;
  }
}
