import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import { Command } from "../commands/CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { Team } from "@prisma/client";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import TeamCommand from "../commands/TeamCommand";
import { PrismaUtils } from "../util/PrismaUtils";
import { escapeText } from "../util/Utils";
import { AutoCaptainSelector } from "../logic/AutoCaptainSelector";

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
          .addStringOption((option) =>
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
      )
      .addSubcommand((sub) =>
        sub
          .setName("randomise")
          .setDescription(
            "Randomly select two captains based on eligibility (elo + presence)."
          )
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.reply({
        content: "Only organisers can use this command!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subCommand = interaction.options.getSubcommand(true);

    const game = CurrentGameManager.getCurrentGame();

    if (!game.announced) {
      await interaction.reply({
        content: "No game has been announced yet!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (this.teamCommand.isTeamPickingSessionActive()) {
      await interaction.reply({
        content: "You can't change captains while team picking is in progress!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subCommand === "randomise") {
      const result = await AutoCaptainSelector.randomiseCaptains(
        interaction.guild,
        false
      );
      if ("error" in result) {
        await interaction.reply({
          content: result.error,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply(
        `Captains have been selected:\n🔵 Blue: **${escapeText(result.blue.ignUsed ?? "Unknown")}**\n🔴 Red: **${escapeText(result.red.ignUsed ?? "Unknown")}**`
      );
      return;
    }

    const teamColor = interaction.options
      .getString("team", true)
      .toUpperCase() as Team;
    const input = interaction.options.getString("user", true);
    const resolvedPlayer = await PrismaUtils.findPlayer(input);

    if (!resolvedPlayer) {
      await interaction.reply({
        content: "Error: Player not found. Have they registered?",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let player = game
      .getPlayers()
      .find((p) => p.discordSnowflake === resolvedPlayer.discordSnowflake);

    if (!player) {
      await interaction.reply({
        content: "Error: Has this player registered yet? ",
        flags: MessageFlags.Ephemeral,
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
        flags: MessageFlags.Ephemeral,
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
      resolvedPlayer.discordSnowflake
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
      content: `Successfully set captain of team **${teamColor.toLowerCase()}** to **${escapeText(
        player.ignUsed ?? "Unknown Player"
      )}**.`,
    });
  }
}
