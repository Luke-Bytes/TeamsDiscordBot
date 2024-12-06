import { REST, Routes, Interaction } from "discord.js";
import { Command } from "./CommandInterface.js";
import "dotenv/config";
import RegisterCommand from "./RegisterCommand.js";
import { ConfigManager } from "../ConfigManager.js";
import AnnouncementCommand from "./AnnouncementCommand.js";
import CaptainCommand from "./CaptainCommand.js";
import IgnsCommand from "./IgnsCommand.js";
import LeaderboardsCommand from "./LeaderboardsCommand.js";
import RoleCommand from "./RoleCommand.js";
import StatsCommand from "./StatsCommand.js";
import TeamCommand from "./TeamCommand.js";
import TestCommand from "./TestCommand.js";
import CleanupCommand from "../commands/CleanUpCommand.js";

export class CommandHandler {
  private commands: Command[] = [];

  public loadCommands() {
    this.commands = [
      new AnnouncementCommand(),
      new CaptainCommand(),
      new IgnsCommand(),
      new LeaderboardsCommand(),
      new RegisterCommand(),
      new RoleCommand(),
      new StatsCommand(),
      new TeamCommand(),
      new TestCommand(),
      new CleanupCommand(),
    ];
  }

  public async handleInteraction(interaction: Interaction) {
    if (interaction.isChatInputCommand()) {
      const chatInteraction = interaction;
      const command = this.commands.find(
        (cmd) => cmd.name === chatInteraction.commandName
      );
      if (command) {
        console.log(
          `[${chatInteraction.user.tag}] ran /${chatInteraction.commandName}`
        );
        await command.execute(chatInteraction);
      }
    } else if (interaction.isMessageContextMenuCommand()) {
      const messageInteraction = interaction;
      const command = this.commands.find(
        (cmd) => cmd.name === messageInteraction.commandName
      );
      if (command) {
        console.log(
          `[${messageInteraction.user.tag}] ran /${messageInteraction.commandName}`
        );
        await command.execute(messageInteraction);
      }
    } else if (interaction.isButton()) {
      const command = this.commands.find((command) =>
        command.buttonIds.includes(interaction.customId)
      );

      if (command && command.handleButtonPress) {
        await command.handleButtonPress(interaction);
      }
    }
  }

  public async registerCommands() {
    const config = ConfigManager.getConfig();
    const rest = new REST({ version: "10" }).setToken(
      process.env.BOT_TOKEN as string
    );

    const commandsData = this.commands.map((cmd) => cmd.data.toJSON());

    try {
      if (config.dev.enabled) {
        console.log(
          `Development mode enabled. Registering guild specific commands to ${config.dev.guildId}.`
        );

        await rest.put(
          Routes.applicationGuildCommands(
            process.env.APP_ID as string,
            config.dev.guildId
          ),
          { body: commandsData }
        );

        console.log(
          `Successfully registered commands to guild: ${config.dev.guildId}`
        );
      } else {
        console.log("Started refreshing global application (/) commands.");

        await rest.put(
          Routes.applicationCommands(process.env.APP_ID as string),
          { body: commandsData }
        );

        console.log("Successfully reloaded global application (/) commands.");
      }
    } catch (error) {
      console.error("Failed to register commands: ", error);
    }
  }
}
