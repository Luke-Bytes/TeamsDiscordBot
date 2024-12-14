import {
  ChatInputCommandInteraction,
  CommandInteraction,
  GuildMember,
  InteractionReplyOptions,
  MessagePayload,
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
}
