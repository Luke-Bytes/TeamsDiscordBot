import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ButtonInteraction,
  SlashCommandOptionsOnlyBuilder,
  MessageFlags,
} from "discord.js";
import { Command } from "./CommandInterface";
import { EloUtil } from "../util/EloUtil";
import { prismaClient } from "../database/prismaClient";
import { Channels } from "../Channels";
import { SeasonService } from "../database/SeasonService";
import { DiscordUtil } from "../util/DiscordUtil";
import { escapeIgn } from "../util/Utils";

export default class LeaderboardsCommand implements Command {
  public data: SlashCommandOptionsOnlyBuilder;
  public name = "leaderboards";
  public description = "Get leaderboards for the top-rated players";
  public buttonIds: string[] = ["leaderboard_prev", "leaderboard_next"];
  private readonly pageSize = 10;
  private readonly userStates = new Map<
    string,
    { currentPage: number; messageId?: string; seasonNumber?: number }
  >();

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addIntegerOption((opt) =>
        opt
          .setName("season")
          .setDescription("Season number to display")
          .setRequired(false)
      );
  }

  private getUserState(userId: string, channelId: string) {
    const key = `${userId}-${channelId}`;
    if (!this.userStates.has(key)) {
      this.userStates.set(key, { currentPage: 0, messageId: undefined });
    }
    return this.userStates.get(key)!;
  }

  private getLeaderboardEntryString(
    rank: number,
    ign: string,
    elo: number,
    winLossRatio: number,
    wins: number,
    losses: number,
    winStreak: number,
    loseStreak: number
  ): string {
    ign = escapeIgn(ign);
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
    const rankDisplay = rank <= 10 ? rankEmojis[rank - 1] : `#${rank}`;
    const eloEmoji = EloUtil.getEloEmoji(elo);
    let winLossDisplay = winLossRatio.toFixed(1);
    let extraEmojis = "";

    if (wins > 0 && losses === 0) extraEmojis += " 💯";
    if (winStreak >= 3) extraEmojis += " 🔥";
    if (loseStreak >= 3) extraEmojis += " 😢";

    return `${rankDisplay} **${ign}** ${eloEmoji} ─ ${Math.round(elo)} | W/L: ${winLossDisplay}${extraEmojis}`;
  }

  private async generateLeaderboardEmbed(
    page: number,
    userId: string,
    seasonNumberArg?: number
  ) {
    const season = seasonNumberArg
      ? await prismaClient.season.findUnique({
          where: { number: seasonNumberArg },
        })
      : await SeasonService.requireActiveSeason();
    if (!season)
      throw new Error(
        `Season #${seasonNumberArg} not found. Is this an alternate timeline?`
      );
    const seasonNumber = seasonNumberArg ?? season.number;

    const allStats = await prismaClient.playerStats.findMany({
      where: { seasonId: season.id },
      orderBy: { elo: "desc" },
      include: {
        player: { select: { latestIGN: true, discordSnowflake: true } },
      },
    });

    const totalPlayers = allStats.length;
    const totalPages = Math.ceil(totalPlayers / this.pageSize);
    page = Math.max(0, Math.min(page, totalPages - 1));

    const paginatedStats = allStats.slice(
      page * this.pageSize,
      (page + 1) * this.pageSize
    );

    const topTen = paginatedStats.map((stats, index) => ({
      rank: page * this.pageSize + index + 1,
      ign: stats.player?.latestIGN ?? "Unknown Player",
      elo: stats.elo,
      wins: stats.wins,
      losses: stats.losses,
      winLossRatio: stats.losses > 0 ? stats.wins / stats.losses : stats.wins,
      discordSnowflake: stats.player?.discordSnowflake ?? "N/A",
      winStreak: stats.winStreak,
      loseStreak: stats.loseStreak,
    }));

    const currentPlace = allStats.findIndex(
      (s) => s.player?.discordSnowflake === userId
    );

    const embed = new EmbedBuilder()
      .setColor("#FFD700")
      .setTitle("🏆 Friendly Wars Leaderboards 🏆")
      .setDescription(`The top rated players for Season ${seasonNumber}!`)
      .setTimestamp();

    topTen.forEach((p) => {
      embed.addFields({
        name: this.getLeaderboardEntryString(
          p.rank,
          p.ign,
          p.elo,
          p.winLossRatio,
          p.wins,
          p.losses,
          p.winStreak,
          p.loseStreak
        ),
        value: "\u200b",
        inline: false,
      });
    });

    embed.setFooter({
      text: `Your ranking: ${currentPlace === -1 ? "Unranked" : "#" + (currentPlace + 1).toLocaleString()} | Page ${page + 1}/${totalPages}`,
      iconURL: `https://cdn.discordapp.com/avatars/${userId}/.png`,
    });

    return { embed, page, totalPages };
  }

  private generateButtons(page: number, totalPages: number) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("leaderboard_prev")
        .setLabel("⬅")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId("leaderboard_next")
        .setLabel("➡")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page >= totalPages - 1)
    );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const botCommandsChannelId = Channels.botCommands.id;
      const userId = interaction.user.id;
      const channelId = interaction.channelId;

      const userState = this.getUserState(userId, channelId);
      userState.currentPage = 0;

      const seasonNumber =
        interaction.options.getInteger("season") ?? undefined;
      userState.currentPage = 0;
      userState.seasonNumber = seasonNumber;

      const { embed, totalPages } = await this.generateLeaderboardEmbed(
        userState.currentPage,
        userId,
        seasonNumber
      );
      const buttons = this.generateButtons(userState.currentPage, totalPages);

      const leaderboardMessage = await DiscordUtil.replyWithMessage(
        interaction,
        {
          embeds: [embed],
          components: [buttons],
        }
      );
      userState.messageId = leaderboardMessage?.id;

      if (interaction.channelId !== botCommandsChannelId) {
        setTimeout(
          async () => {
            try {
              const channel = interaction.channel;
              if (!channel || !userState.messageId) return;

              const message = await channel.messages
                .fetch(userState.messageId)
                .catch(() => null);
              if (message) {
                await message.delete();
              }
            } catch (error) {
              console.error("Failed to delete leaderboards message:", error);
            }
          },
          2 * 60 * 1000
        );
      }
    } catch (error) {
      console.error("Error fetching leaderboards:", error);
      if (!interaction.replied && !interaction.deferred) {
        const msg =
          error instanceof Error && error.message
            ? `❌ ${error.message}`
            : "❌ An error occurred while fetching the leaderboards. Please try again later.";
        await interaction.reply({ content: msg });
      }
    }
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;
    const userState = this.getUserState(userId, channelId);

    if (
      !userState.messageId ||
      interaction.message.id !== userState.messageId
    ) {
      await interaction.reply({
        content: "❌ You didn't summon this leaderboard embed!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.customId === "leaderboard_next") {
      userState.currentPage++;
    } else if (interaction.customId === "leaderboard_prev") {
      userState.currentPage = Math.max(0, userState.currentPage - 1);
    }

    try {
      const { embed, totalPages } = await this.generateLeaderboardEmbed(
        userState.currentPage,
        userId,
        userState.seasonNumber
      );

      await interaction.update({
        embeds: [embed],
        components: [this.generateButtons(userState.currentPage, totalPages)],
      });
    } catch (error) {
      console.error("❌ Error updating leaderboard:", error);
      const msg =
        error instanceof Error && error.message
          ? `❌ ${error.message}`
          : "❌ Failed to update leaderboard.";
      await interaction.reply({ content: msg });
    }
  }
}
