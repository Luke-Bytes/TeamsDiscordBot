import { Client, Message } from "discord.js";
import { Config, ConfigManager } from "../ConfigManager";
import { AiSettings } from "../ai/AiConfig";
import {
  isNaviGuildChannelEligible,
  resolveNaviHomeGuild,
} from "../ai/AiChannelPolicy";
import { AiRequestService, validAiQuestion } from "../ai/AiRequestService";

export { mentionChannelBlacklist } from "../ai/AiChannelPolicy";

type ChannelsConfig = Config["channels"];

/** Discord mention metadata AND the actual inline token must agree. */
export function extractNaviQuestion(
  message: Pick<Message, "content" | "mentions">,
  botId: string
): string | null {
  if (!/^\d{8,25}$/.test(botId) || !message.mentions.users.has(botId))
    return null;
  const token = new RegExp(`<@!?${botId}>`, "g");
  if (!token.test(message.content)) return null;
  // Only inline text is ever passed to Navi: no attachments, embeds, parent
  // messages, message references, or channel history.
  return message.content.replace(token, "").trim();
}

/** Focused Discord adapter; the /ask command owns the shared AI service. */
export class AiMentionHandler {
  private lastDenialByUser = new Map<string, number>();
  private home?: { channelId: string; guildId: string };

  constructor(
    private readonly assistant: AiRequestService,
    private readonly channels: ChannelsConfig = ConfigManager.getConfig()
      .channels
  ) {}

  private async homeGuildId(
    client: Client,
    settings: AiSettings
  ): Promise<string | null> {
    // botCommands is an anchor for the home guild, not a channel whitelist.
    const channelId = settings.channelIds.values().next().value;
    if (!channelId) return null;
    if (this.home?.channelId === channelId) return this.home.guildId;
    const guild = await resolveNaviHomeGuild(client, settings);
    if (!guild) return null;
    this.home = { channelId, guildId: guild.id };
    return guild.id;
  }

  private async reply(
    message: Message,
    content: string,
    admitted: boolean
  ): Promise<void> {
    if (!admitted) {
      // One rejection per user per 15s at most; denied attempts do not consume AI
      // quota. A flood of invalid or throttled mentions must not cause reply spam.
      const now = Date.now();
      if (now - (this.lastDenialByUser.get(message.author.id) ?? 0) < 15_000)
        return;
      if (this.lastDenialByUser.size >= 500) this.lastDenialByUser.clear();
      this.lastDenialByUser.set(message.author.id, now);
    }
    await message.reply({
      content,
      allowedMentions: { parse: [], repliedUser: false },
      failIfNotExists: true,
    });
  }

  /**
   * Returns true for a real inline @Navi mention (even if disabled/excluded):
   * such messages must never be fed to picking/tier-list message handlers.
   */
  async handle(message: Message): Promise<boolean> {
    const botId = message.client.user?.id;
    if (!message.guild || !botId || message.author.bot || message.webhookId)
      return false;
    const question = extractNaviQuestion(message, botId);
    if (question === null) return false;

    const config = this.assistant.getSettings();
    if (!config.enabled || config.mentionEnabled === false) return true;
    if (
      !isNaviGuildChannelEligible(
        message.channel.type,
        message.channelId,
        "parentId" in message.channel ? message.channel.parentId : null,
        this.channels,
        config
      )
    )
      return true;
    const dev = ConfigManager.getConfig().dev;
    if (dev.enabled && message.guild.id !== dev.guildId) return true;
    const homeGuildId = await this.homeGuildId(message.client, config);
    if (!homeGuildId || homeGuildId !== message.guild.id) return true;
    // Invalid, empty, oversized or credential-bearing mentions are silent.
    // The shared service repeats the identical check before admission.
    if (!validAiQuestion(question)) return true;

    await this.assistant.handle({
      question,
      userId: message.author.id,
      guild: message.guild,
      client: message.client,
      scope: "guild",
      invocation: "mention",
      onAdmitted: async () => {
        try {
          if ("sendTyping" in message.channel)
            await message.channel.sendTyping();
        } catch {
          // Missing typing permission does not grant any further privileges.
        }
      },
      respond: async (content, admitted) => {
        await this.reply(message, content, admitted);
      },
    });
    return true;
  }
}
