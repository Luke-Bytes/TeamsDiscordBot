import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { EloUtil } from "../util/EloUtil";
import { prismaClient } from "../database/prismaClient";
import { Channels } from "../Channels";
import { ConfigManager } from "../ConfigManager";

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
      const botCommandsChannelId = Channels.botCommands.id;
      const config = ConfigManager.getConfig();
      const seasonNumber = config.season;

      const season = await prismaClient.season.findUnique({
        where: { number: seasonNumber },
      });
      if (!season) {
        throw new Error(`Season #${seasonNumber} not found!`);
      }

      const topTenStats = await prismaClient.playerStats.findMany({
        where: {
          seasonId: season.id,
        },
        orderBy: { elo: "desc" },
        take: 10,
        include: {
          player: {
            select: {
              latestIGN: true,
              discordSnowflake: true,
            },
          },
        },
      });

      const filteredTopTenStats = topTenStats.filter(
        (stats) => stats.player !== null
      );

      const topTen = filteredTopTenStats.map((stats, index) => {
        const wins = stats.wins;
        const losses = stats.losses;
        return {
          rank: index + 1,
          ign: stats.player?.latestIGN ?? "Unknown Player",
          elo: stats.elo,
          wins,
          losses,
          winLossRatio: losses > 0 ? wins / losses : wins,
          discordSnowflake: stats.player?.discordSnowflake ?? "N/A",
        };
      });
      const allStats = await prismaClient.playerStats.findMany({
        where: { seasonId: season.id },
        orderBy: { elo: "desc" },
        include: { player: { select: { discordSnowflake: true } } },
      });
      const currentPlace = allStats.findIndex(
        (s) => s.player?.discordSnowflake === interaction.user.id
      );

      const embed = new EmbedBuilder()
        .setColor("#FFD700")
        .setTitle("🏆 Friendly Wars Leaderboards 🏆")
        .setDescription(`The top-rated players for Season ${seasonNumber}!`)
        .setTimestamp();

      topTen.forEach((p) => {
        embed.addFields({
          name: this.getLeaderboardEntryString(
            p.rank,
            p.ign,
            p.elo,
            p.winLossRatio,
            p.wins,
            p.losses
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

      const msg = await interaction.reply({
        embeds: [embed],
        fetchReply: true,
      });

      if (interaction.channelId !== botCommandsChannelId) {
        setTimeout(
          async () => {
            try {
              await msg.delete();
            } catch (error) {
              console.error("Failed to delete leaderboards message:", error);
            }
          },
          2 * 60 * 1000
        );
      }
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
