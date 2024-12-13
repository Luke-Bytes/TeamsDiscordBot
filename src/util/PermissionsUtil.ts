import { GuildMember, ChatInputCommandInteraction } from "discord.js";
import { Config, ConfigManager } from "../ConfigManager";

export class PermissionsUtil {
  static readonly config: Config = ConfigManager.getConfig();

  static isChannel(
    interaction: ChatInputCommandInteraction,
    channelKeyOrId: keyof Config["channels"] | string
  ): boolean {
    const channelId =
      this.config.channels[channelKeyOrId as keyof Config["channels"]] ??
      channelKeyOrId;
    return interaction.channelId === channelId;
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
