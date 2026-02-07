import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { PermissionsUtil } from "../util/PermissionsUtil.js";
import { CurrentGameManager } from "../logic/CurrentGameManager.js";
import { Team } from "@prisma/client";
import TeamCommand from "../commands/TeamCommand";
import { DraftTeamPickingSession } from "../logic/teams/DraftTeamPickingSession";
import { ConfigManager } from "../ConfigManager";
import { DiscordUtil } from "../util/DiscordUtil";

export default class UnregisterCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "unregister";
  public description = "Unregister from the announced game!";
  public buttonIds: string[] = [];

  private readonly teamCommand: TeamCommand;

  constructor(teamCommand: TeamCommand) {
    this.teamCommand = teamCommand;
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addUserOption((option) =>
        option
          .setName("discorduser")
          .setDescription("The Discord user to unregister (organisers only)")
          .setRequired(false)
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!PermissionsUtil.isChannel(interaction, "registration")) {
      await interaction.reply({
        content: "You can only unregister in the registration channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const game = CurrentGameManager.getCurrentGame();

    if (!game.announced) {
      await interaction.reply({
        content: "No game has been announced yet!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser =
      interaction.options.getUser("discorduser") || interaction.user;

    if (
      !PermissionsUtil.hasRole(
        interaction.guild?.members.cache.get(interaction.user.id),
        "organiserRole"
      ) &&
      !PermissionsUtil.isSameUser(interaction, targetUser.id)
    ) {
      await interaction.reply({
        content: "You do not have permission to unregister other users.",
      });
      return;
    }

    const discordUserId = targetUser.id;
    const discordUserName = targetUser.username;

    const isRegistered = CurrentGameManager.getCurrentGame()
      .getPlayers()
      .some((player) => player.discordSnowflake === discordUserId);

    if (!isRegistered) {
      await interaction.reply({
        content: `${discordUserName} is not registered for the announced game.`,
      });
      return;
    }

    const now = new Date();
    const startTime = game.startTime || now;
    const isLate =
      game.isFinished ||
      (game.teamsDecidedBy &&
        now.getTime() - startTime.getTime() > 30 * 60 * 1000);

    if (isLate) {
      await interaction.reply({
        content:
          "The game has already started, it's too late to unregister now!",
      });
      return;
    }

    const userTeam = Object.keys(game.teams).find((team) =>
      game.teams[team as Team].some(
        (player) => player.discordSnowflake === discordUserId
      )
    );

    if (this.teamCommand.isTeamPickingSessionActive()) {
      await interaction.reply({
        content: `${discordUserName} has been unregistered but will be punished for unregistering while teams were being drafted.`,
      });
      //   TODO remove player from draft embed
    }

    if (userTeam && userTeam !== "UNDECIDED" && game.teamsDecidedBy) {
      await interaction.reply({
        content: `${discordUserName} has been unregistered but will be punished for unregistering after teams were decided.`,
      });
    }

    const result =
      await CurrentGameManager.getCurrentGame().removePlayerByDiscordId(
        discordUserId
      );

    if (!result?.error) {
      const member = await interaction.guild?.members
        .fetch(discordUserId)
        .catch(() => null);
      if (member) {
        const roles = ConfigManager.getConfig().roles;
        const roleIds = [
          roles.captainRole,
          roles.redTeamRole,
          roles.blueTeamRole,
        ].filter(Boolean);
        for (const roleId of roleIds) {
          await DiscordUtil.removeRole(member, roleId);
        }
      }

      const session = this.teamCommand.teamPickingSession;
      if (session instanceof DraftTeamPickingSession) {
        await session.handleUnregister(discordUserId);
      }
      const message = PermissionsUtil.isSameUser(interaction, targetUser.id)
        ? `You have successfully unregistered from the game!`
        : `${discordUserName} has been successfully unregistered.`;

      await interaction.reply({
        content: message,
      });
    } else {
      await interaction.reply({
        content: result?.error || `An unexpected error occurred.`,
      });
    }
  }
}
