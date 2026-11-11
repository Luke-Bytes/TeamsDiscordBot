import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { GameRecoveryCoordinator, GameSnapshotStore } from "../logic/ActiveGameRecovery";
import TeamCommand from "./TeamCommand";

type RestartRequest = {
  userId: string;
  guildId: string | null;
  preserve: boolean;
  messageId?: string;
  expiresAt: number;
};

export default class RestartCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restarts the bot")
    .addBooleanOption((option) =>
      option.setName("preservegame")
        .setDescription("Save and restore the active announced game across restart")
        .setRequired(false)
    );
  name = "restart";
  description = "Restarts the bot";
  buttonIds = ["confirm_restart:"];
  private readonly requests = new Map<string, RestartRequest>();
  private restartInProgress = false;

  constructor(private readonly createStore: () => GameSnapshotStore = () => new GameSnapshotStore()) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = interaction.member as GuildMember;
    if (!member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.reply({ content: "You do not have permission to restart the bot." });
      return;
    }
    if (this.restartInProgress || GameRecoveryCoordinator.isFrozen()) {
      await interaction.reply({ content: "Restart/recovery is already in progress or blocked." });
      return;
    }
    for (const [key, value] of this.requests) {
      if (value.expiresAt < Date.now()) this.requests.delete(key);
    }
    const preserve = interaction.options.getBoolean("preservegame") === true;
    const id = randomUUID();
    const confirmButton = new ButtonBuilder()
      .setCustomId(`confirm_restart:${id}`)
      .setLabel(preserve ? "Save Game & Restart" : "Confirm Restart")
      .setStyle(ButtonStyle.Danger);
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton);
    this.requests.set(id, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      preserve,
      expiresAt: Date.now() + 120_000,
    });
    try {
      const response = await interaction.reply({
        withResponse: true,
        content: preserve
          ? "⚠️ Confirm a preserved restart. If the game cannot be saved safely, no restart will occur. Optional workflows will be paused for review."
          : "⚠️ **Warning:** Are you sure you want to restart the bot?",
        components: [actionRow],
      });
      const messageId = response.resource?.message?.id;
      if (messageId) this.requests.get(id)!.messageId = messageId;
      else this.requests.delete(id); // Never accept a button without its source message identity.
    } catch (error) {
      this.requests.delete(id);
      throw error;
    }
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    const id = interaction.customId.slice("confirm_restart:".length);
    const request = this.requests.get(id);
    const member = interaction.member as GuildMember;
    if (!request || request.expiresAt < Date.now() ||
      !request.messageId || request.messageId !== interaction.message?.id ||
      request.userId !== interaction.user.id ||
      request.guildId !== interaction.guildId ||
      !member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.reply({ content: "This restart confirmation has expired or belongs to another organiser." });
      return;
    }
    if (this.restartInProgress || GameRecoveryCoordinator.isFrozen()) {
      await interaction.reply({ content: "Another restart or recovery is already in progress." });
      return;
    }
    this.restartInProgress = true;
    this.requests.delete(id);
    try {
      await interaction.update({ content: request.preserve ? "Saving a validated game snapshot..." : "Restarting the bot...", components: [] });
      if (request.preserve) {
        try {
          const snapshot = await GameRecoveryCoordinator.capture(
            CurrentGameManager.getCurrentGame(), this.createStore(), TeamCommand.instance
          );
          console.info(`[game-recovery] snapshot=${snapshot.snapshotId} game=${snapshot.gameId} players=${Object.values(snapshot.game.teams).flat().length}; restart approved`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[game-recovery] Snapshot failed; no restart", message);
          await interaction.editReply({
            content: `Preserved restart cancelled: ${message}. The running game has not been deliberately reset. Check recovery files before retrying.`,
          }).catch((replyError) => console.error("Cannot report snapshot failure", replyError));
          return;
        }
        await interaction.editReply({
          content: "Validated active-game snapshot saved. Restarting; draft/vote/timer workflows may require organiser review.",
        }).catch((error) => console.warn("Cannot report saved snapshot before exit", error));
      }
      this.restartBot();
    } finally {
      this.restartInProgress = false;
    }
  }

  public restartBot(): void {
    console.log("Bot is being restarted.. byebye!");
    const isPM2 = !!(process.env.pm_id || process.env.PM2_HOME);
    process.exit(isPM2 ? 0 : 51); // 51 => ask parent to relaunch
  }
}
