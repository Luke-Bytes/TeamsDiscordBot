import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
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
  private readonly pendingUsers = new Set<string>();

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await PermissionsUtil.isUserAuthorised(interaction))) return;
    this.pendingUsers.add(interaction.user.id);
    await DiscordUtil.replyWithMessage(interaction, {
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
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    if (!this.pendingUsers.has(interaction.user.id)) {
      await interaction.reply({
        content: "This confirmation expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    this.pendingUsers.delete(interaction.user.id);
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
    const result = await TitleService.reconcile();
    for (const block of result.blocks) await Channels.announcements.send(block);
    await interaction.editReply({
      content: result.newlyUnlocked.length
        ? `Reconciled titles for ${result.newlyUnlocked.length} player(s) and posted the new unlocks.`
        : "Titles are already reconciled; no new unlocks were found.",
    });
  }
}
