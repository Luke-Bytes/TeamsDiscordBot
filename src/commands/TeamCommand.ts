import {
  ChatInputCommandInteraction,
  GuildMemberRoleManager,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { promises as fs } from "fs";
import { GameManager } from "../logic/GameManager";
import {
  createTeamGenerateEmbed,
  createTeamViewEmbed,
} from "../util/EmbedUtil";
import { ConfigManager } from "ConfigManager";

export default class TeamCommand implements Command {
  public data: SlashCommandSubcommandsOnlyBuilder;
  public name = "team";
  public description = "Manage teams";
  public buttonIds: string[] = [];

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

    await interaction.deferReply();

    const game = GameManager.getGame();

    switch (subcommand) {
      case "generate": {
        if (!isOrganiser) {
          await interaction.reply({
            content: "You do not have permission to run this command!",
            ephemeral: true,
          });
          return;
        }

        const method = interaction.options.getString("method");
        if (method === "random") {
          game.shuffleTeams("random");
          const response = createTeamGenerateEmbed(game);
          await interaction.reply(response);
        } else {
          await interaction.reply({
            content: "Invalid generation method!",
            ephemeral: true,
          });
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

      case "list":
        if (!game.announced) {
          await interaction.editReply({
            content: "Game does not exist.",
          });
        } else {
          const embed = createTeamViewEmbed(game);
          await interaction.editReply(embed);
        }
        break;

      default:
        await interaction.reply({
          content: "Invalid subcommand!",
          ephemeral: true,
        });
    }
  }
}
