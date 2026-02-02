import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import { Command } from "../commands/CommandInterface.js";
import { cleanUpAfterGame } from "../logic/GameEndCleanUp.js";
import { PermissionsUtil } from "../util/PermissionsUtil";

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
      const isAuthorized = await PermissionsUtil.isUserAuthorised(interaction);
      if (!isAuthorized) return;

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
      });
    }
  }
  async handleButtonPress(interaction: ButtonInteraction) {
    if (interaction.customId === "cleanup_confirm") {
      try {
        await interaction.update({
          content:
            "✅ Cleanup process initiated! Cleaning up the game instance. This may take a moment...",
          components: [],
        });

        const guild = interaction.guild;

        if (!guild) {
          await interaction.followUp({
            content: "This command can only be used in a guild.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await cleanUpAfterGame(guild);

        await interaction.followUp({
          content: "✅ Cleanup completed successfully.",
        });
      } catch (error) {
        console.error("Error during cleanup:", error);

        await interaction.followUp({
          content: "❌ Cleanup failed. Check the logs for details.",
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
