import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PlayerInstance } from "database/PlayerInstance";

export default class RegisteredCommand implements Command {
  name = "registered";
  description = "Displays currently registered players";
  buttonIds = [];
  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description);

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const game = CurrentGameManager.getCurrentGame();
    const players: PlayerInstance[] = game.getPlayersOfTeam("UNDECIDED");

    if (players.length === 0) {
      await interaction.reply({
        content: "No players are currently registered.",
        ephemeral: true,
      });
      return;
    }

    const playerList = players
      .map((p, i) => `${p.ignUsed ?? "Unknown Player"}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`Registered Players (${players.length})`)
      .setDescription(`\`\`\`\n${playerList}\n\`\`\``)
      .setColor(0x00ae86);

    await interaction.reply({ embeds: [embed] });
  }
}
