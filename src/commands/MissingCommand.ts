import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface.js";
import { checkMissingPlayersInVC } from "../util/Utils";

export default class MissingCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("missing")
    .setDescription(
      "Check which players are missing from a team's voice channel."
    )
    .addStringOption((option) =>
      option
        .setName("team")
        .setDescription("The team to check (RED or BLUE)")
        .setRequired(true)
        .addChoices(
          { name: "RED", value: "RED" },
          { name: "BLUE", value: "BLUE" }
        )
    );

  name = "missing";
  description = "Check missing players in team voice channels.";
  buttonIds = [];

  async execute(interaction: ChatInputCommandInteraction) {
    const team = interaction.options.getString("team", true) as "RED" | "BLUE";
    await checkMissingPlayersInVC(interaction.guild!, team, async (msg) => {
      await interaction.reply({ content: msg, ephemeral: false });
    });
  }
}
