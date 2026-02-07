import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { checkMissingPlayersInVC } from "../util/Utils";
import { PermissionsUtil } from "../util/PermissionsUtil";

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
        .setRequired(false)
        .addChoices(
          { name: "RED", value: "RED" },
          { name: "BLUE", value: "BLUE" }
        )
    );

  name = "missing";
  description = "Check missing players in team voice channels.";
  buttonIds = [];

  async execute(interaction: ChatInputCommandInteraction) {
    if (
      !PermissionsUtil.isChannel(interaction, "redTeamChat") &&
      !PermissionsUtil.isChannel(interaction, "blueTeamChat")
    ) {
      await interaction.reply({
        content:
          "This command can only be used in the red or blue team channels.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const requestedTeam = interaction.options.getString("team");
    let team: "RED" | "BLUE";
    if (requestedTeam === "RED" || requestedTeam === "BLUE") {
      team = requestedTeam;
    } else if (PermissionsUtil.isChannel(interaction, "redTeamChat")) {
      team = "RED";
    } else {
      team = "BLUE";
    }

    await checkMissingPlayersInVC(interaction.guild!, team, async (msg) => {
      await interaction.reply({ content: msg });
    });
  }
}
