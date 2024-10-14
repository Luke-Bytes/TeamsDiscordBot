import { Snowflake, Team } from "discord.js";
import { prismaClient } from "./prismaClient";
import { Player } from "@prisma/client";
import { TeamsGame } from "./TeamsGame";

// wrapper class for Player
// todo bad naming
export class TeamsPlayer {
  playerId: string;

  elo: number;
  wins: number;
  losses: number;
  discordSnowflake: string;
  minecraftAccounts: string[];
  primaryMinecraftAccount?: string;

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
  }

  public static async byDiscordSnowflake(discordSnowflake: Snowflake) {
    let player = await prismaClient.player.byDiscordSnowflake(discordSnowflake);

    if (player) return new TeamsPlayer(player);

    return new TeamsPlayer(
      await prismaClient.player.create({
        data: {
          discordSnowflake: discordSnowflake,
        },
      })
    );
  }

  public static async byMinecraftAccount(minecraftAccount: string) {}
}