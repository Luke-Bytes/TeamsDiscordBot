import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface";
import { ConfigManager } from "../ConfigManager";
import { GameManager } from "../logic/GameManager";
import { Team } from "@prisma/client";

export default class CaptainCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "captain";
  public description = "Set or change the captain of a team";
  public buttonIds: string[] = [];

  constructor() {
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
    const config = ConfigManager.getConfig();
    const organiserRoleId = config.roles.organiserRole;
    const captainRoleId = config.roles.captainRole;
    const blueTeamRoleId = config.roles.blueTeamRole;
    const redTeamRoleId = config.roles.redTeamRole;

    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!member || !member.roles) {
      await interaction.reply({
        content: "Couldn't find role data - do I need more permissions?",
        ephemeral: true,
      });
      return;
    }

    const teamColor = interaction.options.getString("team", true);
    const user = interaction.options.getUser("user", true);

    if (!member.roles.cache.has(organiserRoleId)) {
      await interaction.reply({
        content: "Only organisers can use this command!",
        ephemeral: true,
      });
      return;
    }

    if (!GameManager.getGame().announced) {
      await interaction.reply({
        content: "No game has been announced yet!",
        ephemeral: true,
      });
      return;
    }

    const player = GameManager.getGame()
      .getPlayers()
      .find((player) => player.discordSnowflake === user.id);

    if (!player) {
      await interaction.reply({
        content: "This player hasn't registered!",
        ephemeral: true,
      });
      return;
    }

    GameManager.getGame().setTeamCaptain(
      teamColor.toUpperCase() as Team,
      player
    );

    await interaction.reply({
      content: `Set captain of team ${teamColor} to ${player.ignUsed}`,
    });
  }
}
