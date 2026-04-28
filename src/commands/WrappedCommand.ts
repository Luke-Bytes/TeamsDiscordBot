import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { SeasonService } from "../database/SeasonService";
import { PrismaUtils } from "../util/PrismaUtils";
import { generatePersonalSeasonWrapped } from "../logic/seasonRecap/PersonalSeasonWrapped";

export default class WrappedCommand implements Command {
  public name = "wrapped";
  public description = "Generate your personal season recap.";
  public buttonIds: string[] = [];
  public data: SlashCommandOptionsOnlyBuilder;

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addIntegerOption((option) =>
        option
          .setName("season")
          .setDescription(
            "Completed season to recap (default: previous season)"
          )
          .setRequired(false)
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const player = await PrismaUtils.findPlayer(interaction.user.id);
    if (!player) {
      await interaction.editReply("Player not found. Use /register first.");
      return;
    }

    const activeSeason = await SeasonService.getActiveSeasonNumber();
    const seasonNumber =
      interaction.options.getInteger("season") ?? activeSeason - 1;

    if (seasonNumber >= activeSeason) {
      await interaction.editReply(
        `Season ${activeSeason} is still active. Wrapped is only available for completed seasons.`
      );
      return;
    }

    if (seasonNumber < 1) {
      await interaction.editReply("No completed seasons are available yet.");
      return;
    }

    try {
      const wrapped = await generatePersonalSeasonWrapped({
        seasonNumber,
        playerId: player.id,
      });

      if (!wrapped) {
        await interaction.editReply(
          `No wrapped stats found for you in Season ${seasonNumber}.`
        );
        return;
      }

      const avatarUrl =
        interaction.member && "displayAvatarURL" in interaction.member
          ? interaction.member.displayAvatarURL()
          : interaction.user.displayAvatarURL();
      const embed = new EmbedBuilder()
        .setColor("#1DB954")
        .setTitle(wrapped.title)
        .setDescription(wrapped.description)
        .setThumbnail(avatarUrl)
        .addFields(wrapped.fields)
        .setFooter({
          text: wrapped.footer,
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        await interaction.editReply(`Season #${seasonNumber} not found.`);
        return;
      }
      throw error;
    }
  }
}
