import {
  BaseMessageOptions,
  ChatInputCommandInteraction,
  CommandInteraction,
  Guild,
  GuildMember,
  InteractionEditReplyOptions,
  Message,
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
    content: string | MessagePayload | InteractionEditReplyOptions
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
    discordSnowflake: Snowflake,
    cachedMember?: GuildMember
  ): Promise<void> {
    const voiceChannel = guild.channels.cache.get(vcId);
    const role = guild.roles.cache.get(roleId);

    if (!voiceChannel || !role || !voiceChannel.isVoiceBased()) {
      console.error(`Invalid setup for VC: ${vcId} or Role: ${roleId}`);
      return;
    }

    try {
      const member =
        cachedMember ??
        (await guild.members.fetch(discordSnowflake).catch(() => null));
      if (!member) {
        console.error(`Unable to find member ${discordSnowflake} to move.`);
        return;
      }

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
    content: string | MessagePayload | BaseMessageOptions
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

  static getChannelKeyById(
    id: string
  ): Exclude<keyof typeof Channels, "initChannels"> | undefined {
    return Object.keys(Channels).find((key) => {
      if (key === "initChannels") return false;
      const chan = Channels[key as keyof typeof Channels];
      return typeof chan === "object" && "id" in chan && chan.id === id;
    }) as Exclude<keyof typeof Channels, "initChannels"> | undefined;
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

    for (const [, member] of role.members) {
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

    for (const [, member] of fromChannel.members) {
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

  static async cleanUpAllChannelMessages(
    guild: Guild,
    channelIds: string[],
    messageAgeDays = 14
  ): Promise<void> {
    try {
      for (const channelId of channelIds) {
        const channel = guild.channels.cache.get(channelId) as TextChannel;
        if (!channel?.isTextBased()) continue;

        while (true) {
          try {
            const messages = await channel.messages.fetch({ limit: 100 });
            if (messages.size === 0) break;

            const recentMessages: string[] = [];
            const oldMessages: Message[] = [];

            messages.forEach((msg) => {
              const isOld =
                Date.now() - msg.createdTimestamp >=
                messageAgeDays * 24 * 60 * 60 * 1000;
              if (isOld) {
                oldMessages.push(msg);
              } else {
                recentMessages.push(msg.id);
              }
            });

            if (recentMessages.length > 0) {
              await channel.bulkDelete(recentMessages, true);
              console.log(
                `Cleared ${recentMessages.length} recent messages in ${channel.name}`
              );
            }

            for (const msg of oldMessages) {
              await msg.delete();
              console.log(`Deleted old message ${msg.id} in ${channel.name}`);
            }
          } catch (error) {
            console.error(
              `Error cleaning messages in ${channel?.name || "unknown channel"}:`,
              error
            );
            break;
          }
        }
      }
      console.log("Completed cleaning up messages.");
    } catch (error) {
      console.error("Failed to clean up messages:", error);
    }
  }
}
