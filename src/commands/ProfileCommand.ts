import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PrismaUtils } from "../util/PrismaUtils";
import { prismaClient } from "../database/prismaClient";
import { escapeIgn, escapeText } from "../util/Utils";
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
  formatTitleLabel,
} from "../util/ProfileUtil";
import { TitleStore } from "../util/TitleStore";

export default class ProfileCommand implements Command {
  public name = "profile";
  public description = "View a player profile";
  public buttonIds: string[] = ["profile-nickname:"];
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
        flags: MessageFlags.Ephemeral,
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
      ? escapeIgn(player.latestIGN)
      : escapeText(player.discordSnowflake);

    const embed = new EmbedBuilder()
      .setTitle(`Profile • ${displayName}`)
      .setDescription("View a player.");

    if (player.latestIGN) {
      embed.addFields({
        name: "Minecraft IGN",
        value: escapeIgn(player.latestIGN),
        inline: true,
      });
    }

    const data = profile as {
      preferredName?: string | null;
      title?: string | null;
      pronouns?: Pronouns | null;
      languages?: Language[];
      region?: Region | null;
      rank?: PlayerRank | null;
      preferredRoles?: Role[];
      proficientAtRoles?: Role[];
      improveRoles?: Role[];
      playstyles?: Playstyle[];
      autoNickname?: boolean | null;
    } | null;

    if (data?.preferredName) {
      embed.addFields({
        name: "Preferred Name",
        value: escapeText(data.preferredName),
        inline: true,
      });
    }

    if (data?.title) {
      const titleLabel = formatTitleLabel(data.title, TitleStore.loadTitles());
      if (titleLabel) {
        embed.addFields({
          name: "Title",
          value: titleLabel,
          inline: true,
        });
      }
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

    const viewingOwnProfile = player.discordSnowflake === interaction.user.id;
    const nicknameEnabled = data?.autoNickname !== false;
    if (viewingOwnProfile) {
      embed.addFields({
        name: "Automatic nickname",
        value: this.nicknameDescription(nicknameEnabled),
        inline: false,
      });
    }

    if ((embed.data.fields?.length ?? 0) === 0) {
      embed.setDescription("Nothing here yet — run `/profilecreate` to begin.");
    }

    await interaction.reply({
      embeds: [embed],
      components: viewingOwnProfile
        ? [this.nicknameButton(player.id, nicknameEnabled)]
        : [],
    });
  }

  public async handleButtonPress(
    interaction: ButtonInteraction
  ): Promise<void> {
    const [prefix, action, playerId] = interaction.customId.split(":");
    const player = await PrismaUtils.findPlayer(interaction.user.id);
    if (
      prefix !== "profile-nickname" ||
      (action !== "enable" && action !== "disable") ||
      !player ||
      player.id !== playerId
    ) {
      await interaction.reply({
        content: "Only the profile owner can change this setting.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const enabled = action === "enable";
    try {
      await prismaClient.profile.upsert({
        where: { playerId: player.id },
        create: { playerId: player.id, autoNickname: enabled },
        update: { autoNickname: enabled },
      });
    } catch (error) {
      console.warn(
        "Could not update automatic nickname preference",
        error instanceof Error ? error.message : String(error)
      );
      await interaction.reply({
        content: "Unable to save the nickname setting. Try again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const currentEmbed = interaction.message.embeds[0];
    const embed = EmbedBuilder.from(currentEmbed);
    const fieldIndex = (embed.data.fields ?? []).findIndex(
      (field) => field.name === "Automatic nickname"
    );
    if (fieldIndex >= 0) {
      embed.spliceFields(fieldIndex, 1, {
        name: "Automatic nickname",
        value: this.nicknameDescription(enabled),
        inline: false,
      });
    }
    await interaction.update({
      embeds: [embed],
      components: [this.nicknameButton(player.id, enabled)],
    });
  }

  private nicknameDescription(enabled: boolean): string {
    return enabled
      ? "On — your server nickname updates to your latest IGN when you `/register`."
      : "Off — registering will not change your server nickname.";
  }

  private nicknameButton(playerId: string, enabled: boolean) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `profile-nickname:${enabled ? "disable" : "enable"}:${playerId}`
        )
        .setLabel(enabled ? "Disable auto nickname" : "Enable auto nickname")
        .setStyle(enabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
    );
  }
}
