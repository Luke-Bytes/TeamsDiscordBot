import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface.js";
import { DiscordUtil } from "../util/DiscordUtil.js";
import { GameInstance } from "../database/GameInstance"; // Adjust path based on your structure

export default class CaptainNominateCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("captainnominate")
    .setDescription("Nominate yourself to be a captain");

  name = "captainnominate";
  description = "Nominate yourself to be a captain";
  buttonIds = [];

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!GameInstance.getInstance().announced) {
      await interaction.reply({
        content: "No game has been announced!",
        ephemeral: true,
      });
      return;
    }
    const user = interaction.user;
    await DiscordUtil.sendMessage(
      "gameFeed",
      `@${user.tag} has nominated themselves to be a captain!`
    );
    await interaction.reply({
      content: "You have nominated yourself to be a captain!",
      ephemeral: true,
    });
  }
}
