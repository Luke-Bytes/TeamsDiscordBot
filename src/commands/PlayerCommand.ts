import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import { Command } from "./CommandInterface";
import { Team } from "@prisma/client";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { PrismaUtils } from "../util/PrismaUtils";
import CaptainPlanDMManager, {
  PlanMember,
} from "../logic/CaptainPlanDMManager";
import { GameInstance } from "../database/GameInstance";
import { PlayerInstance } from "../database/PlayerInstance";
import { escapeText } from "../util/Utils";

type ExtendedTeam = Team | "UNDECIDED";

export default class PlayerCommand implements Command {
  name = "player";
  description = "Manage players and teams";
  buttonIds: string[] = [];
  private captainPlanDMManager?: CaptainPlanDMManager;

  constructor(captainPlanDMManager?: CaptainPlanDMManager) {
    this.captainPlanDMManager = captainPlanDMManager;
  }

  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("move")
        .setDescription("Move a player between teams")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription("Player to move")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("from")
            .setDescription("Current team of the player")
            .setRequired(true)
            .addChoices(
              { name: "RED", value: "RED" },
              { name: "BLUE", value: "BLUE" },
              { name: "NONE", value: "UNDECIDED" }
            )
        )
        .addStringOption((option) =>
          option
            .setName("to")
            .setDescription("New team for the player")
            .setRequired(true)
            .addChoices(
              { name: "RED", value: "RED" },
              { name: "BLUE", value: "BLUE" },
              { name: "NONE", value: "UNDECIDED" }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add a player to a team")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription("Player to add")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("team")
            .setDescription("Team to add the player to")
            .setRequired(true)
            .addChoices(
              { name: "RED", value: "RED" },
              { name: "BLUE", value: "BLUE" },
              { name: "NONE", value: "UNDECIDED" }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a player")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription("Player to remove")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("replace")
        .setDescription("Replace a player with another")
        .addStringOption((option) =>
          option
            .setName("old_player")
            .setDescription("Player currently on a team")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("new_player")
            .setDescription("Player not currently on a team")
            .setRequired(true)
        )
    );

  async execute(interaction: ChatInputCommandInteraction) {
    const member = interaction.member as GuildMember;

    if (!member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.reply({
        content: "You do not have permission to use this command.",
        ephemeral: false,
      });
      return;
    }

    const game = CurrentGameManager.getCurrentGame();
    const beforeRosters = this.captureTeamRosters(game);
    const subcommand = interaction.options.getSubcommand();

    try {
      const inputPlayer = interaction.options.getString("player", false);
      const inputOldPlayer = interaction.options.getString("old_player", false);
      const inputNewPlayer = interaction.options.getString("new_player", false);

      const playerInputs =
        inputPlayer !== null ? inputPlayer.split(/\s+/).filter(Boolean) : [];
      const resolvedPlayers =
        playerInputs.length > 0
          ? await Promise.all(
              playerInputs.map(async (token) => {
                const match = await PrismaUtils.findPlayer(token);
                const name = match?.latestIGN ?? token;
                return { name, safeName: escapeText(name) };
              })
            )
          : [];

      const newTeam =
        subcommand === "move"
          ? interaction.options.getString("to")
          : interaction.options.getString("team");

      let oldPlayerName = "";
      let targetPlayerName = "";
      let safeOldPlayerName = "";
      let safeTargetPlayerName = "";

      if (
        (subcommand === "move" ||
          subcommand === "add" ||
          subcommand === "remove") &&
        resolvedPlayers.length === 0
      ) {
        await interaction.reply(
          "No players provided. Supply one or more names separated by spaces."
        );
        return;
      }

      if (subcommand === "replace") {
        const oldPlayer =
          inputOldPlayer !== null
            ? await PrismaUtils.findPlayer(inputOldPlayer)
            : null;
        const targetPlayer =
          inputNewPlayer !== null
            ? await PrismaUtils.findPlayer(inputNewPlayer)
            : null;

        oldPlayerName = oldPlayer?.latestIGN ?? inputOldPlayer ?? "";
        targetPlayerName = targetPlayer?.latestIGN ?? inputNewPlayer ?? "";
        safeOldPlayerName = escapeText(oldPlayerName);
        safeTargetPlayerName = escapeText(targetPlayerName);
      }

      switch (subcommand) {
        case "move": {
          const fromTeam = interaction.options.getString(
            "from",
            true
          ) as ExtendedTeam;
          const toTeam = interaction.options.getString(
            "to",
            true
          ) as ExtendedTeam;

          const moved: string[] = [];
          const failed: string[] = [];

          for (const player of resolvedPlayers) {
            const success = await game.movePlayerBetweenTeams(
              player.name,
              fromTeam,
              toTeam,
              interaction.guild
            );
            if (success) {
              moved.push(player.safeName);
            } else {
              failed.push(player.safeName);
            }
          }

          const successMessage = moved.length
            ? `Successfully moved **${moved.join(
                ", "
              )}** from **${fromTeam.toUpperCase()}** to **${toTeam.toUpperCase()}**.`
            : "";
          const failureMessage = failed.length
            ? `Failed to move **${failed.join(
                ", "
              )}**. Ensure they are currently in **${fromTeam.toUpperCase()}** and the move is valid.`
            : "";

          await interaction.reply(
            [successMessage, failureMessage].filter(Boolean).join("\n")
          );
          if (moved.length > 0) {
            await this.syncLateJoinerPrompts(game, beforeRosters, interaction);
          }
          break;
        }

        case "add": {
          const added: string[] = [];
          const failed: string[] = [];

          for (const player of resolvedPlayers) {
            const success = await game.addPlayerByNameOrDiscord(
              player.name,
              newTeam as ExtendedTeam,
              interaction.guild
            );
            if (success) {
              added.push(player.safeName);
            } else {
              failed.push(player.safeName);
            }
          }

          const successMessage = added.length
            ? `Successfully added **${added.join(
                ", "
              )}** to **${newTeam?.toUpperCase()}**.`
            : "";
          const failureMessage = failed.length
            ? `Failed to add **${failed.join(
                ", "
              )}**. Ensure the player is registered with \`/register\`.`
            : "";

          await interaction.reply(
            [successMessage, failureMessage].filter(Boolean).join("\n")
          );
          if (added.length > 0) {
            await this.syncLateJoinerPrompts(game, beforeRosters, interaction);
          }
          break;
        }

        case "remove": {
          const removed: string[] = [];
          const failed: string[] = [];

          for (const player of resolvedPlayers) {
            const success = await game.removePlayerByNameOrDiscord(
              player.name,
              interaction.guild
            );
            if (success) {
              removed.push(player.safeName);
            } else {
              failed.push(player.safeName);
            }
          }

          const successMessage = removed.length
            ? `Successfully removed **${removed.join(", ")}** from the game.`
            : "";
          const failureMessage = failed.length
            ? `Failed to remove **${failed.join(
                ", "
              )}**. The player could not be found in any team.`
            : "";

          await interaction.reply(
            [successMessage, failureMessage].filter(Boolean).join("\n")
          );
          if (removed.length > 0) {
            await this.syncLateJoinerPrompts(game, beforeRosters, interaction);
          }
          break;
        }

        case "replace": {
          const success = await game.replacePlayerByNameOrDiscord(
            oldPlayerName,
            targetPlayerName,
            interaction.guild
          );
          await interaction.reply(
            success
              ? `Successfully replaced **${safeOldPlayerName}** with **${safeTargetPlayerName}** in their current team.`
              : `Failed to replace **${safeOldPlayerName}**. Ensure both players are correctly registered and in the appropriate teams.`
          );
          if (success) {
            await this.syncLateJoinerPrompts(game, beforeRosters, interaction);
          }
          break;
        }

        default: {
          await interaction.reply("Unknown subcommand. Please try again.");
          break;
        }
      }
    } catch (error) {
      console.error(error);
      await interaction.reply(
        "An unexpected error occurred while managing players."
      );
    }
  }

  private captureTeamRosters(
    game: GameInstance
  ): Record<"RED" | "BLUE", PlanMember[]> {
    return {
      RED: game.getPlayersOfTeam("RED").map((p) => this.toPlanMember(p)),
      BLUE: game.getPlayersOfTeam("BLUE").map((p) => this.toPlanMember(p)),
    };
  }

  private toPlanMember(player: PlayerInstance): PlanMember {
    return {
      id: player.discordSnowflake,
      ign: player.ignUsed ?? player.latestIGN ?? "Unknown",
    };
  }

  private diffNewMembers(
    before: Record<"RED" | "BLUE", PlanMember[]>,
    after: Record<"RED" | "BLUE", PlanMember[]>
  ): Record<"RED" | "BLUE", PlanMember[]> {
    const added: Record<"RED" | "BLUE", PlanMember[]> = { RED: [], BLUE: [] };
    (["RED", "BLUE"] as const).forEach((team) => {
      const beforeIds = new Set(before[team].map((m) => m.id));
      added[team] = after[team].filter((m) => !beforeIds.has(m.id));
    });
    return added;
  }

  private async syncLateJoinerPrompts(
    game: GameInstance,
    beforeRosters: Record<"RED" | "BLUE", PlanMember[]>,
    interaction: ChatInputCommandInteraction
  ) {
    if (!this.captainPlanDMManager) return;
    const client = interaction.client;
    if (!client || !client.users) return;
    const afterRosters = this.captureTeamRosters(game);
    const added = this.diffNewMembers(beforeRosters, afterRosters);

    const redCaptain = game.getCaptainOfTeam("RED");
    if (redCaptain) {
      await this.captainPlanDMManager.handleRosterUpdate({
        captainId: redCaptain.discordSnowflake,
        team: "RED",
        members: afterRosters.RED,
        newJoiners: added.RED,
        client,
      });
    }

    const blueCaptain = game.getCaptainOfTeam("BLUE");
    if (blueCaptain) {
      await this.captainPlanDMManager.handleRosterUpdate({
        captainId: blueCaptain.discordSnowflake,
        team: "BLUE",
        members: afterRosters.BLUE,
        newJoiners: added.BLUE,
        client,
      });
    }
  }
}
