import { GuildMember, ChatInputCommandInteraction } from "discord.js";
import { Config, ConfigManager } from "../ConfigManager";

export class PermissionsUtil {
  static readonly config: Config = ConfigManager.getConfig();

  static isChannel(
    source: { channelId?: string } | { channel: { id: string } },
    channelKeyOrId: keyof Config["channels"] | string
  ): boolean {
    const channelId =
      this.config.channels[channelKeyOrId as keyof Config["channels"]] ??
      channelKeyOrId;
    if ("channelId" in source) {
      return source.channelId === channelId;
    } else if ("channel" in source && source.channel.id) {
      return source.channel.id === channelId;
    }
    return false;
  }

  static hasRole(
    member: GuildMember | undefined,
    roleKeyOrId: keyof Config["roles"] | string
  ): boolean {
    if (!member) return false;
    const roleId =
      this.config.roles[roleKeyOrId as keyof Config["roles"]] ?? roleKeyOrId;
    return member.roles.cache.has(roleId);
  }

  static isSameUser(
    interaction: ChatInputCommandInteraction,
    targetUserId: string
  ): boolean {
    return interaction.user.id === targetUserId;
  }

  static isDebugEnabled(): boolean {
    return this.config.dev.enabled;
  }
}
