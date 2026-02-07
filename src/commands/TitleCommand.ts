import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PrismaUtils } from "../util/PrismaUtils";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { TitleStore } from "../util/TitleStore";
import { normalizeTitleIds } from "../util/ProfileUtil";
import { prismaClient } from "../database/prismaClient";

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

type Session = {
  playerId: string;
  userId: string;
  available: string[];
  unlocked: Set<string>;
};

export default class TitleCommand implements Command {
  public name = "title";
  public description = "Manage player titles";
  public buttonIds: string[] = ["title-add", "title-remove", "title-cancel"];
  public selectMenuIds: string[] = ["title-select:add", "title-select:remove"];
  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addStringOption((opt) =>
      opt
        .setName("player")
        .setDescription("Discord ID/mention or latest IGN")
        .setRequired(true)
    );

  private readonly sessions = new Map<string, Session>();

  public async execute(interaction: ChatInputCommandInteraction) {
    if (
      !interaction.inGuild?.() ||
      !PermissionsUtil.hasRole(
        interaction.member as GuildMember,
        "organiserRole"
      )
    ) {
      await interaction.reply({
        content: "You do not have permission to manage titles.",
        ephemeral: true,
      });
      return;
    }

    const input = interaction.options.getString("player", true);
    const lookup = input.replace(/<@([^>]+)>/g, "$1");
    const player = await PrismaUtils.findPlayer(lookup);
    if (!player) {
      await interaction.reply({
        content: "No player found for that input.",
        ephemeral: true,
      });
      return;
    }

    const titles = TitleStore.loadTitles();
    const available = titles.map((t) => t.id);
    const profile = await getProfileModel()?.findUnique({
      where: { playerId: player.id },
    });
    const data = profile as { unlockedTitles?: string[] } | null;
    const unlocked = new Set(data?.unlockedTitles ?? []);

    const session: Session = {
      playerId: player.id,
      userId: interaction.user.id,
      available,
      unlocked,
    };
    this.sessions.set(interaction.user.id, session);

    const embed = new EmbedBuilder()
      .setTitle("🏷️ Title Manager")
      .setDescription(
        `Managing titles for **${player.latestIGN ?? player.discordSnowflake}**.`
      )
      .addFields({
        name: "Unlocked",
        value: unlocked.size
          ? Array.from(unlocked)
              .map(
                (id) =>
                  TitleStore.loadTitles().find((t) => t.id === id)?.label ?? id
              )
              .join(", ")
          : "None",
      });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("title-add")
        .setLabel("Add")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("title-remove")
        .setLabel("Remove")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("title-cancel")
        .setLabel("Close")
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  public async handleButtonPress(interaction: ButtonInteraction) {
    const session = this.sessions.get(interaction.user.id);
    if (!session) {
      await this.safeReply(interaction, {
        content: "This session has expired. Run /title again.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.customId === "title-cancel") {
      this.sessions.delete(interaction.user.id);
      await interaction.update({
        components: [],
        content: "Title editor closed.",
      });
      return;
    }

    const titles = TitleStore.loadTitles();
    const options = titles.slice(0, 25).map((t) => ({
      label: t.label,
      value: t.id,
    }));

    if (interaction.customId === "title-add") {
      const select = new StringSelectMenuBuilder()
        .setCustomId("title-select:add")
        .setPlaceholder("Select titles to add")
        .addOptions(options)
        .setMinValues(1)
        .setMaxValues(Math.min(options.length, 25));
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        select
      );
      await interaction.update({ components: [row] });
      return;
    }

    if (interaction.customId === "title-remove") {
      const unlocked = Array.from(session.unlocked);
      if (!unlocked.length) {
        await this.safeReply(interaction, {
          content: "This player has no titles to remove.",
          ephemeral: true,
        });
        return;
      }
      const removeOptions = titles
        .filter((t) => session.unlocked.has(t.id))
        .slice(0, 25)
        .map((t) => ({ label: t.label, value: t.id }));
      const select = new StringSelectMenuBuilder()
        .setCustomId("title-select:remove")
        .setPlaceholder("Select titles to remove")
        .addOptions(removeOptions)
        .setMinValues(1)
        .setMaxValues(Math.min(removeOptions.length, 25));
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        select
      );
      await interaction.update({ components: [row] });
      return;
    }
  }

  public async handleSelectMenu(interaction: StringSelectMenuInteraction) {
    const session = this.sessions.get(interaction.user.id);
    if (!session) {
      await this.safeReply(interaction, {
        content: "This session has expired. Run /title again.",
        ephemeral: true,
      });
      return;
    }

    const titles = TitleStore.loadTitles();
    if (interaction.customId === "title-select:add") {
      const add = normalizeTitleIds(interaction.values);
      add.forEach((id) => session.unlocked.add(id));
    } else if (interaction.customId === "title-select:remove") {
      const remove = normalizeTitleIds(interaction.values);
      remove.forEach((id) => session.unlocked.delete(id));
    }

    await getProfileModel()?.upsert({
      where: { playerId: session.playerId },
      update: { unlockedTitles: Array.from(session.unlocked) },
      create: {
        playerId: session.playerId,
        unlockedTitles: Array.from(session.unlocked),
      },
    });

    const embed = new EmbedBuilder()
      .setTitle("🏷️ Title Manager")
      .setDescription("Titles updated.")
      .addFields({
        name: "Unlocked",
        value: session.unlocked.size
          ? Array.from(session.unlocked)
              .map((id) => titles.find((t) => t.id === id)?.label ?? id)
              .join(", ")
          : "None",
      });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("title-add")
        .setLabel("Add")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("title-remove")
        .setLabel("Remove")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("title-cancel")
        .setLabel("Close")
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({ embeds: [embed], components: [row] });
  }

  private async safeReply(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    payload: { content: string; ephemeral?: boolean }
  ) {
    const canReply =
      typeof interaction.isRepliable === "function"
        ? interaction.isRepliable()
        : "reply" in interaction;
    if (canReply && !interaction.replied && !interaction.deferred) {
      if ("reply" in interaction) {
        await interaction.reply(payload);
        return;
      }
    }
    if ("update" in interaction) {
      await interaction.update({ content: payload.content, components: [] });
    }
  }
}
