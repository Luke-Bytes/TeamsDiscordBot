import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { prismaClient } from "../database/prismaClient.js";
import { Channels } from "../Channels";

export default class SeasonCommand implements Command {
  public name = "season";
  public description = "Display stats for a given season.";
  public data: SlashCommandOptionsOnlyBuilder;
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addIntegerOption((option) =>
        option
          .setName("number")
          .setDescription("Season number to view")
          .setRequired(false)
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const seasonNumber = interaction.options.getInteger("number", false);
    const season = seasonNumber
      ? await prismaClient.season.findUnique({
          where: { number: seasonNumber },
        })
      : await prismaClient.season.findFirst({
          where: { isActive: true },
          orderBy: { number: "desc" },
        });

    if (!season) {
      await interaction.editReply(
        `Season ${seasonNumber} not found. Are you referring to a parallel universe?`
      );
      return;
    }

    const [games, participations] = await Promise.all([
      prismaClient.game.findMany({ where: { seasonId: season.id } }),
      prismaClient.gameParticipation.findMany({
        where: { seasonId: season.id },
      }),
    ]);

    const uniquePlayerIds = new Set(participations.map((p) => p.playerId));
    const gameParticipationCounts = games.map(
      (game) => participations.filter((p) => p.gameId === game.id).length
    );
    const maxPlayersInGame = Math.max(...gameParticipationCounts, 0);
    const firstGameDate = games.length
      ? new Date(Math.min(...games.map((g) => g.startTime.getTime())))
      : null;
    const lastGameDate = games.length
      ? new Date(Math.max(...games.map((g) => g.endTime.getTime())))
      : null;

    const duration =
      firstGameDate && lastGameDate
        ? (() => {
            const months =
              (lastGameDate.getFullYear() - firstGameDate.getFullYear()) * 12 +
              (lastGameDate.getMonth() - firstGameDate.getMonth());
            const days = lastGameDate.getDate() - firstGameDate.getDate();
            return `${months} months, ${days >= 0 ? days : days + 30} days`;
          })()
        : "N/A";

    const embed = new EmbedBuilder()
      .setTitle(`📅 Season ${season.number} Stats`)
      .addFields(
        {
          name: "First Game",
          value: firstGameDate?.toLocaleDateString() || "N/A",
          inline: true,
        },
        {
          name: "Last Game",
          value: lastGameDate?.toLocaleDateString() || "N/A",
          inline: true,
        },
        { name: "Duration", value: duration, inline: true },
        { name: "Total Games", value: games.length.toString(), inline: true },
        {
          name: "Total Unique Players",
          value: uniquePlayerIds.size.toString(),
          inline: true,
        },
        {
          name: "Most Players in a Game",
          value: maxPlayersInGame.toString(),
          inline: true,
        }
      )
      .setColor("Blue")
      .setFooter({
        text: `Requested by ${interaction.user.tag}`,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    const msg = await interaction.editReply({ embeds: [embed] });

    if (interaction.channelId !== Channels.botCommands.id) {
      setTimeout(() => msg.delete().catch(() => {}), 120_000);
    }
  }
}
