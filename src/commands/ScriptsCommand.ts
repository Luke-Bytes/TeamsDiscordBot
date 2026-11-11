import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { DiscordUtil } from "../util/DiscordUtil";
import { Channels } from "../Channels";
import { TitleService } from "../logic/TitleService";

/** Explicit title repair tool. Season creation/activation belongs to /season. */
export default class ScriptsCommand implements Command {
  name = "scripts";
  description = "Run organiser repair tools";
  buttonIds = ["scripts-confirm:titles-update", "scripts-cancel"];
  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addSubcommand((sub) =>
      sub
        .setName("titles-update")
        .setDescription("Reconcile lifetime and ranked placement titles")
    );
  private readonly requests = new Map<string, { userId: string; expiresAt: number }>();

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await PermissionsUtil.isUserAuthorised(interaction))) return;
    const message = await DiscordUtil.replyWithMessage(interaction, {
      content:
        "Reconcile all lifetime titles and placement titles from completed ranked seasons?",
      flags: MessageFlags.Ephemeral,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("scripts-confirm:titles-update")
            .setLabel("Confirm")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("scripts-cancel")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
    // A missing message identity is not a valid confirmation.
    if (message?.id) {
      for (const [id, request] of this.requests) {
        if (request.userId === interaction.user.id || request.expiresAt <= Date.now()) this.requests.delete(id);
      }
      this.requests.set(message.id, { userId: interaction.user.id, expiresAt: Date.now() + 5 * 60_000 });
    }
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    const messageId = interaction.message?.id;
    const request = messageId ? this.requests.get(messageId) : undefined;
    if (!request || request.expiresAt <= Date.now()) {
      await interaction.reply({
        content: "This confirmation expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (request.userId !== interaction.user.id ||
        !PermissionsUtil.hasRole(interaction.member as GuildMember, "organiserRole") || !interaction.guildId) {
      await interaction.reply({ content: "Only the authorised organiser who requested this may confirm.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Claim before the first await, including cancellation and acknowledgement.
    this.requests.delete(interaction.message.id);
    if (interaction.customId === "scripts-cancel") {
      await interaction.update({
        content: "Title reconciliation cancelled.",
        components: [],
      });
      return;
    }
    await interaction.update({
      content: "Reconciling titles...",
      components: [],
    });
    try {
      const result = await TitleService.reconcile();
      for (const block of result.blocks) await Channels.announcements.send(block);
      console.info(`event=scripts.titles_reconcile outcome=succeeded unlocked=${result.newlyUnlocked.length} announcements=${result.blocks.length}`);
      await interaction.editReply({
        content: result.newlyUnlocked.length
          ? `Reconciled titles for ${result.newlyUnlocked.length} player(s) and posted the new unlocks.`
          : "Titles are already reconciled; no new unlocks were found.",
      });
    } catch (error) {
      console.error(`event=scripts.titles_reconcile outcome=failed error_type=${error instanceof Error ? error.name : "unknown"}`);
      await interaction.editReply({ content: "Title reconciliation may have partially completed; inspect titles and announcements before submitting a new request." });
    }
  }
}
