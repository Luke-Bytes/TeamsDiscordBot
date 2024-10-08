import { ChatInputCommandInteraction, GuildMemberRoleManager, SlashCommandBuilder } from 'discord.js';
import { Command } from './CommandInterface';
import { RandomTeams } from '../logic/RandomTeams';
import { GameData } from '../database/GameData';
import { promises as fs } from 'fs';

export default class TeamCommand implements Command {
  name = 'team';
  description = 'Manage teams';

  data: SlashCommandBuilder;

  private randomTeams = new RandomTeams();

  constructor() {
    const command = new SlashCommandBuilder()
      .setName('team')
      .setDescription('Manage teams');

    command.addSubcommand(subcommand =>
      subcommand
        .setName('generate')
        .setDescription('Generate teams')
        .addStringOption(option =>
          option
            .setName('method')
            .setDescription('Method to generate teams')
            .setRequired(true)
            .addChoices({ name: 'random', value: 'random' })
        )
    );

    command.addSubcommand(subcommand =>
      subcommand
        .setName('reset')
        .setDescription('Reset the teams')
    );

    command.addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List the current teams')
    );

    this.data = command;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = await fs.readFile('./config.json', 'utf-8').then(JSON.parse);
    const subcommand = interaction.options.getSubcommand();
    const memberRoles = interaction.member?.roles;
    const isOrganiser = memberRoles instanceof GuildMemberRoleManager &&
      memberRoles.cache.has(config.roles.organiserRole);

    switch (subcommand) {
      case 'generate': {
        if (!isOrganiser) {
          await interaction.reply({ content: 'You do not have permission to run this command!', ephemeral: true });
          return;
        }

        const method = interaction.options.getString('method');
        if (method === 'random') {
          this.randomTeams.randomizeTeams();
          const response = this.randomTeams.createEmbedMessage();
          await interaction.reply(response);
        } else {
          await interaction.reply({ content: 'Invalid generation method!', ephemeral: true });
        }
        break;
      }

      case 'reset': {
        if (!isOrganiser) {
          await interaction.reply({ content: 'You do not have permission to run this command!', ephemeral: true });
          return;
        }

        GameData.setBluePlayers([]);
        GameData.setRedPlayers([]);
        await interaction.reply({ content: 'Teams have been reset!', ephemeral: false });
        break;
      }

      case 'list': {
        const bluePlayers = GameData.getBluePlayers().length > 0 ? GameData.getBluePlayers().join(', ') : 'No players in Blue Team';
        const redPlayers = GameData.getRedPlayers().length > 0 ? GameData.getRedPlayers().join(', ') : 'No players in Red Team';
        await interaction.reply({
          content: `**Blue Team:** ${bluePlayers}\n**Red Team:** ${redPlayers}`,
          ephemeral: true,
        });
        break;
      }

      default:
        await interaction.reply({ content: 'Invalid subcommand!', ephemeral: true });
    }
  }
}
