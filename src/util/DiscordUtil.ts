import {
  ChatInputCommandInteraction,
  CommandInteraction,
  Guild,
  GuildMember,
  InteractionReplyOptions,
  MessagePayload,
  Snowflake,
} from "discord.js";

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
}
