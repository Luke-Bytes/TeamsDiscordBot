import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { EloUtil } from "../util/EloUtil";
import { prismaClient } from "../database/prismaClient";

export default class LeaderboardsCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "leaderboards";
  public description = "Get leaderboards for the top-rated players";
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description);
  }

  private getLeaderboardEntryString(
    ign: string,
    elo: number,
    emoji: string,
    winLossRatio: number
  ) {
    return `${emoji} ${ign} **[${elo} ${EloUtil.getEloEmoji(
      elo
    )}]** ${winLossRatio.toFixed(1)} W/L`;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const allPlayers = await prismaClient.player.findMany({
      orderBy: {
        elo: "desc",
      },
    });

    const topTen = allPlayers.slice(0, 10).map((playerData, i) => {
      const placeEmojis = [
        "first_place",
        "second_place",
        "third_place",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "keycap_ten",
      ];
      return {
        ign: playerData.primaryMinecraftAccount ?? "N/A",
        elo: playerData.elo,
        emoji: `:${placeEmojis[i]}:`,
        winLossRatio: playerData.wins / playerData.losses,
      };
    });

    const currentPlace = allPlayers.findIndex(
      (playerData) => playerData.discordSnowflake === interaction.user.id
    );

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Friendly Wars Leaderboards");
    for (let i = 0; i < 3 && topTen[i]; i++) {
      embed.addFields({
        name: this.getLeaderboardEntryString(
          topTen[i].ign,
          topTen[i].elo,
          topTen[i].emoji,
          topTen[i].winLossRatio
        ),
        value: " ",
        inline: false,
      });
    }
    embed.addFields({
      name: " ",
      value:
        topTen
          .slice(3)
          .map((v, i) => {
            return this.getLeaderboardEntryString(
              v.ign,
              v.elo,
              v.emoji,
              v.winLossRatio
            );
          })
          .join("\n") || " ",
      inline: false,
    });

    embed.setFooter({
      text: `Your ranking: ${
        currentPlace === -1
          ? "(Unranked)"
          : "#" + (currentPlace + 1).toLocaleString()
      }`,
    });

    await interaction.reply({
      embeds: [embed],
    });
  }
}
