import { REST, Routes, Interaction, ChatInputCommandInteraction, MessageContextMenuCommandInteraction, UserContextMenuCommandInteraction, ButtonInteraction } from 'discord.js';
import { Command } from './CommandInterface';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import 'dotenv/config';
import { GameData } from '../database/GameData';
import { PlayerData } from '../database/PlayerData';
import RegisterCommand from './RegisterCommand';

export class CommandHandler {
  private commands: Command[] = [];
  private dependencies: Record<string, any> = {};
  private config: any;
  private gameData: GameData;
  private playerDataList: PlayerData[] = [];

  constructor(dependencies: Record<string, any>) {
    this.dependencies = dependencies;
    this.config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
    this.gameData = new GameData();
  }

  async loadCommands(commandDir: string): Promise<void> {
    const commandFiles = fs.readdirSync(commandDir).filter(file => file.match(/.*Command\.(ts|js)$/));


    for (const file of commandFiles) {
      const filePath = path.join(commandDir, file);
      const fileUrl = pathToFileURL(filePath).href;

      try {
        const commandClass = (await import(fileUrl)).default;
        if (!commandClass || typeof commandClass !== 'function') {
          console.error(`Error: ${filePath} does not export a valid command class.`);
          continue;
        }

        if (commandClass === RegisterCommand) {
          const commandInstance = new RegisterCommand();
          this.register(commandInstance);
        } else {
          const commandInstance = new commandClass(this.dependencies) as Command;
          this.register(commandInstance);
        }
      } catch (error) {
        console.error(`Failed to load command ${filePath}:`, error);
      }
    }
  }

  register(command: Command) {
    this.commands.push(command);
  }

  async handleInteraction(interaction: Interaction) {
    if (interaction.isChatInputCommand()) {
      const chatInteraction = interaction as ChatInputCommandInteraction;
      const command = this.commands.find(cmd => cmd.name === chatInteraction.commandName);
      if (command) {
        console.log(`[${chatInteraction.user.id}] runs /${chatInteraction.commandName}`);
        await command.execute(chatInteraction);
      }
    }
    else if (interaction.isMessageContextMenuCommand()) {
      const messageInteraction = interaction as MessageContextMenuCommandInteraction;
      const command = this.commands.find(cmd => cmd.name === messageInteraction.commandName);
      if (command) {
        console.log(`[${messageInteraction.user.id}] runs /${messageInteraction.commandName}`);
        await command.execute(messageInteraction);
      }
    }
    else if (interaction.isUserContextMenuCommand()) {
      const userInteraction = interaction as UserContextMenuCommandInteraction;
      const command = this.commands.find(cmd => cmd.name === userInteraction.commandName);
      if (command) {
        console.log(`[${userInteraction.user.id}] runs /${userInteraction.commandName}`);
        await command.execute(userInteraction);
      }
    }
    else if (interaction.isButton()) {
      const randomTeamsInstance = this.dependencies.randomTeamsInstance;
      if (randomTeamsInstance) {
        await randomTeamsInstance.handleButtonInteraction(interaction as ButtonInteraction);
      } else {
        console.error('RandomTeams instance is not available');
      }
    }
  }


  async registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN as string);

    const commandsData = this.commands.map(cmd => cmd.data.toJSON());

    try {
      if (this.config.dev.enabled) {
        console.log(`Development mode enabled. Registering guild specific commands to ${this.config.dev.guildId}.`);

        await rest.put(
          Routes.applicationGuildCommands(process.env.APP_ID as string, this.config.dev.guildId),
          { body: commandsData }
        );

        console.log(`Successfully registered commands to guild: ${this.config.dev.guildId}`);
      } else {
        console.log('Started refreshing global application (/) commands.');

        await rest.put(
          Routes.applicationCommands(process.env.APP_ID as string),
          { body: commandsData }
        );

        console.log('Successfully reloaded global application (/) commands.');
      }
    } catch (error) {
      console.error('Failed to register commands:', error);
    }
  }
}
