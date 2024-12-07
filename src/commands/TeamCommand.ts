import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMemberRoleManager,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { ConfigManager } from "../ConfigManager";
import { GameInstance } from "../database/GameInstance";
import { PlayerInstance } from "../database/PlayerInstance";
import { DraftTeamPickingSession } from "../logic/teams/DraftTeamPickingSession";
import { RandomTeamPickingSession } from "../logic/teams/RandomTeamPickingSession";
import { TeamPickingSession } from "../logic/teams/TeamPickingSession";

export default class TeamCommand implements Command {
  public data: SlashCommandSubcommandsOnlyBuilder;
  public name = "team";
  public description = "Manage teams";
  public buttonIds: string[] = [
    "random-team-accept",
    "random-team-generate-reroll",
    "random-team-generate-cancel",
  ];

  private teamPickingSession?: TeamPickingSession;

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("generate")
          .setDescription("Generate teams")
          .addStringOption((option) =>
            option
              .setName("method")
              .setDescription("Method to generate teams")
              .setRequired(true)
              .addChoices(
                { name: "random", value: "random" },
                {
                  name: "draft",
                  value: "draft",
                }
              )
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("reset").setDescription("Reset the teams")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("List the current teams")
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = ConfigManager.getConfig();
    const subcommand = interaction.options.getSubcommand();
    const memberRoles = interaction.member?.roles;
    const isOrganiser =
      memberRoles instanceof GuildMemberRoleManager &&
      memberRoles.cache.has(config.roles.organiserRole);

    const game = CurrentGameManager.getCurrentGame();

    try {
      switch (subcommand) {
        case "generate": {
          if (!isOrganiser) {
            await interaction.reply({
              content: "You do not have permission to run this command!",
              ephemeral: true,
            });
            return;
          }

          if (!game.announced) {
            await interaction.reply({
              content:
                "A game has not been announced yet. Please use `/announce start`.",
              ephemeral: true,
            });
            return;
          }

          if (this.teamPickingSession) {
            await interaction.reply({
              content:
                "A team picking session is already in process. Cancel that one before creating another.",
              ephemeral: true,
            });
            return;
          }

          await interaction.deferReply({ ephemeral: false });

          const method = interaction.options.getString("method");

          switch (method) {
            case "random":
              this.teamPickingSession = new RandomTeamPickingSession();
              await this.teamPickingSession.initialize(interaction);
              break;
            case "draft":
              this.teamPickingSession = new DraftTeamPickingSession();
              await this.teamPickingSession.initialize(interaction);
              break;
          }

          const redTeam = game.getPlayersOfTeam("RED");
          for (const player of redTeam) {
            const discordUser = await interaction.guild?.members.fetch(
              player.discordSnowflake
            );
            await discordUser?.roles.remove(config.roles.blueTeamRole);
            discordUser?.roles.add(config.roles.redTeamRole);
          }

          const blueTeam = game.getPlayersOfTeam("BLUE");
          for (const player of blueTeam) {
            const discordUser = await interaction.guild?.members.fetch(
              player.discordSnowflake
            );
            await discordUser?.roles.remove(config.roles.redTeamRole);
            discordUser?.roles.add(config.roles.blueTeamRole);
          }

          await interaction.editReply({
            content: "Teams generated successfully!",
          });
          break;
        }

        case "reset": {
          if (!isOrganiser) {
            await interaction.reply({
              content: "You do not have permission to run this command!",
              ephemeral: true,
            });
            return;
          }

          await interaction.deferReply({ ephemeral: false });

          game.resetTeams();

          await interaction.editReply({
            content: "Teams have been reset!",
          });
          break;
        }

        case "list": {
          if (!game.announced) {
            await interaction.reply({
              content: "Game does not exist.",
            });
          } else {
            await interaction.deferReply({ ephemeral: false });

            const embed = this.createTeamViewEmbed(game);
            await interaction.editReply(embed);
          }
          break;
        }

        default:
          await interaction.reply({
            content: "Invalid subcommand!",
            ephemeral: true,
          });
      }
    } catch (error) {
      console.error(error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "An error occurred while executing this command.",
          ephemeral: true,
        });
      }
    }
  }

  createTeamViewEmbed(game: GameInstance) {
    const redPlayers: PlayerInstance[] = game.getPlayersOfTeam("RED");
    const bluePlayers: PlayerInstance[] = game.getPlayersOfTeam("BLUE");
    const bluePlayersString =
      bluePlayers.length > 0
        ? `**${bluePlayers[0].ignUsed}**\n` +
          bluePlayers
            .slice(1)
            .map((player) => player.ignUsed)
            .join("\n") // Only the first player bold
        : "No players";

    const redPlayersString =
      redPlayers.length > 0
        ? `**${redPlayers[0].ignUsed}**\n` +
          redPlayers
            .slice(1)
            .map((player) => player.ignUsed)
            .join("\n") // Only the first player bold
        : "No players";

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Teams")
      .addFields(
        { name: "🔵 Blue Team 🔵  ", value: bluePlayersString, inline: true },
        { name: "🔴 Red Team 🔴   ", value: redPlayersString, inline: true }
      );

    return { embeds: [embed], ephemeral: false };
  }

  public async handleButtonPress(interaction: ButtonInteraction) {
    if (this.teamPickingSession) {
      await this.teamPickingSession.handleInteraction(interaction);

      const state = this.teamPickingSession.getState();
      switch (state) {
        case "finalized": //for now these do the same thing but we'll see
        case "cancelled":
          delete this.teamPickingSession;
          this.teamPickingSession = undefined;
          break;
      }
    }
  }
}
