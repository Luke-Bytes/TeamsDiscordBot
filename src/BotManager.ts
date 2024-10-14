import "dotenv/config";
import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import { CommandHandler } from "./commands/CommandHandler";
import {
  MessageHandler,
  ReactionHandler,
  VoiceChannelHandler,
} from "./interactions/InteractionsHandler";
import path from "path";
import { fileURLToPath } from "url";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commandHandler = new CommandHandler();

const messageHandler = new MessageHandler(client);
const reactionHandler = new ReactionHandler();
const voiceChannelHandler = new VoiceChannelHandler();

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}!`);

  await commandHandler.loadCommands();
  await commandHandler.registerCommands();
});

// Command + Context Menu Listener
client.on("interactionCreate", async (interaction) => {
  await commandHandler.handleInteraction(interaction);
});

// Message Listener
client.on("messageCreate", async (message) => {
  if (await messageHandler.isBotMentioned(message)) {
    if (message.channel instanceof TextChannel) {
      await messageHandler.sendMessage(message.channel, "You mentioned me!");
    }
  }
});

(async () => {
  try {
    await client.login(process.env.BOT_TOKEN);
    console.log("Successfully logged in");
  } catch (error) {
    console.error("Failed to log in: ", error);
  }
})();
