import { ButtonInteraction, ActionRowBuilder, ButtonBuilder, EmbedBuilder, ButtonStyle } from 'discord.js';
import { promises as fs } from 'fs';
import { GameData } from '../database/GameData';
import { GuildMemberRoleManager } from 'discord.js';

export class RandomTeams {
    private gameData: GameData;

    constructor(gameData: GameData) {
        this.gameData = gameData;
    }

    public randomizeTeams() {
        const players = this.gameData.getPlayers();
        const shuffledPlayers = players.sort(() => Math.random() - 0.5);
        const half = Math.ceil(shuffledPlayers.length / 2);

        this.gameData.bluePlayers = shuffledPlayers.slice(0, half);
        this.gameData.redPlayers = shuffledPlayers.slice(half);
    }

    public createEmbedMessage() {
        const bluePlayersList = this.gameData.getBluePlayers();
        const redPlayersList = this.gameData.getRedPlayers();
    
        const bluePlayers = bluePlayersList.length > 0
            ? `**${bluePlayersList[0]}**\n` + bluePlayersList.slice(1).map(player => player).join('\n')  // Only the first player bold
            : 'No players';
    
        const redPlayers = redPlayersList.length > 0
            ? `**${redPlayersList[0]}**\n` + redPlayersList.slice(1).map(player => player).join('\n')  // Only the first player bold
            : 'No players';
    
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Randomized Teams')
            .addFields(
                { name: '🔵 Blue Team 🔵  ', value: bluePlayers, inline: true },
                { name: '🔴 Red Team 🔴   ', value: redPlayers, inline: true }
            )
            .setFooter({ text: 'Choose an action below.' });
    
        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('accept')
                    .setLabel('Accept!')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('reroll')
                    .setLabel('Reroll')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('cancel')
                    .setLabel('Cancel?')
                    .setStyle(ButtonStyle.Danger)
            );
    
        return { embeds: [embed], components: [row] };
    }
    

    public async handleButtonInteraction(interaction: ButtonInteraction) {
        const config = await fs.readFile('./config.json', 'utf-8').then(JSON.parse);
    
        if (
            interaction.member?.roles instanceof GuildMemberRoleManager &&
            interaction.member.roles.cache.has(config.roles.organiserRole)
        ) {
            await interaction.deferUpdate();
    
            switch (interaction.customId) {
                case 'accept':
                    await interaction.editReply({ content: 'Teams accepted. (Placeholder for role logic)', components: [] });
                    break;
                case 'reroll':
                    this.randomizeTeams();
                    await interaction.editReply(this.createEmbedMessage());
                    break;
                case 'cancel':
                    this.gameData.bluePlayers = [];
                    this.gameData.redPlayers = [];
                    await interaction.editReply({ content: 'Team selection canceled.', components: [] });
                    break;
            }
        } else {
            await interaction.reply({ content: 'You do not have permission to perform this action!', ephemeral: true });
        }
    }
}    