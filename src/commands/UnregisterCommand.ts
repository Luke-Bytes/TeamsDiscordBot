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
import { ConfigManager } from "../ConfigManager";
import { discordErrorCode } from "../util/DiscordFailures";

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

    await interaction.deferReply();

    const now = new Date();
    const startTime = game.startTime || now;
    const isLate =
      game.isFinished ||
      (game.teamsDecidedBy &&
        now.getTime() - startTime.getTime() > 30 * 60 * 1000);

    if (isLate || game.getGameStartStatus() !== "idle") {
      await interaction.editReply({
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

    // Penalty warnings do not create a punishment record: leave discipline
    // to the established organiser workflow, not a misleading promise.
    const policyWarning = this.teamCommand.isTeamPickingSessionActive()
      ? " This was during team picking and may be reviewed by organisers."
      : userTeam && userTeam !== "UNDECIDED" && game.teamsDecidedBy
        ? " Teams were already decided; organisers may review this withdrawal."
        : "";

    let draftSyncFailed = false;
    const result = await this.teamCommand.runRosterOperation(async () => {
      const removed = await game.removePlayerByDiscordId(discordUserId);
      if (!removed?.error) {
        const session = this.teamCommand.teamPickingSession;
        try {
          await session?.handleUnregister?.(discordUserId);
        } catch (error) {
          draftSyncFailed = true;
          console.error(`Unregister draft sync failed member=${discordUserId}`, error);
        }
      }
      return removed;
    });

    if (!result?.error) {
      const warnings: string[] = draftSyncFailed
        ? ["The team-picking display could not be updated; ask an organiser to check it."]
        : [];
      try {
        const member = await interaction.guild?.members.fetch(discordUserId);
        if (member) {
          const roles = ConfigManager.getConfig().roles;
          for (const roleId of [
            roles.captainRole,
            roles.redTeamRole,
            roles.blueTeamRole,
          ].filter(Boolean)) {
            try {
              await member.roles.remove(roleId);
            } catch (error) {
              console.error(`Unregister role cleanup failed member=${discordUserId} role=${roleId}`, error);
              warnings.push("Discord roles could not be fully cleaned up.");
            }
          }
        }
      } catch (error) {
        if (discordErrorCode(error) !== 10007) {
          console.warn(`Unregister member lookup failed member=${discordUserId}`, error);
          warnings.push("Discord member/role cleanup was unavailable.");
        }
      }
      const message = PermissionsUtil.isSameUser(interaction, targetUser.id)
        ? "You have successfully unregistered from the game!"
        : `${discordUserName} has been successfully unregistered.`;
      await interaction.editReply({
        content: [message + policyWarning, ...new Set(warnings)].join(" "),
      });
    } else {
      await interaction.editReply({
        content: result?.error || "An unexpected error occurred.",
      });
    }
  }
}
