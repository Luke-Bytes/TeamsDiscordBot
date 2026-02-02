import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PlayerInstance } from "../database/PlayerInstance";

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
    const lateSignups = game.lateSignups;
    const allPlayers: PlayerInstance[] = teams
      .map((team) => game.getPlayersOfTeam(team))
      .flat();

    if (allPlayers.length === 0) {
      await interaction.reply({
        content: "No players are currently registered.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const regularPlayers = allPlayers.filter(
      (p) => !lateSignups.has(p.discordSnowflake)
    );
    const latePlayers = allPlayers.filter((p) =>
      lateSignups.has(p.discordSnowflake)
    );

    const regularList = regularPlayers
      .map((p) => `${p.ignUsed ?? "Unknown Player"}`)
      .join("\n");
    const lateList = latePlayers
      .map((p) => `${p.ignUsed ?? "Unknown Player"}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`Registered Players (${regularPlayers.length})`)
      .setColor(0x00ae86);

    if (allPlayers.length > 0) {
      embed.setDescription(`\`\`\`\n${regularList}\n\`\`\``);
    } else {
      embed.setDescription("No players have registered yet.");
    }

    if (latePlayers.length > 0) {
      embed.addFields({
        name: `Late Signups (${latePlayers.length})`,
        value: `\`\`\`\n${lateList}\n\`\`\``,
      });
    }

    await interaction.reply({ embeds: [embed] });
  }
}
