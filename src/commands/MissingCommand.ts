import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  VoiceChannel,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { ConfigManager } from "../ConfigManager";
import { GameInstance } from "../database/GameInstance";

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
    const team = interaction.options.getString("team", true).toUpperCase();
    const config = ConfigManager.getConfig();
    const vcId =
      team === "RED" ? config.channels.redTeamVC : config.channels.blueTeamVC;

    const vc = interaction.guild?.channels.cache.get(vcId) as VoiceChannel;

    if (!vc || vc.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: `No valid VC found for ${team} team.`,
        ephemeral: false,
      });
      return;
    }

    const membersInVC = Array.from(vc.members.values()).map(
      (member) => member.id
    );

    const gameInstance = GameInstance.getInstance();
    const teamPlayers = gameInstance.getPlayersOfTeam(team as "RED" | "BLUE");

    const missingPlayers = teamPlayers.filter(
      (player) => !membersInVC.includes(player.discordSnowflake)
    );

    if (missingPlayers.length === 0) {
      await interaction.reply({
        content: `No expected players missing from ${team} team's VC.`,
        ephemeral: false,
      });
    } else {
      const missingNames = missingPlayers
        .map((player) => `<@${player.discordSnowflake}>`)
        .join(", ");
      await interaction.reply({
        content: `The following ${team} players are missing from VC: \n${missingNames}`,
        ephemeral: false,
      });
    }
  }
}
