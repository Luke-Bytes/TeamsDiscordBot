import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import { Command } from "./CommandInterface";
import { Team } from "@prisma/client";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PermissionsUtil } from "../util/PermissionsUtil";

type ExtendedTeam = Team | "UNDECIDED";

export default class PlayerCommand implements Command {
  name = "player";
  description = "Manage players and teams";
  buttonIds: string[] = [];

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
    const subcommand = interaction.options.getSubcommand();

    try {
      const playerName = interaction.options.getString("player", true);
      const newTeam =
        subcommand === "move"
          ? interaction.options.getString("to")
          : interaction.options.getString("team");

      const targetPlayer = interaction.options.getString("new_player") ?? "";
      const oldPlayer = interaction.options.getString("old_player") ?? "";

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

          const success = await game.movePlayerBetweenTeams(
            playerName,
            fromTeam,
            toTeam,
            interaction.guild
          );

          await interaction.reply(
            success
              ? `Successfully moved **${playerName}** from **${fromTeam.toUpperCase()}** to **${toTeam.toUpperCase()}**.`
              : `Failed to move **${playerName}**. Ensure they are currently in **${fromTeam.toUpperCase()}** and the move is valid.`
          );
          break;
        }

        case "add": {
          await interaction.reply(
            (await game.addPlayerByNameOrDiscord(
              playerName,
              newTeam as ExtendedTeam,
              interaction.guild
            ))
              ? `Successfully added **${playerName}** to **${newTeam?.toUpperCase()}**.`
              : `Failed to add **${playerName}**. Ensure the player is registered with \`/register\`.`
          );
          break;
        }

        case "remove": {
          await interaction.reply(
            (await game.removePlayerByNameOrDiscord(
              playerName,
              interaction.guild
            ))
              ? `Successfully removed **${playerName}** from the game.`
              : `Failed to remove **${playerName}**. The player could not be found in any team.`
          );
          break;
        }

        case "replace": {
          await interaction.reply(
            (await game.replacePlayerByNameOrDiscord(
              oldPlayer,
              targetPlayer,
              interaction.guild
            ))
              ? `Successfully replaced **${oldPlayer}** with **${targetPlayer}** in their current team.`
              : `Failed to replace **${oldPlayer}**. Ensure both players are correctly registered and in the appropriate teams.`
          );
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
}
