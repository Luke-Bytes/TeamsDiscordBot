import { REST, Routes, Interaction, MessageFlags } from "discord.js";
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
import SeasonCommand from "../commands/SeasonCommand";
import UsernameCommand from "../commands/UsernameCommand";
import ForfeitCommand from "../commands/ForfeitCommand";
import MapsCommand from "../commands/MapsCommand";
import CoinflipCommand from "../commands/CoinflipCommand";
import NicknameCommand from "../commands/NicknameCommand";
import HelpCommand from "../commands/HelpCommand";
import SpectateCommand from "../commands/SpectateCommand";
import WebsiteCommand from "../commands/WebsiteCommand";
import CaptainPlanDMManager from "../logic/CaptainPlanDMManager";

export class CommandHandler {
  commands: Command[] = [];

  //todo: just make these singletons.
  captainPlanDMManager = new CaptainPlanDMManager();
  announcementCommand = new AnnouncementCommand();
  ignsCommand = new IgnsCommand();
  leaderboardsCommand = new LeaderboardsCommand();
  statsCommand = new StatsCommand();
  teamCommand = new TeamCommand();
  captainCommand = new CaptainCommand(this.teamCommand);
  testCommand = new TestCommand();
  cleanupCommand = new CleanupCommand();
  scenarioCommand = new ScenarioCommand();
  registeredCommand = new RegisteredCommand();
  registerCommand = new RegisterCommand(this.teamCommand);
  unregisterCommand = new UnregisterCommand(this.teamCommand);
  restartCommand = new RestartCommand();
  playerCommand = new PlayerCommand(this.captainPlanDMManager);
  winnerCommand = new WinnerCommand();
  performanceCommand = new PerformanceCommand();
  MVPCommand = new MVPCommand();
  gameCommand = new GameCommand(this.captainPlanDMManager);
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
  seasonCommand = new SeasonCommand();
  usernameCommand = new UsernameCommand();
  forfeitCommand = new ForfeitCommand();
  mapsCommand = new MapsCommand();
  coinflipCommand = new CoinflipCommand();
  nicknameCommand = new NicknameCommand();
  helpCommand = new HelpCommand(() => this.commands);
  spectateCommand = new SpectateCommand();
  websiteCommand = new WebsiteCommand();

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
      this.seasonCommand,
      this.usernameCommand,
      this.forfeitCommand,
      this.mapsCommand,
      this.coinflipCommand,
      this.nicknameCommand,
      this.helpCommand,
      this.spectateCommand,
      this.websiteCommand,
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
          command.buttonIds.some(
            (id) =>
              interaction.customId === id ||
              interaction.customId.startsWith(id)
          )
        );

        if (command && command.handleButtonPress) {
          await command.handleButtonPress(interaction);
        }
      }
    } catch (error: unknown) {
      console.error("Error handling interaction:", error);

      if (typeof error === "object" && error !== null) {
        const err = error as Record<string, unknown>;

        if ("rawError" in err) {
          console.error("Raw Error:", err["rawError"]);
        }

        if ("requestBody" in err) {
          console.error(
            "Request Body:",
            JSON.stringify(err["requestBody"], null, 2)
          );
        }
      }

      if (
        interaction.isRepliable() &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        try {
          await interaction.reply({
            content: "An error occurred while processing your request.",
            flags: MessageFlags.Ephemeral,
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
    const appId = process.env.APP_ID as string;

    const commandsData = this.commands.map((cmd) => cmd.data.toJSON());

    try {
      if (config.dev.enabled) {
        console.log(
          "Dev mode: clearing global commands and registering guild commands."
        );

        await rest.put(Routes.applicationCommands(appId), { body: [] });

        await rest.put(
          Routes.applicationGuildCommands(appId, config.dev.guildId),
          { body: commandsData }
        );

        console.log(
          `Successfully registered commands to dev guild: ${config.dev.guildId}`
        );
      } else {
        console.log("Prod mode: registering global application (/) commands.");

        await rest.put(Routes.applicationCommands(appId), {
          body: commandsData,
        });

        console.log("Successfully reloaded global application (/) commands.");

        await rest.put(
          Routes.applicationGuildCommands(appId, config.dev.guildId),
          { body: [] }
        );
      }
    } catch (error) {
      console.error("Failed to register commands: ", error);
    }
  }
}
