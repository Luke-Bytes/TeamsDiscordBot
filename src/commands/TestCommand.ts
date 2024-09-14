import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { Command } from './CommandInterface';

export default class TestCommand implements Command {
  data: SlashCommandBuilder;
  name: string;
  description: string;

  constructor() {
    this.name = 'test';
    this.description = 'Replies with a test message!';

    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description);
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply('This is a test message!');
  }
}
