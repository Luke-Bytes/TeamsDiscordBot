import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { CommandHandler } from "./commands/CommandHandler";
import { MessageHandler } from "./interactions/MessageHandler";
import { ReactionHandler } from "./interactions/ReactionHandler";
import { VoiceChannelHandler } from "./interactions/VoiceChannelHandler";
import { Channels } from "./Channels";
import logger from "./util/Logger";

export class TeamsBot {
  client: Client;

  commandHandler: CommandHandler;
  messageHandler: MessageHandler;
  reactionHandler: ReactionHandler;
  voiceChannelHandler: VoiceChannelHandler;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessagePolls,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.commandHandler = new CommandHandler();
    this.messageHandler = new MessageHandler(this.client);
    this.reactionHandler = new ReactionHandler();
    this.voiceChannelHandler = new VoiceChannelHandler();
  }

  public async start() {
    this.client.once("ready", async () => {
      console.log = (...args: any[]) => logger.info(args.join(" "));
      console.warn = (...args: any[]) => logger.error(args.join(" "));
      console.error = (...args: any[]) => logger.info(args.join(" "));
      console.debug = (...args: any[]) => logger.error(args.join(" "));
      console.log(`Logged in as ${this.client.user?.tag}!`);

      this.commandHandler.loadCommands();
      await this.commandHandler.registerCommands();
    });

    // Command + Context Menu Listener
    this.client.on("interactionCreate", async (interaction) => {
      await this.commandHandler.handleInteraction(interaction);
    });

    this.client.on("messageCreate", async (msg) => {
      if (this.commandHandler.teamCommand.teamPickingSession) {
        this.commandHandler.teamCommand.teamPickingSession.handleMessage(msg);
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
