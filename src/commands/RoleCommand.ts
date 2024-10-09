import { ChatInputCommandInteraction, SlashCommandBuilder, GuildMember } from 'discord.js';
import { Command } from './CommandInterface';
import { PlayerData } from '../database/PlayerData';
import fs from 'fs';

// Load config from config.json
const configPath = './config.json';
const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));

export default class CaptainCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('captain')
    .setDescription('Set a captain for a team')
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set a player as the captain')
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('The user to set as captain')
            .setRequired(true))
        .addStringOption(option =>
          option
            .setName('team')
            .setDescription('The team color (blue or red)')
            .setRequired(true)
            .addChoices(
              { name: 'blue', value: 'blue' },
              { name: 'red', value: 'red' }
            )
        )
    );
  name = 'captain';
  description = 'Set or change the captain of a team';

  async execute(interaction: ChatInputCommandInteraction) {
    // Ensure the command is executed in a guild context
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a guild.', ephemeral: true });
      return;
    }

    // Ensure the member object is available and is a GuildMember
    const member = interaction.member as GuildMember;
    if (!member || !member.roles) {
      await interaction.reply({ content: 'Could not retrieve your guild member data.', ephemeral: true });
      return;
    }

    const organiserRoleId = configData.roles.organiserRole;
    const captainRoleId = configData.roles.captainRole;
    const teamColor = interaction.options.getString('team')!;
    const user = interaction.options.getUser('user')!;

    // Check if the member has the organiser role
    if (!member.roles.cache.has(organiserRoleId)) {
      await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
      return;
    }

    // Get the team role ID based on the selected team color
    const teamRoleId = teamColor === 'blue' ? configData.roles.blueTeamRole : configData.roles.redTeamRole;

    // Find and revert previous captain for the selected team
    const previousCaptain = this.getCaptainByTeam(teamColor, interaction);
    if (previousCaptain) {
      const previousMember = interaction.guild.members.cache.get(previousCaptain.getDiscordUserId());
      if (previousMember) {
        previousCaptain.setCaptain(false);
        await previousMember.roles.remove(captainRoleId);
      }
    }

    // Set the new captain
    const player = PlayerData.playerDataList.find(p => p.getDiscordUserId() === user.id);
    if (player) {
      player.setCaptain(true);
    } else {
      const newPlayer = new PlayerData(user.id, user.username, user.username); // Adjust accordingly to your PlayerData constructor.
      newPlayer.setCaptain(true);
    }

    const newCaptainMember = interaction.guild.members.cache.get(user.id);
    if (newCaptainMember) {
      await newCaptainMember.roles.add(captainRoleId);
      await interaction.reply({ content: `${user.username} has been set as the ${teamColor} team captain.` });
    } else {
      await interaction.reply({ content: 'Could not assign captain role. The user might not be a guild member.', ephemeral: true });
    }
  }

  // Helper method to get the current captain by team color
  private getCaptainByTeam(teamColor: 'blue' | 'red', interaction: ChatInputCommandInteraction): PlayerData | null {
    const teamRoleId = teamColor === 'blue' ? configData.roles.blueTeamRole : configData.roles.redTeamRole;

    // Find a player who is the current captain and has the team role
    return PlayerData.playerDataList.find(player =>
      player.getIsCaptain() &&
      interaction.guild?.members.cache.get(player.getDiscordUserId())?.roles.cache.has(teamRoleId)
    ) || null;
  }
}
