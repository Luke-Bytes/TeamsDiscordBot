import 'dotenv/config';
import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import { CommandHandler } from './commands/CommandHandler';
import { MessageHandler, ReactionHandler, VoiceChannelHandler } from './interactions/InteractionsHandler';
import path from 'path';
import { fileURLToPath } from 'url';
import { GameData } from './database/GameData';
import { PlayerData } from './database/PlayerData';
import { GameHistory } from './database/GameHistory';
import { RandomTeams } from './logic/RandomTeams';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const players: PlayerData[] = [];
const gameData = new GameData();
const gameHistory: GameHistory[] = [];

const randomTeamsInstance = new RandomTeams(gameData);  // Create RandomTeams instance

const commandHandler = new CommandHandler({ players, gameData, gameHistory, randomTeamsInstance });  // Pass RandomTeams instance

const messageHandler = new MessageHandler(client);
const reactionHandler = new ReactionHandler();
const voiceChannelHandler = new VoiceChannelHandler();

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}!`);

  // Loads all commands
  const commandsPath = path.join(__dirname, 'commands');
  await commandHandler.loadCommands(commandsPath);
  await commandHandler.registerCommands();
});

// Command + Context Menu Watchdog
client.on('interactionCreate', async (interaction) => {
  await commandHandler.handleInteraction(interaction); // Handles both commands and button interactions
});

// Message Watchdog
client.on('messageCreate', async (message) => {
  if (await messageHandler.isBotMentioned(message)) {
    if (message.channel instanceof TextChannel) {
      await messageHandler.sendMessage(message.channel, 'You mentioned me!');
    }
  }
});

client.login(process.env.BOT_TOKEN);
