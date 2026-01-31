import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PrismaUtils } from "../util/PrismaUtils";
import { prismaClient } from "../database/prismaClient";
import { escapeText } from "../util/Utils";
import {
  formatEnumList,
  LANGUAGE_LABELS,
  PLAYSTYLE_LABELS,
  PRONOUNS_LABELS,
  RANK_LABELS,
  REGION_LABELS,
  ROLE_LABELS,
} from "../util/ProfileUtil";

export default class ProfileCommand implements Command {
  public name = "profile";
  public description = "View a player profile";
  public buttonIds: string[] = [];
  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addStringOption((opt) =>
      opt
        .setName("name")
        .setDescription("Discord ID/mention or latest IGN")
        .setRequired(false)
    );

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const input = interaction.options.getString("name");
    const lookup = input ? input.replace(/<@([^>]+)>/g, "$1") : interaction.user.id;

    const player = await PrismaUtils.findPlayer(lookup);
    if (!player) {
      await interaction.reply({
        content: "Player not found.",
        ephemeral: true,
      });
      return;
    }

    const profile = await prismaClient.profile.findUnique({
      where: { playerId: player.id },
    });

    const displayName = player.latestIGN
      ? escapeText(player.latestIGN)
      : escapeText(player.discordSnowflake);

    const embed = new EmbedBuilder().setTitle(`Profile — ${displayName}`);

    if (player.latestIGN) {
      embed.addFields({
        name: "Minecraft IGN",
        value: escapeText(player.latestIGN),
        inline: true,
      });
    }

    if (profile?.preferredName) {
      embed.addFields({
        name: "Preferred Name",
        value: escapeText(profile.preferredName),
        inline: true,
      });
    }

    if (profile?.pronouns) {
      embed.addFields({
        name: "Pronouns",
        value: PRONOUNS_LABELS[profile.pronouns],
        inline: true,
      });
    }

    if (profile?.languages?.length) {
      embed.addFields({
        name: "Languages",
        value: formatEnumList(profile.languages, LANGUAGE_LABELS),
        inline: true,
      });
    }

    if (profile?.region) {
      embed.addFields({
        name: "Region",
        value: REGION_LABELS[profile.region],
        inline: true,
      });
    }

    if (profile?.rank) {
      embed.addFields({
        name: "Rank",
        value: RANK_LABELS[profile.rank],
        inline: true,
      });
    }

    if (profile?.preferredRoles?.length) {
      embed.addFields({
        name: "Preferred Roles",
        value: formatEnumList(profile.preferredRoles, ROLE_LABELS),
        inline: false,
      });
    }

    if (profile?.proficientAtRoles?.length) {
      embed.addFields({
        name: "Proficient At",
        value: formatEnumList(profile.proficientAtRoles, ROLE_LABELS),
        inline: false,
      });
    }

    if (profile?.improveRoles?.length) {
      embed.addFields({
        name: "Looking to Improve",
        value: formatEnumList(profile.improveRoles, ROLE_LABELS),
        inline: false,
      });
    }

    if (profile?.playstyles?.length) {
      embed.addFields({
        name: "Playstyle",
        value: formatEnumList(profile.playstyles, PLAYSTYLE_LABELS),
        inline: false,
      });
    }

    if ((embed.data.fields?.length ?? 0) === 0) {
      embed.setDescription("No profile details set yet.");
    }

    await interaction.reply({ embeds: [embed] });
  }
}
