import { Snowflake, Team } from "discord.js";
import { prismaClient } from "./prismaClient";
import { Player } from "@prisma/client";
import { TeamsGame } from "./TeamsGame";

// wrapper class for Player
// todo bad naming
export class TeamsPlayer {
  elo: number;
  wins: number;
  losses: number;
  discordSnowflake: string;
  minecraftAccounts: string[];
  primaryMinecraftAccount?: string;

  ignUsed?: string; //in the in-memory game.

  constructor(data: Player) {
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

  public async addMcAccount(ign: string) {
    let player = await prismaClient.player.findFirst({
      where: {
        id: this.playerId,
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

      this.data = await prismaClient.player.update({
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
  }
}
