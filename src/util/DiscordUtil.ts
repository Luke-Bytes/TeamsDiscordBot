import {
  ChatInputCommandInteraction,
  CommandInteraction,
  Guild,
  GuildMember,
  InteractionReplyOptions,
  MessagePayload,
  Snowflake,
  TextChannel,
} from "discord.js";
import { Channels } from "../Channels";
import { setTimeout as delay } from "timers/promises";

export class DiscordUtil {
  static getGuildMember(
    interaction: ChatInputCommandInteraction
  ): GuildMember | undefined {
    return interaction.member instanceof GuildMember
      ? interaction.member
      : undefined;
  }

  static async reply(
    interaction: CommandInteraction,
    content: string,
    ephemeral = true
  ): Promise<void> {
    await interaction.reply({
      content,
      ephemeral,
    });
  }

  static async editReply(
    interaction: CommandInteraction,
    content: string | MessagePayload | InteractionReplyOptions
  ): Promise<void> {
    await interaction.editReply(content);
  }

  static isValidSnowflake(id: string): boolean {
    return /^\d{17,19}$/.test(id);
  }

  static async assignRole(member: GuildMember, roleId: string): Promise<void> {
    try {
      await member.roles.add(roleId);
      console.log(`Assigned role ${roleId} to ${member.user.tag}`);
    } catch (error) {
      console.error(
        `Failed to assign role ${roleId} to ${member.user.tag}: `,
        error
      );
    }
  }

  static async removeRole(member: GuildMember, roleId: string): Promise<void> {
    try {
      await member.roles.remove(roleId);
      console.log(`Remove role ${roleId} from ${member.user.tag}`);
    } catch (error) {
      console.error(
        `Failed to remove role ${roleId} from ${member.user.tag} (may be expected): `,
        error
      );
    }
  }

  static async moveToVC(
    guild: Guild,
    vcId: string,
    roleId: string,
    discordSnowflake: Snowflake
  ): Promise<void> {
    const voiceChannel = guild.channels.cache.get(vcId);
    const role = guild.roles.cache.get(roleId);

    if (!voiceChannel || !role || !voiceChannel.isVoiceBased()) {
      console.error(`Invalid setup for VC: ${vcId} or Role: ${roleId}`);
      return;
    }

    try {
      const member = await guild.members.fetch(discordSnowflake);
      if (
        !member.roles.cache.has(roleId) ||
        member.voice.channel?.id === vcId
      ) {
        return;
      }

      console.log(
        `Attempting to move ${member.user.tag} to ${voiceChannel.name}`
      );
      await member.voice.setChannel(voiceChannel);
      console.log(
        `Successfully moved ${member.user.tag} to ${voiceChannel.name}`
      );
    } catch (error) {
      console.error(
        `Failed to move member ${discordSnowflake} to ${voiceChannel?.name}: `,
        error
      );
    }
  }

  static async sendMessage(
    channel: Exclude<keyof typeof Channels, "initChannels">,
    content: string
  ): Promise<void> {
    try {
      const textChannel = Channels[channel] as TextChannel;
      if (!textChannel) {
        console.error(`Channel "${channel}" is not a valid TextChannel.`);
        return;
      }
      await textChannel.send(content);
    } catch (error) {
      console.error(`Failed to send message to channel "${channel}": `, error);
    }
  }

  static async removeRoleFromMembers(
    guild: Guild,
    roleId: string
  ): Promise<void> {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      console.log(`Role with ID ${roleId} not found in guild ${guild.name}`);
      return;
    }

    for (const [_, member] of role.members) {
      try {
        await member.roles.remove(role);
        console.log(`Removed role ${role.name} from ${member.user.tag}`);
      } catch (error) {
        console.error(
          `Failed to remove role ${role.name} from ${member.user.tag}:`,
          error
        );
      }
    }
  }

  static async moveMembersToChannel(
    guild: Guild,
    fromChannelId: string,
    toChannelId: string
  ): Promise<void> {
    const fromChannel = guild.channels.cache.get(fromChannelId);
    const toChannel = guild.channels.cache.get(toChannelId);

    if (
      !fromChannel ||
      !toChannel ||
      !fromChannel.isVoiceBased() ||
      !toChannel.isVoiceBased()
    ) {
      console.error(
        `Invalid channels provided for moving members: ${fromChannelId}, ${toChannelId}`
      );
      return;
    }

    for (const [_, member] of fromChannel.members) {
      try {
        await member.voice.setChannel(toChannelId);
        console.log(
          `Moved ${member.user.tag} from ${fromChannel.name} to ${toChannel.name}`
        );
      } catch (error) {
        console.error(
          `Failed to move ${member.user.tag} from ${fromChannel.name}:`,
          error
        );
      }
    }
  }

  static async batchRemoveRoleFromMembers(
    guild: Guild,
    roleId: string,
    batchSize: number,
    delayMs: number
  ): Promise<void> {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      console.log(`Role with ID ${roleId} not found in guild ${guild.name}`);
      return;
    }

    const members = Array.from(role.members.values());
    for (let i = 0; i < members.length; i += batchSize) {
      const batch = members.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map((member) => member.roles.remove(role).catch(console.error))
      );
      await delay(delayMs);
    }
    console.log(`Completed removing role ${role.name} from members.`);
  }

  static async batchMoveMembersToChannel(
    guild: Guild,
    fromChannelId: string,
    toChannelId: string,
    batchSize: number,
    delayMs: number
  ): Promise<void> {
    const fromChannel = guild.channels.cache.get(fromChannelId);
    const toChannel = guild.channels.cache.get(toChannelId);

    if (
      !fromChannel ||
      !toChannel ||
      !fromChannel.isVoiceBased() ||
      !toChannel.isVoiceBased()
    ) {
      console.error(
        `Invalid channels provided for moving members: ${fromChannelId}, ${toChannelId}`
      );
      return;
    }

    const members = Array.from(fromChannel.members.values());
    for (let i = 0; i < members.length; i += batchSize) {
      const batch = members.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map((member) =>
          member.voice.setChannel(toChannel).catch(console.error)
        )
      );
      await delay(delayMs);
    }
    console.log(
      `Completed moving members from ${fromChannel.name} to ${toChannel.name}.`
    );
  }
}
