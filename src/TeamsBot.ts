import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { CommandHandler } from "commands/CommandHandler";
import { MessageHandler } from "interactions/MessageHandler";
import { ReactionHandler } from "interactions/ReactionHandler";
import { VoiceChannelHandler } from "interactions/VoiceChannelHandler";
import { log } from "console";

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
      log("Successfully logged in!");
    } catch (error) {
      log(error);
    }
  }
}
