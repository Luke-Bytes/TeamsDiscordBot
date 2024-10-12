import {
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  ButtonStyle,
} from "discord.js";
import { promises as fs } from "fs";
import { GuildMemberRoleManager } from "discord.js";

export class RandomTeams {
  constructor() {}

  public async handleButtonInteraction(interaction: ButtonInteraction) {
    const config = await fs.readFile("./config.json", "utf-8").then(JSON.parse);

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
          this.randomizeTeams(); // Randomize teams and update GameData globally
          await interaction.editReply(this.createEmbedMessage());
          break;
        case "cancel":
          // Clear the global blue and red team players
          GameData.setBluePlayers([]);
          GameData.setRedPlayers([]);
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
