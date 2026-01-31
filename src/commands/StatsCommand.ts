import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { EloUtil } from "../util/EloUtil.js";
import { PrismaUtils } from "../util/PrismaUtils.js";
import { Channels } from "../Channels";
import { prismaClient } from "../database/prismaClient.js";
import { ConfigManager } from "../ConfigManager";
import { Team } from "@prisma/client";
import { escapeText } from "../util/Utils";

export default class StatsCommand implements Command {
  public name = "stats";
  public description = "Get the stats of yourself or another player";
  public data: SlashCommandOptionsOnlyBuilder;
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName("stats")
      .setDescription("Get the stats of yourself or another player.")
      .addStringOption((option) =>
        option
          .setName("player")
          .setDescription(
            "the player to fetch stats for, or blank for yourself"
          )
          .setRequired(false)
      )
      .addIntegerOption((option) =>
        option
          .setName("season")
          .setDescription(
            "the season number to fetch stats for (default: current season)"
          )
          .setRequired(false)
      )
      .addBooleanOption((option) =>
        option
          .setName("detailed")
          .setDescription("show all stats")
          .setRequired(false)
      );
  }
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const botCommandsChannelId = Channels.botCommands.id;

    let input = (
      interaction.options.getString("player", false) ?? interaction.user.id
    ).replace(/<@([^>]+)>/g, "$1");
    const player = await PrismaUtils.findPlayer(input);
    if (!player) {
      const msg = await interaction.editReply({ content: "Player not found." });
      setTimeout(() => msg.delete().catch(() => {}), 15_000);
      return;
    }

    const seasonNumber =
      interaction.options.getInteger("season") ??
      ConfigManager.getConfig().season;
    const season = await prismaClient.season.findUnique({
      where: { number: seasonNumber },
    });
    if (!season) {
      await interaction.editReply(
        `Season #${seasonNumber} not found. Are you a time traveller?`
      );
      return;
    }

    const stats = await prismaClient.playerStats.findUnique({
      where: {
        playerId_seasonId: { playerId: player.id, seasonId: season.id },
      },
    });
    if (!stats) {
      const msg = await interaction.editReply({
        content: "No stats found for this player in the current season.",
      });
      setTimeout(() => msg.delete().catch(() => {}), 15_000);
      return;
    }

    const detailed = interaction.options.getBoolean("detailed") ?? false;

    const wins = stats.wins,
      losses = stats.losses;
    const winLossRatio = losses === 0 ? wins : wins / losses;

    let fetchedMember = await interaction.guild?.members
      .fetch(player.discordSnowflake)
      .catch(() => null);
    let userDisplayName = player.minecraftAccounts
      .map((n) => escapeText(n))
      .join(", ");
    let avatarUrl: string | undefined;
    if (fetchedMember) {
      avatarUrl = fetchedMember.displayAvatarURL();
    } else {
      const fetchedUser = await interaction.client.users
        .fetch(player.discordSnowflake)
        .catch(() => null);
      if (fetchedUser) {
        userDisplayName = `${escapeText(fetchedUser.tag)} (${userDisplayName})`;
        avatarUrl = fetchedUser.displayAvatarURL();
      }
    }

    let winLossDisplay = winLossRatio.toFixed(2);
    if (wins > 0 && losses === 0) winLossDisplay += " 💯";
    let winStreakDisplay =
      stats.winStreak >= 3 ? `${stats.winStreak} 🔥` : `${stats.winStreak}`;

    const totalGames = wins + losses;
    const avgEloChange =
      totalGames > 0 ? ((stats.elo - 1000) / totalGames).toFixed(2) : "0.00";

    const [higherRankCount, totalPlayers] = await Promise.all([
      prismaClient.playerStats.count({
        where: { seasonId: season.id, elo: { gt: stats.elo } },
      }),
      prismaClient.playerStats.count({ where: { seasonId: season.id } }),
    ]);
    const seasonRank = higherRankCount + 1;
    const percentile =
      totalPlayers > 0
        ? (((totalPlayers - seasonRank) / totalPlayers) * 100).toFixed(1) + "%"
        : "0.0%";

    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("📊 Friendly Wars Stats")
      .setThumbnail(avatarUrl ?? null);

    if (detailed) {
      const [mvpCount, captainCount, captainWinCount, doubleEloWins, lastGP] =
        await Promise.all([
          prismaClient.gameParticipation.count({
            where: { playerId: player.id, seasonId: season.id, mvp: true },
          }),
          prismaClient.gameParticipation.count({
            where: { playerId: player.id, seasonId: season.id, captain: true },
          }),
          prismaClient.gameParticipation.count({
            where: {
              playerId: player.id,
              seasonId: season.id,
              captain: true,
              OR: [
                { team: Team.RED, game: { winner: Team.RED } },
                { team: Team.BLUE, game: { winner: Team.BLUE } },
              ],
            },
          }),
          prismaClient.gameParticipation.count({
            where: {
              playerId: player.id,
              seasonId: season.id,
              game: { doubleElo: true },
              OR: [
                { team: Team.RED, game: { winner: Team.RED } },
                { team: Team.BLUE, game: { winner: Team.BLUE } },
              ],
            },
          }),
          prismaClient.gameParticipation.findFirst({
            where: { playerId: player.id, seasonId: season.id },
            orderBy: { game: { endTime: "desc" } },
            include: { game: true },
          }),
        ]);

      const captainWinRate =
        captainCount > 0
          ? ((captainWinCount / captainCount) * 100).toFixed(1) + "%"
          : "N/A";
      const lastGameDate = lastGP?.game.endTime.toDateString() ?? "N/A";

      embed.addFields(
        { name: "Player", value: userDisplayName, inline: true },
        {
          name: "Elo",
          value: `${Math.round(stats.elo)} ${EloUtil.getEloEmoji(stats.elo)}`,
          inline: true,
        },
        {
          name: "Season Rank",
          value: `#${seasonRank}/${totalPlayers} (${percentile})`,
          inline: true,
        },
        { name: "Win/Loss Ratio", value: winLossDisplay, inline: true },
        { name: "Wins", value: `${wins}`, inline: true },
        { name: "Losses", value: `${losses}`, inline: true },
        { name: "Current Win Streak", value: winStreakDisplay, inline: true },
        {
          name: "Current Losing Streak",
          value: `${stats.loseStreak}`,
          inline: true,
        },
        {
          name: "Biggest Win Streak",
          value: `${stats.biggestWinStreak}`,
          inline: true,
        },
        {
          name: "Biggest Lose Streak",
          value: `${stats.biggestLosingStreak}`,
          inline: true,
        },
        { name: "MVP Count", value: `${mvpCount}`, inline: true },
        { name: "Captain Count", value: `${captainCount}`, inline: true },
        { name: "Captain Win Rate", value: captainWinRate, inline: true },
        { name: "Double Elo Wins", value: `${doubleEloWins}`, inline: true },
        { name: "Average Elo Change", value: avgEloChange, inline: true },
        { name: "Last Game Date", value: lastGameDate, inline: true }
      );
    } else {
      const winRate =
        totalGames > 0 ? ((wins / totalGames) * 100).toFixed(1) + "%" : "0.0%";
      const winsLabel = wins === 1 ? "Win" : "Wins";
      const lossesLabel = losses === 1 ? "Loss" : "Losses";
      const currentStreak =
        stats.winStreak > 0
          ? `${stats.winStreak} ${stats.winStreak === 1 ? "Win" : "Wins"}${stats.winStreak >= 3 ? " 🔥" : ""}`
          : stats.loseStreak > 0
            ? `${stats.loseStreak} ${stats.loseStreak === 1 ? "Loss" : "Losses"}`
            : "—";

      embed.addFields(
        { name: "Player", value: userDisplayName, inline: true },
        {
          name: "Elo",
          value: `${Math.round(stats.elo)} ${EloUtil.getEloEmoji(stats.elo)}`,
          inline: true,
        },
        {
          name: "Season Rank",
          value: `#${seasonRank}/${totalPlayers} (${percentile})`,
          inline: true,
        },
        {
          name: "Win/Loss Record",
          value: `${wins} ${winsLabel} - ${losses} ${lossesLabel}`,
          inline: true,
        },
        { name: "Win Rate", value: winRate, inline: true },
        { name: "Current Streak", value: currentStreak, inline: true }
      );
    }

    embed
      .setFooter({
        text: `Requested by ${interaction.user.tag} | Season ${seasonNumber}`,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTimestamp();

    const msg = await interaction.editReply({ embeds: [embed] });
    if (interaction.channelId !== botCommandsChannelId) {
      setTimeout(() => msg.delete().catch(() => {}), 120_000);
    }
  }
}
