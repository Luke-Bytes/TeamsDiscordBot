import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { PrismaUtils } from "../util/PrismaUtils";
import { prismaClient } from "../database/prismaClient";
import {
  LANGUAGE_LABELS,
  LANGUAGE_LIST,
  PLAYSTYLE_LABELS,
  PLAYSTYLE_LIST,
  PRONOUNS_LABELS,
  PRONOUNS_LIST,
  RANK_LABELS,
  RANK_LIST,
  REGION_LABELS,
  REGION_LIST,
  ROLE_LABELS,
  ROLE_LIST,
  formatEnumList,
} from "../util/ProfileUtil";
import { escapeText } from "../util/Utils";

type SectionKey =
  | "preferredName"
  | "pronouns"
  | "languages"
  | "region"
  | "rank"
  | "preferredRoles"
  | "proficientAtRoles"
  | "improveRoles"
  | "playstyles";

type Session = {
  playerId: string;
  userId: string;
  latestIgn: string | null;
  discordName: string;
};

export default class ProfileEditCommand implements Command {
  public name = "profilecreate";
  public description = "Create or edit your profile";
  public buttonIds: string[] = [
    "profile-edit:",
    "profile-clear:",
    "profile-back",
    "profile-cancel",
  ];
  public selectMenuIds: string[] = ["profile-select:"];
  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description);

  private sessions = new Map<string, Session>();

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }
    if (!PermissionsUtil.isChannel(interaction, "botCommands")) {
      await interaction.reply({
        content: "Please use this command in the bot commands channel.",
        ephemeral: true,
      });
      return;
    }

    const player = await PrismaUtils.findPlayer(interaction.user.id);
    if (!player) {
      await interaction.reply({
        content: "Player not found. Please register first.",
        ephemeral: true,
      });
      return;
    }

    this.sessions.set(interaction.user.id, {
      playerId: player.id,
      userId: interaction.user.id,
      latestIgn: player.latestIGN ?? null,
      discordName: interaction.user.username,
    });

    const profile = await prismaClient.profile.findUnique({
      where: { playerId: player.id },
    });
    const view = this.buildMainView(player.latestIGN ?? null, profile);
    await interaction.reply({ ...view, ephemeral: true });
  }

  public async handleButtonPress(
    interaction: ButtonInteraction
  ): Promise<void> {
    const session = this.sessions.get(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content:
          "This profile session has expired. Run /profilecreate again.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.customId === "profile-back") {
      const profile = await prismaClient.profile.findUnique({
        where: { playerId: session.playerId },
      });
      const view = this.buildMainView(null, profile);
      await interaction.update({ ...view });
      return;
    }

    if (interaction.customId === "profile-cancel") {
      this.sessions.delete(interaction.user.id);
      await interaction.update({
        content: "Profile edit cancelled.",
        embeds: [],
        components: [],
      });
      return;
    }

    if (interaction.customId.startsWith("profile-clear:")) {
      const section = interaction.customId.split(":")[1] as SectionKey;
      await this.clearSection(session.playerId, section);
      const profile = await prismaClient.profile.findUnique({
        where: { playerId: session.playerId },
      });
      const view = this.buildSectionView(section, session, null, profile);
      await interaction.update({ ...view });
      return;
    }

    if (interaction.customId.startsWith("profile-edit:")) {
      const section = interaction.customId.split(":")[1] as SectionKey;
      const profile = await prismaClient.profile.findUnique({
        where: { playerId: session.playerId },
      });
      const view = this.buildSectionView(section, session, null, profile);
      await interaction.update({ ...view });
    }
  }

  public async handleSelectMenu(
    interaction: StringSelectMenuInteraction
  ): Promise<void> {
    const session = this.sessions.get(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content:
          "This profile session has expired. Run /profilecreate again.",
        ephemeral: true,
      });
      return;
    }

    const section = interaction.customId.split(":")[1] as SectionKey;
    const values = interaction.values;
    await this.saveSection(session.playerId, section, values);
    const profile = await prismaClient.profile.findUnique({
      where: { playerId: session.playerId },
    });
    const view = this.buildSectionView(section, session, values, profile);
    await interaction.update({ ...view });
  }

  private buildMainView(
    latestIgn: string | null,
    profile: any
  ): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const embed = new EmbedBuilder()
      .setTitle("Edit Profile")
      .setDescription("Choose a section to update.");

    if (latestIgn) {
      embed.addFields({
        name: "Minecraft IGN",
        value: escapeText(latestIgn),
        inline: true,
      });
    }
    this.addProfileFields(embed, profile);

    const rows = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("profile-edit:preferredName")
          .setLabel("Preferred Name")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-edit:pronouns")
          .setLabel("Pronouns")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-edit:languages")
          .setLabel("Languages")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-edit:region")
          .setLabel("Region")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-edit:rank")
          .setLabel("Rank")
          .setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("profile-edit:preferredRoles")
          .setLabel("Preferred Roles")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-edit:proficientAtRoles")
          .setLabel("Proficient At Roles")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-edit:improveRoles")
          .setLabel("Improve Roles")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-edit:playstyles")
          .setLabel("Playstyles")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-cancel")
          .setLabel("Done")
          .setStyle(ButtonStyle.Success)
      ),
    ];

    return { embeds: [embed], components: rows };
  }

  private buildSectionView(
    section: SectionKey,
    session: Session,
    lastValues: string[] | null,
    profile: any
  ): {
    embeds: EmbedBuilder[];
    components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>>;
  } {
    const embed = new EmbedBuilder().setTitle("Edit Profile");
    this.addProfileFields(embed, profile);

    const menu = this.buildSelectMenu(section, session, profile);
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("profile-back")
        .setLabel("Back")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`profile-clear:${section}`)
        .setLabel("Clear")
        .setStyle(ButtonStyle.Danger)
    );

    if (lastValues && lastValues.length > 0) {
      embed.setFooter({
        text: `Saved: ${lastValues.map((v) => this.formatValue(section, v)).join(", ")}`,
      });
    }

    return {
      embeds: [embed],
      components: [menu, controls],
    };
  }

  private addProfileFields(embed: EmbedBuilder, profile: any) {
    if (!profile) return;
    if (profile.preferredName) {
      embed.addFields({
        name: "Preferred Name",
        value: escapeText(profile.preferredName),
        inline: true,
      });
    }
    if (profile.pronouns) {
      embed.addFields({
        name: "Pronouns",
        value: PRONOUNS_LABELS[profile.pronouns],
        inline: true,
      });
    }
    if (profile.languages?.length) {
      embed.addFields({
        name: "Languages",
        value: formatEnumList(profile.languages, LANGUAGE_LABELS),
        inline: true,
      });
    }
    if (profile.region) {
      embed.addFields({
        name: "Region",
        value: REGION_LABELS[profile.region],
        inline: true,
      });
    }
    if (profile.rank) {
      embed.addFields({
        name: "Rank",
        value: RANK_LABELS[profile.rank],
        inline: true,
      });
    }
    if (profile.preferredRoles?.length) {
      embed.addFields({
        name: "Preferred Roles",
        value: formatEnumList(profile.preferredRoles, ROLE_LABELS),
        inline: false,
      });
    }
    if (profile.proficientAtRoles?.length) {
      embed.addFields({
        name: "Proficient At",
        value: formatEnumList(profile.proficientAtRoles, ROLE_LABELS),
        inline: false,
      });
    }
    if (profile.improveRoles?.length) {
      embed.addFields({
        name: "Looking to Improve",
        value: formatEnumList(profile.improveRoles, ROLE_LABELS),
        inline: false,
      });
    }
    if (profile.playstyles?.length) {
      embed.addFields({
        name: "Playstyle",
        value: formatEnumList(profile.playstyles, PLAYSTYLE_LABELS),
        inline: false,
      });
    }
  }

  private buildSelectMenu(
    section: SectionKey,
    session: Session,
    profile: any
  ): ActionRowBuilder<StringSelectMenuBuilder> {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`profile-select:${section}`)
      .setMinValues(0);

    switch (section) {
      case "preferredName": {
        select.setPlaceholder("Choose a preferred name");
        if (session.latestIgn) {
          select.addOptions({
            label: `Minecraft IGN (${session.latestIgn})`,
            value: session.latestIgn,
          });
        }
        select.addOptions({
          label: `Discord Username (${session.discordName})`,
          value: session.discordName,
        });
        select.setMaxValues(1);
        break;
      }
      case "pronouns":
        select
          .setPlaceholder("Select pronouns")
          .addOptions(
            PRONOUNS_LIST.map((p) => ({
              label: PRONOUNS_LABELS[p],
              value: p,
            }))
          )
          .setMaxValues(1);
        break;
      case "languages":
        select
          .setPlaceholder("Select languages")
          .addOptions(
            LANGUAGE_LIST.map((l) => ({
              label: LANGUAGE_LABELS[l],
              value: l,
            }))
          )
          .setMaxValues(LANGUAGE_LIST.length);
        break;
      case "region":
        select
          .setPlaceholder("Select region")
          .addOptions(
            REGION_LIST.map((r) => ({
              label: REGION_LABELS[r],
              value: r,
            }))
          )
          .setMaxValues(1);
        break;
      case "rank":
        select
          .setPlaceholder("Select rank")
          .addOptions(
            RANK_LIST.map((r) => ({
              label: RANK_LABELS[r],
              value: r,
            }))
          )
          .setMaxValues(1);
        break;
      case "preferredRoles":
      case "proficientAtRoles":
      case "improveRoles":
        select
          .setPlaceholder("Select roles")
          .addOptions(
            ROLE_LIST.map((r) => ({
              label: ROLE_LABELS[r],
              value: r,
            }))
          )
          .setMaxValues(ROLE_LIST.length);
        break;
      case "playstyles":
        select
          .setPlaceholder("Select playstyles")
          .addOptions(
            PLAYSTYLE_LIST.map((p) => ({
              label: PLAYSTYLE_LABELS[p],
              value: p,
            }))
          )
          .setMaxValues(PLAYSTYLE_LIST.length);
        break;
    }

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  }

  private async saveSection(
    playerId: string,
    section: SectionKey,
    values: string[]
  ) {
    const data: any = {};
    switch (section) {
      case "preferredName":
        data.preferredName = values[0] ?? null;
        break;
      case "pronouns":
        data.pronouns = values[0] ?? null;
        break;
      case "languages":
        data.languages = values;
        break;
      case "region":
        data.region = values[0] ?? null;
        break;
      case "rank":
        data.rank = values[0] ?? null;
        break;
      case "preferredRoles":
        data.preferredRoles = values;
        break;
      case "proficientAtRoles":
        data.proficientAtRoles = values;
        break;
      case "improveRoles":
        data.improveRoles = values;
        break;
      case "playstyles":
        data.playstyles = values;
        break;
    }
    await prismaClient.profile.upsert({
      where: { playerId },
      update: data,
      create: { playerId, ...data },
    });
  }

  private async clearSection(playerId: string, section: SectionKey) {
    const data: any = {};
    switch (section) {
      case "preferredName":
        data.preferredName = null;
        break;
      case "pronouns":
        data.pronouns = null;
        break;
      case "languages":
        data.languages = [];
        break;
      case "region":
        data.region = null;
        break;
      case "rank":
        data.rank = null;
        break;
      case "preferredRoles":
        data.preferredRoles = [];
        break;
      case "proficientAtRoles":
        data.proficientAtRoles = [];
        break;
      case "improveRoles":
        data.improveRoles = [];
        break;
      case "playstyles":
        data.playstyles = [];
        break;
    }
    await prismaClient.profile.upsert({
      where: { playerId },
      update: data,
      create: { playerId, ...data },
    });
  }

  private formatValue(section: SectionKey, value: string): string {
    switch (section) {
      case "pronouns":
        return PRONOUNS_LABELS[value as keyof typeof PRONOUNS_LABELS] ?? value;
      case "languages":
        return LANGUAGE_LABELS[value as keyof typeof LANGUAGE_LABELS] ?? value;
      case "region":
        return REGION_LABELS[value as keyof typeof REGION_LABELS] ?? value;
      case "rank":
        return RANK_LABELS[value as keyof typeof RANK_LABELS] ?? value;
      case "preferredRoles":
      case "proficientAtRoles":
      case "improveRoles":
        return ROLE_LABELS[value as keyof typeof ROLE_LABELS] ?? value;
      case "playstyles":
        return PLAYSTYLE_LABELS[value as keyof typeof PLAYSTYLE_LABELS] ?? value;
      default:
        return value;
    }
  }
}
