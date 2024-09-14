import { VoiceChannel, GuildMember, VoiceState } from 'discord.js';

export class VoiceChannelHandler {
  getAllUsersInVC(channel: VoiceChannel): GuildMember[] {
    return Array.from(channel.members.values());
  }

  getVCUserCount(channel: VoiceChannel): number {
    return channel.members.size;
  }

  async moveUserToVC(member: GuildMember, newChannel: VoiceChannel): Promise<void> {
    if (member.voice.channelId !== newChannel.id) {
      await member.voice.setChannel(newChannel);
    }
  }

  isUserInVC(voiceState: VoiceState): boolean {
    return !!voiceState.channel;
  }
}
