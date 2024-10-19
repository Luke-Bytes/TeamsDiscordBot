import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMemberRoleManager,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { ConfigManager } from "ConfigManager";
import { GameInstance } from "database/GameInstance";
import { PlayerInstance } from "database/PlayerInstance";
import { TeamPickingSession } from "logic/teams/TeamPickingSession";
import { RandomTeamPickingSession } from "logic/teams/RandomTeamPickingSession";

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
              .addChoices({ name: "random", value: "random" })
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

    switch (subcommand) {
      case "generate": {
        if (!isOrganiser) {
          await interaction.reply({
            content: "You do not have permission to run this command!",
            ephemeral: true,
          });
          return;
        }

        if (this.teamPickingSession) {
          await interaction.reply({
            content:
              "A team picking session is already happening. Either cancel that one or continue it.",
            ephemeral: true,
          });
          return;
        }

        const method = interaction.options.getString("method");

        switch (method) {
          case "random":
            this.teamPickingSession = new RandomTeamPickingSession("random");
            this.teamPickingSession.initialize(interaction);
            break;
        }

        const redTeam = game.getPlayersOfTeam("RED");
        for (let i = 0; i < redTeam.length; i++) {
          const player = redTeam[i];
          const discordUser = await interaction.guild?.members.fetch(
            player.discordSnowflake
          );
          await discordUser?.roles.remove(config.roles.blueTeamRole);
          discordUser?.roles.add(config.roles.redTeamRole);
        }

        const blueTeam = game.getPlayersOfTeam("BLUE");
        for (let i = 0; i < blueTeam.length; i++) {
          const player = blueTeam[i];
          const discordUser = await interaction.guild?.members.fetch(
            player.discordSnowflake
          );
          await discordUser?.roles.remove(config.roles.redTeamRole);
          discordUser?.roles.add(config.roles.blueTeamRole);
        }

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

        game.resetTeams();

        await interaction.reply({
          content: "Teams have been reset!",
          ephemeral: false,
        });
        break;
      }

      case "list": {
        if (!game.announced) {
          await interaction.editReply({
            content: "Game does not exist.",
          });
        } else {
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
  }

  createTeamViewEmbed(game: GameInstance) {
    const redPlayers: PlayerInstance[] = game.getPlayersOfTeam("RED");
    const bluePlayers: PlayerInstance[] = game.getPlayersOfTeam("BLUE");
    const bluePlayersString =
      bluePlayers.length > 0
        ? `**${bluePlayers[0]}**\n` +
          bluePlayers
            .slice(1)
            .map((player) => player.ignUsed)
            .join("\n") // Only the first player bold
        : "No players";

    const redPlayersString =
      redPlayers.length > 0
        ? `**${redPlayers[0]}**\n` +
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

    return { embeds: [embed], ephemeral: true };
  }

  public async handleButtonPress(interaction: ButtonInteraction) {
    if (this.teamPickingSession) {
      this.teamPickingSession.handleInteraction(interaction);
    }
  }
}
