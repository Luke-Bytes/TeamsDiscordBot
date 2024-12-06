import "dotenv/config.js";
import { Client, GatewayIntentBits } from "discord.js";
import { CommandHandler } from "./commands/CommandHandler.js";
import { MessageHandler } from "./interactions/MessageHandler.js";
import { ReactionHandler } from "./interactions/ReactionHandler.js";
import { VoiceChannelHandler } from "./interactions/VoiceChannelHandler.js";
import { Channels } from "./Channels.js";

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
      console.log(`Logged in as ${this.client.user?.tag}!`);

      this.commandHandler.loadCommands();
      await this.commandHandler.registerCommands();
    });

    // Command + Context Menu Listener
    this.client.on("interactionCreate", async (interaction) => {
      await this.commandHandler.handleInteraction(interaction);
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
