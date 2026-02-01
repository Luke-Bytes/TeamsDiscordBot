import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
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

type ProfileModel = {
  findUnique: (args: { where: { playerId: string } }) => Promise<unknown>;
  upsert: (args: {
    where: { playerId: string };
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  }) => Promise<unknown>;
};

function getProfileModel(): ProfileModel | undefined {
  return (prismaClient as unknown as { profile?: ProfileModel }).profile;
}

export default class ProfileEditCommand implements Command {
  public name = "profilecreate";
  public description = "Create or edit your profile";
  public buttonIds: string[] = [
    "profile-edit:",
    "profile-clear:",
    "profile-back",
    "profile-cancel",
    "profile-name-custom",
  ];
  public selectMenuIds: string[] = ["profile-select:"];
  public modalIds: string[] = ["profile-name-modal"];
  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description);

  private sessions = new Map<string, Session>();

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "Profiles can only be edited inside the server.",
      });
      return;
    }
    if (!PermissionsUtil.isChannel(interaction, "botCommands")) {
      await interaction.reply({
        content: "Please use this in the bot commands channel.",
      });
      return;
    }

    const player = await PrismaUtils.findPlayer(interaction.user.id);
    if (!player) {
      await interaction.reply({
        content: "No profile found yet — register first, then try again.",
      });
      return;
    }

    this.sessions.set(interaction.user.id, {
      playerId: player.id,
      userId: interaction.user.id,
      latestIgn: player.latestIGN ?? null,
      discordName: interaction.user.username,
    });

    const profile = await getProfileModel()?.findUnique({
      where: { playerId: player.id },
    });
    const view = this.buildMainView(player.latestIGN ?? null, profile);
    await interaction.reply({ ...view });
  }

  public async handleButtonPress(
    interaction: ButtonInteraction
  ): Promise<void> {
    const session = this.sessions.get(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content: "This profile session has expired. Run /profilecreate again.",
      });
      return;
    }

    if (interaction.customId === "profile-back") {
      const profile = await getProfileModel()?.findUnique({
        where: { playerId: session.playerId },
      });
      const view = this.buildMainView(null, profile);
      await interaction.update({ ...view });
      return;
    }

    if (interaction.customId === "profile-cancel") {
      this.sessions.delete(interaction.user.id);
      await interaction.update({
        content: "All set! Your profile has been updated.",
        embeds: [],
        components: [],
      });
      return;
    }

    if (interaction.customId === "profile-name-custom") {
      const modal = new ModalBuilder()
        .setCustomId("profile-name-modal")
        .setTitle("Preferred Name");
      const input = new TextInputBuilder()
        .setCustomId("preferredName")
        .setLabel("Enter your name")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(32)
        .setRequired(true);
      const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
      modal.addComponents(row);
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId.startsWith("profile-clear:")) {
      const section = interaction.customId.split(":")[1] as SectionKey;
      await this.clearSection(session.playerId, section);
      const profile = await getProfileModel()?.findUnique({
        where: { playerId: session.playerId },
      });
      const view = this.buildSectionView(section, session, null, profile);
      await interaction.update({ ...view });
      return;
    }

    if (interaction.customId.startsWith("profile-edit:")) {
      const section = interaction.customId.split(":")[1] as SectionKey;
      const profile = await getProfileModel()?.findUnique({
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
        content: "This session expired — run /profilecreate to continue.",
      });
      return;
    }

    const section = interaction.customId.split(":")[1] as SectionKey;
    const values = interaction.values;
    await this.saveSection(session.playerId, section, values);
    const profile = await getProfileModel()?.findUnique({
      where: { playerId: session.playerId },
    });
    const view = this.buildSectionView(section, session, values, profile);
    await interaction.update({ ...view });
  }

  public async handleModalSubmit(
    interaction: import("discord.js").ModalSubmitInteraction
  ): Promise<void> {
    const session = this.sessions.get(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content: "This session expired — run /profilecreate to continue.",
      });
      return;
    }
    if (interaction.customId !== "profile-name-modal") return;
    const value = interaction.fields
      ?.getTextInputValue("preferredName")
      ?.trim();
    if (!value) {
      await interaction.reply({
        content: "Preferred name can't be empty.",
      });
      return;
    }
    await this.saveSection(session.playerId, "preferredName", [value]);
    const profile = await getProfileModel()?.findUnique({
      where: { playerId: session.playerId },
    });
    const view = this.buildSectionView(
      "preferredName",
      session,
      [value],
      profile
    );
    await interaction.reply({ ...view });
  }

  private buildMainView(
    latestIgn: string | null,
    profile: unknown
  ): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const embed = new EmbedBuilder()
      .setTitle("Profile Builder")
      .setDescription("Pick a section to personalise.");

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
          .setLabel("Name")
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
          .setLabel("Proficient")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-edit:improveRoles")
          .setLabel("Want to Improve")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-edit:playstyles")
          .setLabel("Playstyle")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("profile-cancel")
          .setLabel("Finish")
          .setStyle(ButtonStyle.Success)
      ),
    ];

    return { embeds: [embed], components: rows };
  }

  private buildSectionView(
    section: SectionKey,
    session: Session,
    lastValues: string[] | null,
    profile: unknown
  ): {
    embeds: EmbedBuilder[];
    components: Array<
      ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>
    >;
  } {
    const embed = new EmbedBuilder().setTitle("Profile Builder");
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
    if (section === "preferredName") {
      controls.addComponents(
        new ButtonBuilder()
          .setCustomId("profile-name-custom")
          .setLabel("Type Name")
          .setStyle(ButtonStyle.Primary)
      );
    }

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

  private addProfileFields(embed: EmbedBuilder, profile: unknown) {
    const data = profile as {
      preferredName?: string | null;
      pronouns?: keyof typeof PRONOUNS_LABELS | null;
      languages?: Array<keyof typeof LANGUAGE_LABELS>;
      region?: keyof typeof REGION_LABELS | null;
      rank?: keyof typeof RANK_LABELS | null;
      preferredRoles?: Array<keyof typeof ROLE_LABELS>;
      proficientAtRoles?: Array<keyof typeof ROLE_LABELS>;
      improveRoles?: Array<keyof typeof ROLE_LABELS>;
      playstyles?: Array<keyof typeof PLAYSTYLE_LABELS>;
    } | null;
    if (!data) return;
    if (data.preferredName) {
      embed.addFields({
        name: "Preferred Name",
        value: escapeText(data.preferredName),
        inline: true,
      });
    }
    if (data.pronouns) {
      embed.addFields({
        name: "Pronouns",
        value: PRONOUNS_LABELS[data.pronouns],
        inline: true,
      });
    }
    if (data.languages?.length) {
      embed.addFields({
        name: "Languages",
        value: formatEnumList(data.languages, LANGUAGE_LABELS),
        inline: true,
      });
    }
    if (data.region) {
      embed.addFields({
        name: "Region",
        value: REGION_LABELS[data.region],
        inline: true,
      });
    }
    if (data.rank) {
      embed.addFields({
        name: "Rank",
        value: RANK_LABELS[data.rank],
        inline: true,
      });
    }
    if (data.preferredRoles?.length) {
      embed.addFields({
        name: "Preferred Roles",
        value: formatEnumList(data.preferredRoles, ROLE_LABELS),
        inline: false,
      });
    }
    if (data.proficientAtRoles?.length) {
      embed.addFields({
        name: "Proficient Roles",
        value: formatEnumList(data.proficientAtRoles, ROLE_LABELS),
        inline: false,
      });
    }
    if (data.improveRoles?.length) {
      embed.addFields({
        name: "Want to Improve Roles",
        value: formatEnumList(data.improveRoles, ROLE_LABELS),
        inline: false,
      });
    }
    if (data.playstyles?.length) {
      embed.addFields({
        name: "Playstyle",
        value: formatEnumList(data.playstyles, PLAYSTYLE_LABELS),
        inline: false,
      });
    }
  }

  private buildSelectMenu(
    section: SectionKey,
    session: Session,
    _profile: unknown
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

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      select
    );
  }

  private async saveSection(
    playerId: string,
    section: SectionKey,
    values: string[]
  ) {
    const data: Record<string, unknown> = {};
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
    await getProfileModel()?.upsert({
      where: { playerId },
      update: data,
      create: { playerId, ...data },
    });
  }

  private async clearSection(playerId: string, section: SectionKey) {
    const data: Record<string, unknown> = {};
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
    await getProfileModel()?.upsert({
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
        return (
          PLAYSTYLE_LABELS[value as keyof typeof PLAYSTYLE_LABELS] ?? value
        );
      default:
        return value;
    }
  }
}
