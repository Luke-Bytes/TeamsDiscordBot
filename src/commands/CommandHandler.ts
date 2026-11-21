import AskCommand from "./AskCommand";
import EventCommand from "./EventCommand";
import SignCommand from "./SignCommand";
import NeedCommand from "./NeedCommand";
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
import RecoverGameCommand from "./RecoverGameCommand";
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
import WikiCommand from "../commands/WikiCommand";
import ProfileCommand from "../commands/ProfileCommand";
import ProfileEditCommand from "../commands/ProfileEditCommand";
import TitlesCommand from "../commands/TitlesCommand";
import TitleCommand from "../commands/TitleCommand";
import ScriptsCommand from "../commands/ScriptsCommand";
import SeasonRecapCommand from "../commands/SeasonRecapCommand";
import WrappedCommand from "../commands/WrappedCommand";
import VcCommand from "../commands/VcCommand";
import TierListCommand from "../commands/TierListCommand";
import CaptainPlanDMManager from "../logic/CaptainPlanDMManager";
import { InteractionGuard } from "../util/InteractionGuard";
import {
  isUnknownInteraction,
  discordErrorCode,
} from "../util/DiscordFailures";
import { GameRecoveryCoordinator } from "../logic/ActiveGameRecovery";

export class CommandHandler {
  commands: Command[] = [];
  askCommand = new AskCommand();
  eventCommand = new EventCommand();
  signCommand = new SignCommand();

  //todo: just make these singletons.
  captainPlanDMManager = new CaptainPlanDMManager();
  announcementCommand = new AnnouncementCommand();
  ignsCommand = new IgnsCommand();
  leaderboardsCommand = new LeaderboardsCommand();
  statsCommand = new StatsCommand();
  teamCommand = new TeamCommand();
  recoverGameCommand = new RecoverGameCommand(this.announcementCommand);
  needCommand = new NeedCommand(this.teamCommand, this.captainPlanDMManager);
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
  wikiCommand = new WikiCommand();
  profileCommand = new ProfileCommand();
  profileEditCommand = new ProfileEditCommand();
  titlesCommand = new TitlesCommand();
  titleCommand = new TitleCommand();
  scriptsCommand = new ScriptsCommand();
  seasonRecapCommand = new SeasonRecapCommand();
  wrappedCommand = new WrappedCommand();
  vcCommand = new VcCommand();
  tierListCommand = new TierListCommand();

  private readonly interactionGuard = new InteractionGuard();

  public loadCommands() {
    this.commands = [
      this.askCommand,
      this.eventCommand,
      this.signCommand,
      this.announcementCommand,
      this.ignsCommand,
      this.leaderboardsCommand,
      this.registerCommand,
      this.needCommand,
      this.statsCommand,
      this.teamCommand,
      this.recoverGameCommand,
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
      this.wikiCommand,
      this.profileCommand,
      this.profileEditCommand,
      this.titlesCommand,
      this.titleCommand,
      this.scriptsCommand,
      this.seasonRecapCommand,
      this.wrappedCommand,
      this.vcCommand,
      this.tierListCommand,
    ];
  }

  public async handleInteraction(interaction: Interaction) {
    const restart =
      (interaction.isChatInputCommand() &&
        interaction.commandName === "restart") ||
      (interaction.isButton() &&
        interaction.customId.startsWith("confirm_restart"));
    const eventInteraction =
      (interaction.isChatInputCommand() &&
        ["event", "sign"].includes(interaction.commandName)) ||
      (interaction.isAutocomplete() && interaction.commandName === "event") ||
      ((interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isModalSubmit()) &&
        (interaction.customId.startsWith("sign_") ||
          interaction.customId.startsWith("event_")));
    // Recovery confirmation owns an exclusive barrier; do not count its own interaction
    // among the operations it must wait to drain.
    const discordRecoveryInteraction =
      (interaction.isChatInputCommand() &&
        interaction.commandName === "recover-game") ||
      (interaction.isButton() &&
        interaction.customId.startsWith("recover-game-"));
    const done =
      restart || eventInteraction || discordRecoveryInteraction
        ? () => {}
        : GameRecoveryCoordinator.enterOperation();
    if (!done) {
      if (interaction.isRepliable()) {
        try {
          await interaction.reply({
            content:
              GameRecoveryCoordinator.getBlockReason() ??
              "Game recovery is in progress.",
          });
        } catch (error) {
          console.warn("Failed to acknowledge blocked interaction", error);
        }
      }
      return;
    }
    try {
      // Sign forms enforce their own user-bound session throttle so normal
      // multi-step navigation does not exhaust the generic command limiter.
      const signComponent =
        (interaction.isButton() ||
          interaction.isStringSelectMenu() ||
          interaction.isModalSubmit()) &&
        interaction.customId.startsWith("sign_");
      if (
        !signComponent &&
        !(await this.interactionGuard.checkRateLimit(interaction))
      ) {
        return;
      }
      if (!(await this.interactionGuard.checkInputSafety(interaction))) {
        return;
      }
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

          // Only log option names: free-form values may contain accidentally
          // pasted credentials, URLs or personal data.
          const optionsLog = options.map((opt) => opt.name).join(",");

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
              interaction.customId === id || interaction.customId.startsWith(id)
          )
        );

        if (command && command.handleButtonPress) {
          await command.handleButtonPress(interaction);
        }
      } else if (interaction.isStringSelectMenu()) {
        const command = this.commands.find((command) =>
          (command.selectMenuIds ?? []).some(
            (id) =>
              interaction.customId === id || interaction.customId.startsWith(id)
          )
        );
        if (command && command.handleSelectMenu) {
          await command.handleSelectMenu(interaction);
        }
      } else if (interaction.isAutocomplete()) {
        const command = this.commands.find(
          (cmd) => cmd.name === interaction.commandName
        );
        if (command && command.handleAutocomplete) {
          await command.handleAutocomplete(interaction);
        }
      } else if (interaction.isModalSubmit()) {
        const command = this.commands.find((command) =>
          (command.modalIds ?? []).some(
            (id) =>
              interaction.customId === id || interaction.customId.startsWith(id)
          )
        );
        if (command && command.handleModalSubmit) {
          await command.handleModalSubmit(interaction);
        }
      }
    } catch (error: unknown) {
      // Never print requestBody: interaction tokens can be embedded in it.
      console.error(
        `Interaction failed command=${"commandName" in interaction ? interaction.commandName : "component"} guild=${interaction.guildId ?? "dm"} code=${discordErrorCode(error) ?? "other"}`,
        error instanceof Error ? error.message : String(error)
      );
      if (!interaction.isRepliable() || isUnknownInteraction(error)) return;

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content:
              "The command encountered an error. Some changes may already have been applied; check the current game before retrying.",
          });
        } else {
          await interaction.reply({
            content: "Oops, something has gone wrong! This is a bug.",
          });
        }
      } catch (replyError) {
        if (!isUnknownInteraction(replyError)) {
          console.error(
            `Error response failed code=${discordErrorCode(replyError) ?? "other"}`
          );
        } else {
          console.warn("Interaction expired before error response (10062)");
        }
      }
    } finally {
      done();
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
