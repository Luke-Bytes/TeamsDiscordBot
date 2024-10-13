import { ButtonInteraction } from "discord.js";
import { GuildMemberRoleManager } from "discord.js";
import { ConfigManager } from "ConfigManager";

export class RandomTeams {
  constructor() {}

  public async handleButtonInteraction(interaction: ButtonInteraction) {
    const config = ConfigManager.getConfig();

    if (
      interaction.member?.roles instanceof GuildMemberRoleManager &&
      interaction.member.roles.cache.has(config.roles.organiserRole)
    ) {
      await interaction.deferUpdate();

      switch (interaction.customId) {
        case "accept":
          await interaction.editReply({
            content: "Teams accepted. (Placeholder for role logic)",
            components: [],
          });
          break;
        case "reroll":
          break;
        case "cancel":
          // Clear the global blue and red team players
          await interaction.editReply({
            content: "Team selection canceled.",
            components: [],
          });
          break;
      }
    } else {
      await interaction.reply({
        content: "You do not have permission to perform this action!",
        ephemeral: true,
      });
    }
  }
}
