import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";

export default class RestartCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restarts the bot");
  name = "restart";
  description = "Restarts the bot";
  buttonIds = ["confirm_restart"];

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = interaction.member as GuildMember;
    if (!member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.reply({
        content: "You do not have permission to restart the bot.",
        ephemeral: false,
      });
      return;
    }
    const confirmButton = new ButtonBuilder()
      .setCustomId("confirm_restart")
      .setLabel("Confirm Restart")
      .setStyle(ButtonStyle.Danger);
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      confirmButton
    );
    await interaction.reply({
      content: "⚠️ **Warning:** Are you sure you want to restart the bot?",
      components: [actionRow],
      ephemeral: false,
    });
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === "confirm_restart") {
      await interaction.update({
        content: "Restarting the bot...",
        components: [],
      });
      this.restartBot();
    }
  }

  public restartBot(): void {
    console.log("Bot is being restarted.. byebye!");
    const isPM2 = !!(process.env.pm_id || process.env.PM2_HOME);
    process.exit(isPM2 ? 0 : 51); // 51 => ask parent to relaunch
  }
}
