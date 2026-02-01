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
  Pronouns,
  Region,
  PlayerRank,
  Language,
  Role,
  Playstyle,
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
    const lookup = input
      ? input.replace(/<@([^>]+)>/g, "$1")
      : interaction.user.id;

    const player = await PrismaUtils.findPlayer(lookup);
    if (!player) {
      await interaction.reply({
        content: "No player found for that input.",
        ephemeral: true,
      });
      return;
    }

    const profile = await (
      prismaClient as unknown as {
        profile?: {
          findUnique: (args: {
            where: { playerId: string };
          }) => Promise<unknown>;
        };
      }
    ).profile?.findUnique({
      where: { playerId: player.id },
    });

    const displayName = player.latestIGN
      ? escapeText(player.latestIGN)
      : escapeText(player.discordSnowflake);

    const embed = new EmbedBuilder()
      .setTitle(`Profile • ${displayName}`)
      .setDescription("View a player.");

    if (player.latestIGN) {
      embed.addFields({
        name: "Minecraft IGN",
        value: escapeText(player.latestIGN),
        inline: true,
      });
    }

    const data = profile as {
      preferredName?: string | null;
      pronouns?: Pronouns | null;
      languages?: Language[];
      region?: Region | null;
      rank?: PlayerRank | null;
      preferredRoles?: Role[];
      proficientAtRoles?: Role[];
      improveRoles?: Role[];
      playstyles?: Playstyle[];
    } | null;

    if (data?.preferredName) {
      embed.addFields({
        name: "Preferred Name",
        value: escapeText(data.preferredName),
        inline: true,
      });
    }

    if (data?.pronouns) {
      embed.addFields({
        name: "Pronouns",
        value: PRONOUNS_LABELS[data.pronouns],
        inline: true,
      });
    }

    if (data?.languages?.length) {
      embed.addFields({
        name: "Languages",
        value: formatEnumList(data.languages, LANGUAGE_LABELS),
        inline: true,
      });
    }

    if (data?.region) {
      embed.addFields({
        name: "Region",
        value: REGION_LABELS[data.region],
        inline: true,
      });
    }

    if (data?.rank) {
      embed.addFields({
        name: "Rank",
        value: RANK_LABELS[data.rank],
        inline: true,
      });
    }

    if (data?.preferredRoles?.length) {
      embed.addFields({
        name: "Preferred Roles",
        value: formatEnumList(data.preferredRoles, ROLE_LABELS),
        inline: false,
      });
    }

    if (data?.proficientAtRoles?.length) {
      embed.addFields({
        name: "Proficient Roles",
        value: formatEnumList(data.proficientAtRoles, ROLE_LABELS),
        inline: false,
      });
    }

    if (data?.improveRoles?.length) {
      embed.addFields({
        name: "Want to Improve Roles",
        value: formatEnumList(data.improveRoles, ROLE_LABELS),
        inline: false,
      });
    }

    if (data?.playstyles?.length) {
      embed.addFields({
        name: "Playstyle",
        value: formatEnumList(data.playstyles, PLAYSTYLE_LABELS),
        inline: false,
      });
    }

    if ((embed.data.fields?.length ?? 0) === 0) {
      embed.setDescription("Nothing here yet — run `/profilecreate` to begin.");
    }

    await interaction.reply({ embeds: [embed] });
  }
}
