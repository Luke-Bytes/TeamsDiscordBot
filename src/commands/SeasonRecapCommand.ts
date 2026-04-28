import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import {
  generateSeasonRecap,
  SeasonRecapResult,
} from "../logic/seasonRecap/SeasonRecap";
import { SeasonService } from "../database/SeasonService";
import { Channels } from "../Channels";

type PendingSeasonRecap = {
  userId: string;
  recap: SeasonRecapResult;
};

export default class SeasonRecapCommand implements Command {
  public name = "season-recap";
  public description = "Generate a season recap for announcements.";
  public buttonIds = ["season-recap-publish", "season-recap-cancel"];
  public data: SlashCommandOptionsOnlyBuilder;

  private readonly pendingByMessage = new Map<string, PendingSeasonRecap>();
  private readonly pendingByUser = new Map<string, PendingSeasonRecap>();

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addIntegerOption((option) =>
        option
          .setName("season")
          .setDescription("Season number to recap")
          .setRequired(false)
      )
      .addBooleanOption((option) =>
        option
          .setName("preview")
          .setDescription("Preview instead of publishing to announcements")
          .setRequired(false)
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const isAuthorized = await PermissionsUtil.isUserAuthorised(interaction);
    if (!isAuthorized) return;

    const preview = interaction.options.getBoolean("preview") ?? true;
    await interaction.deferReply({
      flags: preview ? MessageFlags.Ephemeral : undefined,
    });

    const seasonNumber =
      interaction.options.getInteger("season") ??
      (await SeasonService.getActiveSeasonNumber());
    const recap = await generateSeasonRecap({ seasonNumber });

    if (preview) {
      await this.sendPreview(interaction, recap);
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("season-recap-publish")
        .setLabel("Publish")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("season-recap-cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
    );

    const message = await interaction.editReply({
      content: [
        `Ready to publish **Season ${recap.seasonNumber} Recap** to ${Channels.announcements}.`,
        `${recap.summary.games} games, ${recap.summary.players} players, ${recap.blocks.length} message block(s).`,
        "",
        "First block preview:",
        "```",
        this.truncateForPreview(
          recap.blocks[0] ?? "No recap content generated."
        ),
        "```",
      ].join("\n"),
      components: [row],
    });

    const pending = { userId: interaction.user.id, recap };
    this.pendingByMessage.set(message.id, pending);
    this.pendingByUser.set(interaction.user.id, pending);
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    const pending =
      this.pendingByMessage.get(interaction.message.id) ??
      this.pendingByUser.get(interaction.user.id);

    if (!pending) {
      await interaction.reply({
        content: "This season recap confirmation has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== pending.userId) {
      await interaction.reply({
        content: "Only the organiser who generated this recap can publish it.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.customId === "season-recap-cancel") {
      this.clearPending(interaction, pending.userId);
      await interaction.update({
        content: "Season recap publish cancelled.",
        components: [],
      });
      return;
    }

    await interaction.update({
      content: `Publishing Season ${pending.recap.seasonNumber} recap...`,
      components: [],
    });

    for (const block of pending.recap.blocks) {
      await Channels.announcements.send(block);
    }

    this.clearPending(interaction, pending.userId);
    await interaction.editReply({
      content: `Posted Season ${pending.recap.seasonNumber} recap in ${pending.recap.blocks.length} message block(s).`,
      components: [],
    });
  }

  private async sendPreview(
    interaction: ChatInputCommandInteraction,
    recap: SeasonRecapResult
  ) {
    const intro = [
      `Generated Season ${recap.seasonNumber} recap preview.`,
      `${recap.summary.games} games, ${recap.summary.players} players, ${recap.blocks.length} message block(s).`,
      "Run `/season-recap preview:false` to confirm publishing to announcements.",
    ].join("\n");

    await interaction.editReply({
      content: `${intro}\n\n${this.wrapPreview(recap.blocks[0] ?? "No recap content generated.")}`,
    });

    for (const block of recap.blocks.slice(1)) {
      await interaction.followUp({
        content: this.wrapPreview(block),
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private wrapPreview(content: string) {
    return ["```", this.truncateForPreview(content), "```"].join("\n");
  }

  private truncateForPreview(content: string) {
    const max = 1500;
    return content.length > max ? `${content.slice(0, max - 3)}...` : content;
  }

  private clearPending(interaction: ButtonInteraction, userId: string) {
    this.pendingByMessage.delete(interaction.message.id);
    this.pendingByUser.delete(userId);
  }
}
