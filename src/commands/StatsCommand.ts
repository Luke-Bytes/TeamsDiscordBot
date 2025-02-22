import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { EloUtil } from "../util/EloUtil.js";
import { PrismaUtils } from "../util/PrismaUtils";
import { Channels } from "../Channels";
import { prismaClient } from "../database/prismaClient.js";
import { ConfigManager } from "../ConfigManager";

export default class StatsCommand implements Command {
  public name = "stats";
  public description = "Get the stats of yourself or another player";
  public data: SlashCommandBuilder;
  public buttonIds: string[] = [];

  constructor() {
    this.name = "stats";
    this.description = "Get the stats of yourself or another player.";

    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addStringOption((option) =>
        option
          .setName("player")
          .setDescription(
            "the player to fetch stats for, or blank for yourself"
          )
          .setRequired(false)
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({});
    const botCommandsChannelId = Channels.botCommands.id;

    let input =
      interaction.options.getString("player", false) ?? interaction.user.id;

    input = input.replace(/<@([^>]+)>/g, "$1");

    const player = await PrismaUtils.findPlayer(input);
    if (!player) {
      const notFoundMessage = await interaction.editReply({
        content: "Player not found.",
      });
      setTimeout(async () => {
        try {
          await notFoundMessage.delete();
        } catch (error) {
          console.error("Failed to delete notFoundMessage:", error);
        }
      }, 15 * 1000);
      return;
    }

    const config = ConfigManager.getConfig();
    const seasonNumber = config.season;
    const season = await prismaClient.season.findUnique({
      where: { number: seasonNumber },
    });
    if (!season) {
      await interaction.editReply(
        `No season with number=${seasonNumber} found. Please create it first.`
      );
      return;
    }

    const stats = await prismaClient.playerStats.findUnique({
      where: {
        playerId_seasonId: {
          playerId: player.id,
          seasonId: season.id,
        },
      },
    });

    if (!stats) {
      const noStatsMsg = await interaction.editReply({
        content: "No stats found for this player in the current season.",
      });
      setTimeout(async () => {
        try {
          await noStatsMsg.delete();
        } catch (error) {
          console.error("Failed to delete noStatsMsg:", error);
        }
      }, 15 * 1000);
      return;
    }

    const wins = stats.wins;
    const losses = stats.losses;
    const winLossRatio = losses === 0 ? wins : wins / losses;

    let fetchedPlayer =
      interaction.guild?.members.resolve(player.discordSnowflake) ||
      (await interaction.guild?.members
        .fetch(player.discordSnowflake)
        .catch(() => null));

    if (!fetchedPlayer) {
      const notFoundMessage = await interaction.editReply({
        content:
          "Discord member not found. (Maybe they're not in this server?)",
      });
      setTimeout(async () => {
        try {
          await notFoundMessage.delete();
        } catch (error) {
          console.error("Failed to delete notFoundMessage:", error);
        }
      }, 15 * 1000);
      return;
    }

    let winLossDisplay = winLossRatio.toFixed(2);
    if (stats.wins > 0 && stats.losses === 0) {
      winLossDisplay += " 💯";
    }

    let winStreakDisplay =
      stats.winStreak >= 3 ? `${stats.winStreak} 🔥` : stats.winStreak;

    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("📊 Friendly Wars Stats")
      .setDescription(`Current Season: ${seasonNumber}`)
      .setThumbnail(fetchedPlayer.displayAvatarURL())
      .addFields(
        {
          name: "Player",
          value: player.minecraftAccounts
            .map((name) => name.replace(/_/g, "\\_"))
            .join(", "),
          inline: true,
        },
        {
          name: "ELO",
          value: `${Math.round(stats.elo)} ${EloUtil.getEloEmoji(stats.elo)}`,
          inline: true,
        },
        {
          name: "Current Win Streak",
          value: `${winStreakDisplay}`,
          inline: true,
        },
        {
          name: "Wins",
          value: `${wins}`,
          inline: true,
        },
        {
          name: "Losses",
          value: `${losses}`,
          inline: true,
        },
        {
          name: "Win/Loss Ratio",
          value: `${winLossDisplay}`,
          inline: true,
        }
      )
      .setFooter({
        text: `Requested by ${interaction.user.tag}`,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTimestamp();

    const msg = await interaction.editReply({
      embeds: [embed],
    });

    if (interaction.channelId !== botCommandsChannelId) {
      setTimeout(
        async () => {
          try {
            await msg.delete();
          } catch (error) {
            console.error("Failed to delete stats message:", error);
          }
        },
        2 * 60 * 1000
      );
    }
  }
}
