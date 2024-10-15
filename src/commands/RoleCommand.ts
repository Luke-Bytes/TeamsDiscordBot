import {
  ChatInputCommandInteraction,
  Role,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { ConfigManager } from "../ConfigManager";

export default class RoleCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "role";
  public description = "Configure roles";
  public buttonIds: string[] = [];

  constructor() {
    const command = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description);

    command.addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Set a role for a team or organiser")
        .addStringOption((option) =>
          option
            .setName("type")
            .setDescription("The role type to set (blue, red, organiser)")
            .setRequired(true)
            .addChoices(
              { name: "blue", value: "blue" },
              { name: "red", value: "red" },
              { name: "organiser", value: "organiser" }
            )
        )
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("The role to assign")
            .setRequired(true)
        )
    );
    this.data = command;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const roleType = interaction.options.getString("type", true);
    const role = interaction.options.getRole("role", true) as Role;
    const config = ConfigManager.getConfig();

    switch (roleType) {
      case "blue":
        config.roles.blueTeamRole = role.id;
        await interaction.reply(
          `Set the Blue Team role to ${role.name} (ID: ${role.id})`
        );
        break;
      case "red":
        config.roles.redTeamRole = role.id;
        await interaction.reply(
          `Set the Red Team role to ${role.name} (ID: ${role.id})`
        );
        break;
      case "organiser":
        config.roles.organiserRole = role.id;
        await interaction.reply(
          `Set the Organiser role to ${role.name} (ID: ${role.id})`
        );
        break;
      default:
        await interaction.reply("Invalid role type specified.");
        return;
    }

    ConfigManager.writeConfig(config);
  }
}
