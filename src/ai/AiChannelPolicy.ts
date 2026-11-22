import { ChannelType, Client, Guild } from "discord.js";
import { Config } from "../ConfigManager";
import { AiSettings } from "./AiConfig";

type ChannelsConfig = Config["channels"];

const ELIGIBLE_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

/** Both /ask and @Navi use the same mandatory and optional channel blacklist. */
export function mentionChannelBlacklist(
  channels: ChannelsConfig,
  settings: AiSettings
): ReadonlySet<string> {
  return new Set([
    channels.teamPickingChat,
    channels.announcements,
    channels.gameFeed,
    ...(settings.mentionExcludedChannels ?? []),
  ]);
}

/** Deny excluded channels and their threads; reject unsupported channel types. */
export function isNaviGuildChannelEligible(
  channelType: ChannelType | undefined,
  channelId: string,
  parentId: string | null | undefined,
  channels: ChannelsConfig,
  settings: AiSettings
): boolean {
  if (channelType === undefined || !ELIGIBLE_TYPES.has(channelType))
    return false;
  const blacklist = mentionChannelBlacklist(channels, settings);
  return !blacklist.has(channelId) && !(parentId && blacklist.has(parentId));
}

/** The configured bot-command channel anchors the trusted home server. */
export async function resolveNaviHomeGuild(
  client: Client,
  settings: AiSettings
): Promise<Guild | null> {
  const channelId = settings.channelIds.values().next().value;
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (
      channel?.type !== ChannelType.GuildText &&
      channel?.type !== ChannelType.GuildAnnouncement
    )
      return null;
    return channel.guild;
  } catch {
    return null;
  }
}
