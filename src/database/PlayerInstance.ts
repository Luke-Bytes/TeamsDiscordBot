import { Snowflake } from "discord.js";
import { prismaClient } from "./prismaClient";
import { Player } from "@prisma/client";

// wrapper class for Player
// todo bad naming
export class PlayerInstance {
  private static instances: PlayerInstance[] = [];

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

    PlayerInstance.instances.push(this);
  }

  public static resetAll() {
    PlayerInstance.instances = [];
  }

  public static removePlayerInstance(instance: PlayerInstance) {
    PlayerInstance.instances = PlayerInstance.instances.filter(
      (i) => i !== instance
    );
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
}
