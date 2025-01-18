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
    rank: number,
    ign: string,
    elo: number,
    winLossRatio: number,
    wins: number,
    losses: number
  ): string {
    const rankEmojis = [
      "🥇",
      "🥈",
      "🥉",
      "4️⃣",
      "5️⃣",
      "6️⃣",
      "7️⃣",
      "8️⃣",
      "9️⃣",
      "🔟",
    ];
    const rankEmoji = rankEmojis[rank - 1] || "🔢";
    const eloEmoji = EloUtil.getEloEmoji(elo);
    let winLossDisplay = winLossRatio.toFixed(1);
    if (wins > 0 && losses === 0) {
      winLossDisplay += " 🔥";
    }
    return `${rankEmoji} **${ign}** ${eloEmoji} ─ ${Math.round(elo)} | W/L: ${winLossDisplay}`;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const allPlayers = await prismaClient.player.findMany({
        orderBy: {
          elo: "desc",
        },
      });

      const topTen = allPlayers.slice(0, 10).map((playerData, index) => ({
        rank: index + 1,
        ign: playerData.latestIGN ?? "N/A",
        elo: playerData.elo,
        winLossRatio:
          playerData.losses > 0
            ? playerData.wins / playerData.losses
            : playerData.wins,
        wins: playerData.wins,
        losses: playerData.losses,
      }));

      const currentPlace = allPlayers.findIndex(
        (playerData) => playerData.discordSnowflake === interaction.user.id
      );

      const embed = new EmbedBuilder()
        .setColor("#FFD700")
        .setTitle("🏆 Friendly Wars Leaderboards 🏆")
        .setDescription("The top rated players this season!")
        // .setThumbnail("")
        .setTimestamp();

      topTen.forEach((player) => {
        embed.addFields({
          name: this.getLeaderboardEntryString(
            player.rank,
            player.ign,
            player.elo,
            player.winLossRatio,
            player.wins,
            player.losses
          ),
          value: "\u200b",
          inline: false,
        });
      });

      embed.setFooter({
        text: `Your ranking: ${
          currentPlace === -1
            ? "Unranked"
            : "#" + (currentPlace + 1).toLocaleString()
        }`,
        iconURL: interaction.user.displayAvatarURL(),
      });

      await interaction.reply({
        embeds: [embed],
      });
    } catch (error) {
      console.error("Error fetching leaderboards:", error);
      await interaction.reply({
        content:
          "❌ An error occurred while fetching the leaderboards. Please try again later.",
        ephemeral: true,
      });
    }
  }
}
