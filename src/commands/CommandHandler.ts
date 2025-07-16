import { REST, Routes, Interaction } from "discord.js";
import { Command } from "./CommandInterface.js";
import "dotenv/config";
import { ConfigManager } from "../ConfigManager";
import AnnouncementCommand from "./AnnouncementCommand";
import CaptainCommand from "./CaptainCommand";
import IgnsCommand from "./IgnsCommand";
import LeaderboardsCommand from "./LeaderboardsCommand";
import RegisterCommand from "./RegisterCommand";
import StatsCommand from "./StatsCommand";
import TeamCommand from "./TeamCommand";
import TestCommand from "./TestCommand";
import CleanupCommand from "./CleanUpCommand";
import ScenarioCommand from "./ScenarioCommand";
import UnregisterCommand from "./UnregisterCommand";
import RegisteredCommand from "../commands/RegisteredCommand";
import RestartCommand from "../commands/RestartCommand";
import PlayerCommand from "../commands/PlayerCommand";
import WinnerCommand from "../commands/WinnerCommand";
import PerformanceCommand from "../commands/PerformanceCommand";
import MVPCommand from "../commands/MVPCommand";
import GameCommand from "../commands/GameCommand";
import MissingCommand from "../commands/MissingCommand";
import CaptainNominateCommand from "../commands/CaptainNominate";
import TeamlessCommand from "../commands/TeamlessCommand";
import PlanCommand from "../commands/PlanCommand";
import MassRegisterCommand from "../commands/MassRegisterCommand";
import PunishCommand from "../commands/PunishCommand";
import PunishedCommand from "../commands/PunishedCommand";
import TimestampCommand from "../commands/TimeStampCommand";
import VerifyCommand from "../commands/VerifyCommand";
import ClassbanCommand from "../commands/ClassbanCommand";

export class CommandHandler {
  commands: Command[] = [];

  //todo: just make these singletons.
  announcementCommand = new AnnouncementCommand();
  ignsCommand = new IgnsCommand();
  leaderboardsCommand = new LeaderboardsCommand();
  registerCommand = new RegisterCommand();
  statsCommand = new StatsCommand();
  teamCommand = new TeamCommand();
  captainCommand = new CaptainCommand(this.teamCommand);
  testCommand = new TestCommand();
  cleanupCommand = new CleanupCommand();
  scenarioCommand = new ScenarioCommand();
  registeredCommand = new RegisteredCommand();
  unregisterCommand = new UnregisterCommand();
  restartCommand = new RestartCommand();
  playerCommand = new PlayerCommand();
  winnerCommand = new WinnerCommand();
  performanceCommand = new PerformanceCommand();
  MVPCommand = new MVPCommand();
  gameCommand = new GameCommand();
  missingCommand = new MissingCommand();
  captainNominateCommand = new CaptainNominateCommand();
  teamlessCommand = new TeamlessCommand();
  planCommand = new PlanCommand();
  massRegisterCommand = new MassRegisterCommand();
  punishCommand = new PunishCommand();
  punishedCommand = new PunishedCommand();
  timestampCommand = new TimestampCommand();
  verifyCommand = new VerifyCommand();
  classbanCommand = new ClassbanCommand();

  public loadCommands() {
    this.commands = [
      this.announcementCommand,
      this.ignsCommand,
      this.leaderboardsCommand,
      this.registerCommand,
      this.statsCommand,
      this.teamCommand,
      this.captainCommand,
      this.testCommand,
      this.cleanupCommand,
      this.scenarioCommand,
      this.registeredCommand,
      this.unregisterCommand,
      this.restartCommand,
      this.playerCommand,
      this.winnerCommand,
      this.performanceCommand,
      this.MVPCommand,
      this.gameCommand,
      this.missingCommand,
      this.captainNominateCommand,
      this.teamlessCommand,
      this.planCommand,
      this.massRegisterCommand,
      this.punishCommand,
      this.punishedCommand,
      this.timestampCommand,
      this.verifyCommand,
      this.classbanCommand,
    ];
  }

  public async handleInteraction(interaction: Interaction) {
    try {
      if (interaction.isChatInputCommand()) {
        const chatInteraction = interaction;
        const command = this.commands.find(
          (cmd) => cmd.name === chatInteraction.commandName
        );

        if (command) {
          const subCommand = chatInteraction.options.getSubcommand(false);

          const options = subCommand
            ? chatInteraction.options.data.find(
                (option) => option.name === subCommand
              )?.options || []
            : chatInteraction.options.data;

          const optionsLog = options
            .map((opt) => `${opt.name}: ${opt.value}`)
            .join(" ");

          console.log(
            `[${chatInteraction.user.tag}] ran /${chatInteraction.commandName}` +
              (subCommand ? ` ${subCommand}` : "") +
              (optionsLog ? ` ${optionsLog}` : "")
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
    } catch (error) {
      console.error("Error handling interaction:", error);
      if (
        interaction.isRepliable() &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        try {
          await interaction.reply({
            content: "An error occurred while processing your request.",
            ephemeral: true,
          });
        } catch (replyError) {
          console.error("Failed to send error reply:", replyError);
        }
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
