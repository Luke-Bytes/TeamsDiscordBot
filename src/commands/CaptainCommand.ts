import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "../commands/CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { Team } from "@prisma/client";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import TeamCommand from "../commands/TeamCommand";

export default class CaptainCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "captain";
  public description = "Set or change the captain of a team";
  public buttonIds: string[] = [];
  private readonly teamCommand: TeamCommand;

  constructor(teamCommand: TeamCommand) {
    this.teamCommand = teamCommand;
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Set a team captain")
          .addUserOption((option) =>
            option
              .setName("user")
              .setDescription("The player to set as captain")
              .setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName("team")
              .setDescription("Team Colour")
              .setRequired(true)
              .addChoices(
                { name: "blue", value: "blue" },
                { name: "red", value: "red" }
              )
          )
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.reply({
        content: "Only organisers can use this command!",
        ephemeral: true,
      });
      return;
    }

    const teamColor = interaction.options
      .getString("team", true)
      .toUpperCase() as Team;
    const user = interaction.options.getUser("user", true);
    const game = CurrentGameManager.getCurrentGame();

    if (!game.announced) {
      await interaction.reply({
        content: "No game has been announced yet!",
        ephemeral: true,
      });
      return;
    }

    if (this.teamCommand.isTeamPickingSessionActive()) {
      await interaction.reply({
        content: "You can't change captains while team picking is in progress!",
        ephemeral: true,
      });
      return;
    }

    let player = game
      .getPlayers()
      .find((player) => player.discordSnowflake === user.id);

    if (!player) {
      await interaction.reply({
        content: "Error: Has this player registered yet? ",
        ephemeral: true,
      });
      return;
    }

    const currentTeam = game.getPlayersTeam(player);

    if (
      currentTeam !== "UNDECIDED" &&
      currentTeam !== "RED" &&
      currentTeam !== "BLUE"
    ) {
      await interaction.reply({
        content: `Error: The player must already be in RED, BLUE, or UNDECIDED team to be assigned as captain.`,
        ephemeral: true,
      });
      return;
    }

    const captains = game.setTeamCaptain(teamColor, player);

    if (captains.oldCaptain) {
      const oldCaptainMember = await interaction.guild.members.fetch(
        captains.oldCaptain
      );
      await oldCaptainMember.roles.remove(
        PermissionsUtil.config.roles.captainRole
      );
    }

    const newCaptainMember = await interaction.guild.members.fetch(
      captains.newCaptain
    );
    await newCaptainMember.roles.add(PermissionsUtil.config.roles.captainRole);

    if (teamColor === "RED") {
      await newCaptainMember.roles.add(
        PermissionsUtil.config.roles.redTeamRole
      );
      await newCaptainMember.roles.remove(
        PermissionsUtil.config.roles.blueTeamRole
      );
    } else if (teamColor === "BLUE") {
      await newCaptainMember.roles.add(
        PermissionsUtil.config.roles.blueTeamRole
      );
      await newCaptainMember.roles.remove(
        PermissionsUtil.config.roles.redTeamRole
      );
    }

    await interaction.reply({
      content: `Successfully set captain of team **${teamColor.toLowerCase()}** to **${player.ignUsed}**.`,
    });
  }
}
