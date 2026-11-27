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
import { escapeIgn } from "../util/Utils";
import { discordErrorCode, isUnknownMessage } from "../util/DiscordFailures";
import { Prisma, SeasonType } from "@prisma/client";

type LeaderboardSession = {
  currentPage: number;
  messageId?: string;
  seasonNumber?: number;
  expiresAt: number;
  busy: boolean;
};

type NavigationState = {
  startedAt: number;
  busy: boolean;
};

const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 1_000;
const NAVIGATION_INTERVAL_MS = 500;

export default class LeaderboardsCommand implements Command {
  public data: SlashCommandOptionsOnlyBuilder;
  public name = "leaderboards";
  public description = "Get leaderboards for the top-rated players";
  public buttonIds: string[] = ["leaderboard_prev", "leaderboard_next"];
  private readonly pageSize = 10;
  private readonly userStates = new Map<string, LeaderboardSession>();
  private readonly navigationByUser = new Map<string, NavigationState>();
  private nextNavigationCleanupAt = 0;

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

  private startSession(
    key: string,
    seasonNumber?: number
  ): LeaderboardSession | undefined {
    const now = Date.now();
    this.pruneNavigation(now);
    for (const [id, session] of this.userStates) {
      if (session.expiresAt <= now) this.userStates.delete(id);
    }
    this.userStates.delete(key);
    if (this.userStates.size >= MAX_SESSIONS) {
      for (const [id, session] of this.userStates) {
        if (!session.busy) {
          this.userStates.delete(id);
          break;
        }
      }
      if (this.userStates.size >= MAX_SESSIONS) return undefined;
    }
    const session: LeaderboardSession = {
      currentPage: 0,
      seasonNumber,
      expiresAt: now + SESSION_TTL_MS,
      busy: true,
    };
    this.userStates.set(key, session);
    return session;
  }

  private isCurrentSession(
    key: string,
    session: LeaderboardSession,
    now = Date.now()
  ): boolean {
    if (this.userStates.get(key) !== session) return false;
    if (session.expiresAt <= now) {
      this.userStates.delete(key);
      return false;
    }
    return true;
  }

  private refreshSession(key: string, session: LeaderboardSession): boolean {
    const now = Date.now();
    if (!this.isCurrentSession(key, session, now)) return false;
    session.expiresAt = now + SESSION_TTL_MS;
    this.userStates.delete(key);
    this.userStates.set(key, session);
    return true;
  }

  private pruneNavigation(now: number): void {
    if (now < this.nextNavigationCleanupAt) return;
    this.nextNavigationCleanupAt = now + NAVIGATION_INTERVAL_MS;
    for (const [userId, state] of this.navigationByUser) {
      if (!state.busy && now - state.startedAt >= NAVIGATION_INTERVAL_MS) {
        this.navigationByUser.delete(userId);
      }
    }
  }

  private async replyNavigation(
    interaction: ButtonInteraction,
    content: string
  ): Promise<void> {
    try {
      const response = { content, flags: MessageFlags.Ephemeral as const };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(response);
      } else {
        await interaction.reply(response);
      }
    } catch (error) {
      // The generic handler would edit the public source message after deferUpdate.
      console.warn(
        `Failed to respond to leaderboard navigation code=${discordErrorCode(error) ?? "other"}`
      );
    }
  }

  private async clearObsoleteControls(
    interaction: ChatInputCommandInteraction | ButtonInteraction
  ): Promise<void> {
    try {
      await interaction.editReply({ components: [] });
    } catch (error) {
      if (!isUnknownMessage(error)) {
        console.warn(
          `Failed to clear obsolete leaderboard controls code=${discordErrorCode(error) ?? "other"}`
        );
      }
    }
  }

  removeMessageSession(messageId: string): void {
    for (const [key, session] of this.userStates) {
      if (session.messageId === messageId) this.userStates.delete(key);
    }
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
    const season = seasonNumberArg !== undefined
      ? await prismaClient.season.findUnique({
          where: { number: seasonNumberArg },
        })
      : await SeasonService.requireActiveSeason();
    if (!season)
      throw new Error(
        `Season #${seasonNumberArg} not found. Is this an alternate timeline?`
      );
    const seasonNumber = seasonNumberArg ?? season.number;

    const ranked = season.type !== SeasonType.RELAXED;
    const where = { seasonId: season.id };
    const orderBy: Prisma.PlayerStatsOrderByWithRelationInput[] = ranked
      ? [{ elo: "desc" }, { id: "asc" }]
      : [{ wins: "desc" }, { biggestWinStreak: "desc" }, { id: "asc" }];
    // Read count, page and personal rank together rather than mixing snapshots
    // during an Elo correction. Only ten player identities are loaded per page.
    const { paginatedStats, totalPages, currentPlace } =
      await prismaClient.$transaction(async (tx) => {
        const totalPlayers = await tx.playerStats.count({ where });
        const totalPages = Math.max(1, Math.ceil(totalPlayers / this.pageSize));
        page = Math.max(0, Math.min(page, totalPages - 1));
        const paginatedStats = await tx.playerStats.findMany({
          where,
          orderBy,
          skip: page * this.pageSize,
          take: this.pageSize,
          select: {
            elo: true,
            wins: true,
            losses: true,
            winStreak: true,
            loseStreak: true,
            player: { select: { latestIGN: true, discordSnowflake: true } },
          },
        });
        let currentPlace = -1;
        if (ranked && totalPlayers > 0) {
          const visible = paginatedStats.findIndex(
            (stats) => stats.player?.discordSnowflake === userId
          );
          if (visible >= 0) {
            currentPlace = page * this.pageSize + visible;
          } else {
            const player = await tx.player.findUnique({
              where: { discordSnowflake: userId },
              select: { id: true },
            });
            const own = player && (await tx.playerStats.findUnique({
              where: {
                playerId_seasonId: { playerId: player.id, seasonId: season.id },
              },
              select: { id: true, elo: true },
            }));
            if (own) {
              currentPlace = await tx.playerStats.count({
                where: {
                  ...where,
                  OR: [
                    { elo: { gt: own.elo } },
                    { elo: own.elo, id: { lt: own.id } },
                  ],
                },
              });
            }
          }
        }
        return { paginatedStats, totalPages, currentPlace };
      });

    const topTen = paginatedStats.map((stats, index) => ({
      rank: page * this.pageSize + index + 1,
      ign: stats.player?.latestIGN ?? "Unknown Player",
      elo: stats.elo,
      wins: stats.wins,
      losses: stats.losses,
      winLossRatio: stats.losses > 0 ? stats.wins / stats.losses : stats.wins,
      winStreak: stats.winStreak,
      loseStreak: stats.loseStreak,
    }));

    const embed = new EmbedBuilder()
      .setColor(season.type !== SeasonType.RELAXED ? "#FFD700" : "#57F287")
      .setTitle(
        season.type !== SeasonType.RELAXED
          ? "🏆 Friendly Wars Leaderboards 🏆"
          : "🎉 Friendly Wars Activity Board"
      )
      .setDescription(
        season.type !== SeasonType.RELAXED
          ? `The top rated players for Season ${seasonNumber}!`
          : `Season ${seasonNumber} is Relaxed and has no Elo ranking or overall winner.`
      )
      .setTimestamp();

    topTen.forEach((p) => {
      embed.addFields({
        name:
          season.type !== SeasonType.RELAXED
            ? this.getLeaderboardEntryString(
                p.rank,
                p.ign,
                p.elo,
                p.winLossRatio,
                p.wins,
                p.losses,
                p.winStreak,
                p.loseStreak
              )
            : `**${escapeIgn(p.ign)}** — ${p.wins + p.losses} games`,
        value:
          season.type !== SeasonType.RELAXED
            ? "\u200b"
            : `${p.wins} wins • ${p.losses} losses • current streak ${p.winStreak}`,
        inline: false,
      });
    });

    embed.setFooter({
      text:
        season.type !== SeasonType.RELAXED
          ? `Your ranking: ${currentPlace === -1 ? "Unranked" : "#" + (currentPlace + 1).toLocaleString()} | Page ${page + 1}/${totalPages}`
          : `Unranked activity • Page ${page + 1}/${totalPages}`,
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
    const userId = interaction.user.id;
    const key = `${userId}-${interaction.channelId}`;
    const seasonNumber = interaction.options.getInteger("season") ?? undefined;
    const session = this.startSession(key, seasonNumber);
    if (!session) {
      await interaction.reply({
        content: "Leaderboards are busy. Please try again shortly.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      const response = await interaction.deferReply({ withResponse: true });
      // Bind the deferred message before publishing controls, so a delete
      // event arriving during the edit can invalidate this exact session.
      session.messageId =
        response.interaction.responseMessageId ??
        response.resource?.message?.id ??
        (await interaction.fetchReply()).id;
      const { embed, page, totalPages } = await this.generateLeaderboardEmbed(
        0,
        userId,
        seasonNumber
      );
      const publishControls = this.isCurrentSession(key, session);
      const leaderboardMessage = await interaction.editReply({
        embeds: [embed],
        components: publishControls
          ? [this.generateButtons(page, totalPages)]
          : [],
      });
      if (this.refreshSession(key, session)) {
        session.currentPage = page;
        session.busy = false;
      } else if (publishControls) {
        await this.clearObsoleteControls(interaction);
      }

      if (interaction.channelId !== Channels.botCommands.id && leaderboardMessage.id) {
        const messageId = leaderboardMessage.id;
        const channel = interaction.channel;
        const timer = setTimeout(async () => {
          try {
            if (!channel || !("messages" in channel)) return;
            const message = await channel.messages.fetch(messageId);
            if (message) await message.delete();
            this.removeMessageSession(messageId);
          } catch (error) {
            if (isUnknownMessage(error)) this.removeMessageSession(messageId);
            else console.error(
              `Failed to delete leaderboard message code=${discordErrorCode(error) ?? "other"}`
            );
          }
        }, 2 * 60_000);
        timer.unref?.();
      }
    } catch (error) {
      if (this.userStates.get(key) === session) this.userStates.delete(key);
      console.error(`Error fetching leaderboards code=${discordErrorCode(error) ?? "other"}`);
      if (isUnknownMessage(error)) return;
      const content =
        error instanceof Error &&
        (error.message === "No active season found. Use /season start first." ||
          error.message === `Season #${seasonNumber} not found. Is this an alternate timeline?`)
          ? `❌ ${error.message}`
          : "❌ An error occurred while fetching the leaderboards. Please try again later.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content, embeds: [], components: [] });
      } else {
        await interaction.reply({ content });
      }
    }
  }

  isOwnedNavigation(interaction: ButtonInteraction): boolean {
    const session = this.userStates.get(
      `${interaction.user.id}-${interaction.channelId}`
    );
    return (
      this.buttonIds.includes(interaction.customId) &&
      !!session &&
      session.expiresAt > Date.now() &&
      session.messageId === interaction.message.id
    );
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    const userId = interaction.user.id;
    const key = `${userId}-${interaction.channelId}`;
    const session = this.userStates.get(key);
    if (
      !session ||
      !this.isCurrentSession(key, session) ||
      session.messageId !== interaction.message.id
    ) {
      await this.replyNavigation(
        interaction,
        "❌ This leaderboard is expired or belongs to someone else. Use /leaderboards to open yours."
      );
      return;
    }

    const now = Date.now();
    this.pruneNavigation(now);
    const previous = this.navigationByUser.get(userId);
    if (session.busy || previous?.busy) {
      await this.replyNavigation(
        interaction,
        "Please wait for the current leaderboard update."
      );
      return;
    }
    if (
      !this.buttonIds.includes(interaction.customId) ||
      (previous && now - previous.startedAt < NAVIGATION_INTERVAL_MS)
    ) {
      // Ignore rapid duplicate clicks without starting a query or showing a cooldown.
      try {
        await interaction.deferUpdate();
      } catch (error) {
        console.warn(
          `Failed to acknowledge leaderboard navigation code=${discordErrorCode(error) ?? "other"}`
        );
      }
      return;
    }

    // Keep the lock independent of session replacement or channel changes.
    const navigation = { startedAt: now, busy: true };
    this.navigationByUser.set(userId, navigation);
    session.busy = true;
    try {
      await interaction.deferUpdate();
      if (!this.isCurrentSession(key, session)) {
        await this.replyNavigation(
          interaction,
          "This leaderboard is no longer active. Use /leaderboards to open yours."
        );
        return;
      }
      const requestedPage =
        session.currentPage +
        (interaction.customId === "leaderboard_next" ? 1 : -1);
      const { embed, page, totalPages } = await this.generateLeaderboardEmbed(
        requestedPage,
        userId,
        session.seasonNumber
      );
      if (!this.isCurrentSession(key, session)) {
        await this.replyNavigation(
          interaction,
          "This leaderboard is no longer active. Use /leaderboards to open yours."
        );
        return;
      }
      await interaction.editReply({
        embeds: [embed],
        components: [this.generateButtons(page, totalPages)],
      });
      if (!this.refreshSession(key, session)) {
        await this.clearObsoleteControls(interaction);
        return;
      }
      session.currentPage = page;
    } catch (error) {
      console.error(
        `Error updating leaderboard code=${discordErrorCode(error) ?? "other"}`
      );
      if (isUnknownMessage(error)) {
        this.removeMessageSession(interaction.message.id);
      }
      await this.replyNavigation(
        interaction,
        "❌ Failed to update leaderboard. Please try again."
      );
    } finally {
      session.busy = false;
      navigation.busy = false;
      if (Date.now() - navigation.startedAt >= NAVIGATION_INTERVAL_MS) {
        this.navigationByUser.delete(userId);
      }
    }
  }
}
