import { PrismaClient } from '@prisma/client';
import { PlayerData } from './PlayerData';
import { Snowflake } from 'discord.js';

const prisma = new PrismaClient();

export async function recordPlayerDataHistory(playerData: PlayerData) {
    const discordUserId: string = playerData.getDiscordUserId() as Snowflake as string;

    await prisma.playerHistory.upsert({
        where: { discordUserId },
        update: {
            wins: {
                increment: playerData.getWins(),
            },
            losses: {
                increment: playerData.getLosses(),
            },
            captainCount: {
                increment: playerData.getIsCaptain() ? 1 : 0,
            },
            mvpCount: {
                increment: playerData.getIsMvp() ? 1 : 0,
            },
            discordUserName: playerData.getDiscordUserName(),
            inGameName: playerData.getInGameName(),
            // Optionally update elo, or any other dynamic values as needed
        },
        create: {
            discordUserId: discordUserId,
            discordUserName: playerData.getDiscordUserName(),
            inGameName: playerData.getInGameName(),
            wins: playerData.getWins(),
            losses: playerData.getLosses(),
            captainCount: playerData.getIsCaptain() ? 1 : 0,
            mvpCount: playerData.getIsMvp() ? 1 : 0,
        }
    });

    console.log(`Player history for ${this.inGameName} updated.`);
}
