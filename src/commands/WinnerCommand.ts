import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PermissionsUtil } from "../util/PermissionsUtil";

export default class WinnerCommand implements Command {
  name = "winner";
  description = "Sets the winning team.";
  buttonIds = [];

  data = new SlashCommandBuilder()
    .setName("winner")
    .setDescription("Manage game winner")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set the game winner")
        .addStringOption((option) =>
          option
            .setName("team")
            .setDescription("The winning team")
            .setRequired(true)
            .addChoices(
              { name: "BLUE", value: "BLUE" },
              { name: "RED", value: "RED" }
            )
        )
    );

  async execute(interaction: ChatInputCommandInteraction) {
    const isAuthorized = await PermissionsUtil.isUserAuthorised(interaction);
    if (!isAuthorized) return;

    const team = interaction.options.getString("team", true).toUpperCase();

    if (team !== "BLUE" && team !== "RED") {
      await interaction.reply({
        content: "Invalid team selected. Choose either BLUE or RED.",
        ephemeral: true,
      });
      return;
    }

    try {
      await CurrentGameManager.getCurrentGame().setGameWinner(team);
      await interaction.reply({
        content: `The winning team has been set to **${team}**!`,
        ephemeral: false,
      });
    } catch (error) {
      console.error("Failed to set game winner: ", error);
      await interaction.reply({
        content: "An error occurred while setting the winner.",
        ephemeral: false,
      });
    }
  }
}
