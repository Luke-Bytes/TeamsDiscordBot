import {
  ChannelType,
  ChatInputCommandInteraction,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { ConfigManager } from "../ConfigManager";
import { AiSettings } from "../ai/AiConfig";
import { AiRequestService } from "../ai/AiRequestService";

/** Explicit opt-in slash command. Server replies are public; DMs stay private. */
export default class AskCommand implements Command {
  public name = "ask";
  public description = "Ask Navi about anything relating to Friendly Wars!";
  public buttonIds: string[] = [];
  public data: SlashCommandOptionsOnlyBuilder = new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Navi a Question!")
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("Ask Navi a Question!")
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(450)
    );

  /** The same service instance is passed to the message mention listener. */
  public readonly assistant: AiRequestService;

  constructor(injectedSettings?: AiSettings) {
    this.assistant = new AiRequestService(injectedSettings);
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = this.assistant.getSettings();
    if (!config.enabled) {
      await interaction.reply({
        content:
          "The AI assistant is not enabled. Use /help, /stats or /season view.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    // DMs carry no guild context. Resolve only the configured bot-command
    // channel's guild; never guess from mutual guilds or the message text.
    const directMessage =
      !interaction.guildId &&
      (interaction.context === InteractionContextType.BotDM ||
        interaction.channel?.type === ChannelType.DM);
    let guild = interaction.guild;
    let guildId = interaction.guildId;
    if (directMessage) {
      const commandChannelId = config.channelIds.values().next().value;
      if (commandChannelId) {
        try {
          const channel =
            await interaction.client.channels.fetch(commandChannelId);
          if (
            channel?.type === ChannelType.GuildText ||
            channel?.type === ChannelType.GuildAnnouncement
          ) {
            guild = channel.guild;
            guildId = guild.id;
          }
        } catch {
          // Fail closed on inaccessible home-guild configuration.
        }
      }
    }
    if (
      !guild ||
      !guildId ||
      (!directMessage && !config.channelIds.has(interaction.channelId)) ||
      (ConfigManager.getConfig().dev.enabled &&
        guildId !== ConfigManager.getConfig().dev.guildId)
    ) {
      await interaction.reply({
        content:
          "AI questions are only available in the bot-command channel or in DMs from verified server members.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await this.assistant.handle({
      question: interaction.options.getString("question", true),
      userId: interaction.user.id,
      guild,
      client: interaction.client,
      scope: directMessage ? "dm" : "guild",
      invocation: "slash",
      onAdmitted: async () => {
        await interaction.deferReply();
      },
      respond: async (content, admitted) => {
        const allowedMentions = { parse: [] as [] };
        if (admitted || interaction.deferred || interaction.replied) {
          await interaction.editReply({ content, allowedMentions });
        } else {
          await interaction.reply({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions,
          });
        }
      },
    });
  }
}
