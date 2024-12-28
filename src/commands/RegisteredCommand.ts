import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PlayerInstance } from "../database/PlayerInstance";

type Team = "UNDECIDED" | "RED" | "BLUE";

export default class RegisteredCommand implements Command {
  name = "registered";
  description = "Displays currently registered players";
  buttonIds = [];
  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description);

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const game = CurrentGameManager.getCurrentGame();
    const teams: ("UNDECIDED" | "RED" | "BLUE")[] = [
      "UNDECIDED",
      "RED",
      "BLUE",
    ];
    const allPlayers: PlayerInstance[] = teams
      .map((team) => game.getPlayersOfTeam(team))
      .flat();

    if (allPlayers.length === 0) {
      await interaction.reply({
        content: "No players are currently registered.",
        ephemeral: true,
      });
      return;
    }

    const playerList = allPlayers
      .map((p) => `${p.ignUsed ?? "Unknown Player"}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`Registered Players (${allPlayers.length})`)
      .setDescription(`\`\`\`\n${playerList}\n\`\`\``)
      .setColor(0x00ae86);

    await interaction.reply({ embeds: [embed] });
  }
}
