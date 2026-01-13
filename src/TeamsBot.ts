import "dotenv/config";
import { Client, GatewayIntentBits, ActivityType, Partials } from "discord.js";
import { CommandHandler } from "./commands/CommandHandler";
import { MessageHandler } from "./interactions/MessageHandler";
import { ReactionHandler } from "./interactions/ReactionHandler";
import { VoiceChannelHandler } from "./interactions/VoiceChannelHandler";
import { Channels } from "./Channels";
import logger from "./util/Logger";
import { PermissionsUtil } from "./util/PermissionsUtil";
import { MaintenanceLoggingUtil } from "./util/MaintenanceLoggingUtil";
import { PrismaUtils } from "./util/PrismaUtils";
import { ConfigManager } from "./ConfigManager";

export class TeamsBot {
  client: Client;

  commandHandler: CommandHandler;
  messageHandler: MessageHandler;
  reactionHandler: ReactionHandler;
  voiceChannelHandler: VoiceChannelHandler;
  private static processHandlersAttached = false;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessagePolls,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on("rateLimit", (warn) => {
      console.warn("Rate limit hit:", warn);
    });

    this.commandHandler = new CommandHandler();
    this.messageHandler = new MessageHandler(this.client);
    this.reactionHandler = new ReactionHandler();
    this.voiceChannelHandler = new VoiceChannelHandler();

    this.attachGlobalGuards();
  }

  private attachGlobalGuards() {
    if (TeamsBot.processHandlersAttached) return;
    TeamsBot.processHandlersAttached = true;
    const config = ConfigManager.getConfig();
    const isDev = config.dev.enabled || process.env.NODE_ENV === "development";

    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled promise rejection:", reason, promise);
    });

    process.on("uncaughtException", (error) => {
      console.error("Uncaught exception:", error);
      if (isDev) {
        process.exit(1);
      }
    });

    process.on("warning", (warning) => {
      console.warn("Process warning:", warning);
    });

    this.client.on("error", (error) => {
      console.error("Discord client error:", error);
      if (isDev) {
        throw error;
      }
    });

    this.client.on("shardError", (error) => {
      console.error("Discord shard error:", error);
      if (isDev) {
        throw error;
      }
    });

    this.client.on("warn", (warning) => {
      console.warn("Discord client warning:", warning);
    });
  }

  public async start() {
    this.client.once("ready", async () => {
      console.log = (...args: unknown[]) => logger.info(args.join(" "));
      console.table = (...args: unknown[]) => logger.info(args.join(" "));
      console.info = (...args: unknown[]) => logger.info(args.join(" "));
      console.warn = (...args: unknown[]) => logger.error(args.join(" "));
      console.error = (...args: unknown[]) => logger.info(args.join(" "));
      console.debug = (...args: unknown[]) => logger.error(args.join(" "));
      console.log(`Logged in as ${this.client.user?.tag}!`);

      this.commandHandler.loadCommands();
      await this.commandHandler.registerCommands();
      MaintenanceLoggingUtil.startLogging();

      const updatedCount = await PrismaUtils.updatePunishmentsForExpiry();
      if (updatedCount > 0) {
        console.log(`${updatedCount} punishment(s) expired today.`);
      } else {
        console.log("No punishments expired today.");
      }
      this.client.user?.setActivity(
        `Season ${PermissionsUtil.config.season}!`,
        {
          type: ActivityType.Competing,
        }
      );
    });

    // Command + Context Menu Listener
    this.client.on("interactionCreate", async (interaction) => {
      await this.commandHandler.handleInteraction(interaction);
    });

    this.client.on("messageCreate", async (msg) => {
      if (!msg.guild) {
        const awaitingCaptainPlan =
          this.commandHandler.gameCommand.isAwaitingCaptainPlan(msg.author.id);
        if (awaitingCaptainPlan) {
          try {
            const handled = await this.commandHandler.gameCommand.handleDM(msg);
            if (handled) {
              return;
            }
          } catch (e) {
            console.log(`Failed to create message: ${e}`);
          }
        }
        return;
      }

      if (msg.content.length > 1900) {
        return;
      }

      if (
        PermissionsUtil.isDebugEnabled() &&
        msg.guild?.id !== PermissionsUtil.config.dev.guildId
      ) {
        return;
      }
      if (this.commandHandler.teamCommand.teamPickingSession) {
        try {
          await this.commandHandler.teamCommand.teamPickingSession.handleMessage(
            msg
          );
        } catch (error) {
          console.error("Team picking message handling failed: ", error);
        }
      }
    });

    try {
      await this.client.login(process.env.BOT_TOKEN);
      await Channels.initChannels(this.client);
      console.log("Successfully logged in!");
    } catch (error) {
      console.log(error);
    }
  }
}
