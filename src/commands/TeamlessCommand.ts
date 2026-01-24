import { Command } from "./CommandInterface.js";
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { GameInstance } from "../database/GameInstance";
import { escapeText } from "../util/Utils";

export default class TeamlessCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("teamless")
    .setDescription("Displays all the registered players not on a team");

  name = "teamless";
  description = "Displays all the registered players not on a team";
  buttonIds = [];

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const gameInstance = GameInstance.getInstance();
    const undecidedPlayers = gameInstance.getPlayersOfTeam("UNDECIDED");

    const embed = new EmbedBuilder()
      .setTitle("Teamless Players")
      .setDescription(
        undecidedPlayers.length
          ? undecidedPlayers
              .map((player) =>
                escapeText(player.ignUsed ?? "Unknown Player")
              )
              .join("\n")
          : "No registered players without a team."
      )
      .setColor("Yellow");

    await interaction.reply({ embeds: [embed], ephemeral: false });
  }
}
