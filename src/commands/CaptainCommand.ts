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
import { escapeIgn } from "../util/Utils";
import { AutoCaptainSelector } from "../logic/AutoCaptainSelector";
import { fetchGuildMember } from "../util/DiscordFailures";

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

    await interaction.deferReply();
    let member;
    try {
      member = await fetchGuildMember(interaction.guild, interaction.user.id);
    } catch (error) {
      console.error("Captain command could not verify organiser membership", error);
      await interaction.editReply("Cannot verify organiser permissions with Discord right now.");
      return;
    }
    if (!PermissionsUtil.hasRole(member ?? undefined, "organiserRole")) {
      await interaction.editReply("Only organisers can use this command!");
      return;
    }

    const subCommand = interaction.options.getSubcommand(true);

    const game = CurrentGameManager.getCurrentGame();

    if (!game.announced || game.getGameStartStatus() !== "idle" || game.isFinished) {
      await interaction.editReply("Captains cannot be changed outside an announced, unstarted game.");
      return;
    }

    if (this.teamCommand.isTeamPickingSessionActive()) {
      await interaction.editReply("You can't change captains while team picking is in progress!");
      return;
    }
    const gameToken = game.getLifecycleToken();

    if (subCommand === "randomise") {
      const result = await this.teamCommand.runRosterOperation(() =>
        AutoCaptainSelector.randomiseCaptains(interaction.guild!, false)
      );
      if ("error" in result) {
        await interaction.editReply({
          content: result.error,
        });
        return;
      }
      await interaction.editReply(
        `Captains have been selected:\n🔵 Blue: **${escapeIgn(result.blue.ignUsed ?? "Unknown")}**\n🔴 Red: **${escapeIgn(result.red.ignUsed ?? "Unknown")}**`
      );
      return;
    }

    const teamColor = interaction.options
      .getString("team", true)
      .toUpperCase() as Team;
    const input = interaction.options.getString("user", true);
    const resolvedPlayer = await PrismaUtils.findPlayer(input);

    if (!resolvedPlayer) {
      await interaction.editReply("No player found with that name. Have they registered?");
      return;
    }

    let player = game
      .getPlayers()
      .find((p) => p.discordSnowflake === resolvedPlayer.discordSnowflake);

    if (!player) {
      await interaction.editReply("Error: Has this player registered yet?");
      return;
    }

    const currentTeam = game.getPlayersTeam(player);

    if (
      currentTeam !== "UNDECIDED" &&
      currentTeam !== "RED" &&
      currentTeam !== "BLUE"
    ) {
      await interaction.editReply("The player must be in RED, BLUE or UNDECIDED to be assigned as captain.");
      return;
    }

    let resultMessage: string;
    try {
      resultMessage = await this.teamCommand.runRosterOperation(async () => {
        if (!game.announced || game.isFinished || game.isRestarting ||
            game.getGameStartStatus() !== "idle" ||
            game.getLifecycleToken() !== gameToken ||
            this.teamCommand.isTeamPickingSessionActive()) {
          return "The game or drafting state changed; no captain was selected.";
        }
        const current = game.getPlayers().find((p) =>
          p.discordSnowflake === resolvedPlayer.discordSnowflake
        );
        if (!current) return "The selected player is no longer registered.";
        const newCaptainMember = await fetchGuildMember(interaction.guild!, current.discordSnowflake);
        if (!newCaptainMember) return "That user is no longer in the server.";

        const previousCaptain = game.getCaptainOfTeam(teamColor);
        const oldMember = previousCaptain &&
          previousCaptain.discordSnowflake !== current.discordSnowflake
          ? await fetchGuildMember(interaction.guild!, previousCaptain.discordSnowflake)
          : null;

        const roles = PermissionsUtil.config.roles;
        // Validate external member state and complete role changes before
        // committing the new captain to the authoritative roster.
        await newCaptainMember.roles.add(roles.captainRole);
        await newCaptainMember.roles.add(
          teamColor === "RED" ? roles.redTeamRole : roles.blueTeamRole
        );
        await newCaptainMember.roles.remove(
          teamColor === "RED" ? roles.blueTeamRole : roles.redTeamRole
        );
        if (oldMember) await oldMember.roles.remove(roles.captainRole);

        if (game.getLifecycleToken() !== gameToken || game.getGameStartStatus() !== "idle") {
          return "The game changed while Discord roles were being updated. Captain state was not changed.";
        }
        game.setTeamCaptain(teamColor, current);
        return `Successfully set captain of team **${teamColor.toLowerCase()}** to **${escapeIgn(current.ignUsed ?? "Unknown Player")}**.`;
      });
    } catch (error) {
      console.error(`Captain role update failed guild=${interaction.guild.id} player=${resolvedPlayer.discordSnowflake}`, error);
      resultMessage = "Discord role updates failed; captain assignment was not committed. Check roles before retrying.";
    }
    await interaction.editReply({ content: resultMessage });
  }
}
