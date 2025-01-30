import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
} from "discord.js";
import { Command } from "./CommandInterface";
import { EloUtil } from "../util/EloUtil";
import { prismaClient } from "../database/prismaClient";
import { Channels } from "../Channels";
import { Console } from "console";

export default class LeaderboardsCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "leaderboards";
  public description = "Get leaderboards for the top-rated players";
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addIntegerOption((option) =>
        option
          .setName("page")
          .setDescription(
            "the page number to view more players, or blank for the first page"
          )
          .setRequired(false)
      ) as SlashCommandBuilder;
  }

  private getLeaderboardEntryString(
    rank: number,
    ign: string,
    elo: number,
    winLossRatio: number,
    wins: number,
    losses: number,
    winStreak: number
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
    const rankEmoji = rank <= 10 ? rankEmojis[rank - 1] : `#${rank}`;
    const eloEmoji = EloUtil.getEloEmoji(elo);
    const winStreakEmoji = winStreak >= 3 ? " 🔥" : "";
    let winLossDisplay = winLossRatio.toFixed(1);
    if (wins > 0 && losses === 0) {
      winLossDisplay += " 💯";
    }
    return `${rankEmoji} **${ign}** ${eloEmoji} ─ ${elo}${winStreakEmoji} | W/L: ${winLossDisplay}`;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const botCommandsChannelId = Channels.botCommands.id;

      let page = interaction.options.getInteger("page", false) ?? 1;
      const pageIndex = (page - 1) * 10;

      const allPlayers = await prismaClient.player.findMany({
        orderBy: {
          elo: "desc",
        },
      });

      const topTen = allPlayers
        .slice(pageIndex, pageIndex + 10)
        .map((playerData, index) => ({
          rank: pageIndex + index + 1,
          ign: playerData.latestIGN ?? "N/A",
          elo: playerData.elo,
          winLossRatio:
            playerData.losses > 0
              ? playerData.wins / playerData.losses
              : playerData.wins,
          wins: playerData.wins,
          losses: playerData.losses,
          winStreak: playerData.winStreak,
        }));
      if (topTen.length === 0) {
        await interaction.reply({
          content: "❌ No players found.",
          ephemeral: true,
        });
        return;
      }
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
            player.losses,
            player.winStreak
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

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("prev-page")
          .setLabel("Prev Page ⏪")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page === 1),
        new ButtonBuilder()
          .setCustomId("next-page")
          .setLabel("Next Page ⏭️")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(pageIndex + 10 >= allPlayers.length)
      );

      const msg = await interaction.reply({
        embeds: [embed],
        components: [row],
        fetchReply: true,
      });

      if (interaction.channelId !== botCommandsChannelId) {
        setTimeout(
          async () => {
            await msg.delete();
          },
          2 * 60 * 1000
        ); // Delete after 2 minutes
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
