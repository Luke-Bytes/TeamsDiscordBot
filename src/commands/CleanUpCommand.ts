import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  GuildMemberRoleManager,
} from "discord.js";
import { Command } from "./CommandInterface";
import { ConfigManager } from "../ConfigManager";
import { cleanUpAfterGame } from "logic/GameEndCleanUp";

export default class CleanupCommand implements Command {
  name = "cleanup";
  description = "Force cleanup game instance data.";
  buttonIds = ["cleanup_confirm", "cleanup_cancel"];

  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addSubcommand((sub) =>
      sub
        .setName("force")
        .setDescription("Forcefully reset game instance data.")
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "force") {
      const config = ConfigManager.getConfig();
      const organiserRole = config.roles.organiserRole;

      const roles = interaction.member?.roles;
      if (
        !(roles instanceof GuildMemberRoleManager) ||
        !roles.cache.has(organiserRole)
      ) {
        await interaction.reply({
          content: "You must have the organiser role to use this command.",
          ephemeral: true,
        });
        return;
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("cleanup_confirm")
          .setLabel("Confirm")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("cleanup_cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        content:
          "⚠️ **WARNING:** This command is for debugging only and should not be used carelessly. Confirm to proceed or cancel.",
        components: [row],
        ephemeral: true,
      });
    }
  }

  async handleButtonPress(interaction: ButtonInteraction) {
    if (interaction.customId === "cleanup_confirm") {
      await interaction.update({
        content: "✅ Cleanup process initiated!",
        components: [],
      });

      await interaction.reply({
        content: "Cleaning up after the game. This may take a moment...",
        ephemeral: true,
      });

      const guild = interaction.guild;

      if (!guild) {
        await interaction.reply({
          content: "This command can only be used in a guild.",
          ephemeral: true,
        });
        return;
      }

      try {
        await cleanUpAfterGame(guild);
        await interaction.followUp({
          content: "✅ Cleanup completed successfully.",
          ephemeral: true,
        });
      } catch (error) {
        console.error("Error during cleanup:", error);
        await interaction.followUp({
          content: "❌ Cleanup failed. Check the logs for details.",
          ephemeral: true,
        });
      }
    } else if (interaction.customId === "cleanup_cancel") {
      await interaction.update({
        content: "❌ Cleanup process cancelled.",
        components: [],
      });
    }
  }
}
