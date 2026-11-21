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
import { PermissionsUtil } from "../util/PermissionsUtil";
import { AiSettings, getAiSettings } from "../ai/AiConfig";
import { selectAiProvider } from "../ai/AiProviderSelection";
import { AiAdmission } from "../ai/Admission";
import { answerAiQuestion, safeDiscordText } from "../ai/AiAssistant";
import { AiCaller } from "../ai/AiTools";
import { buildApprovedKnowledge, KnowledgeChunk } from "../ai/Knowledge";

const SAFE_QUESTION =
  /(?:sk-[a-zA-Z0-9_-]{16,}|AIza[a-zA-Z0-9_-]{20,}|BOT_TOKEN\s*=|DATABASE_URL\s*=|-----BEGIN .*PRIVATE KEY-----)/i;

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

  private admission = new AiAdmission(getAiSettings().dailyRequestLimit);
  private knowledge?: KnowledgeChunk[];

  constructor(private readonly injectedSettings?: AiSettings) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = this.injectedSettings ?? getAiSettings();
    if (!config.enabled) {
      await interaction.reply({
        content:
          "The AI assistant is not enabled. Use /help, /stats or /season view.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    // DMs carry no guild context. Anchor them exclusively to the guild owning
    // the configured bot-command channel; never pick an arbitrary mutual guild.
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
          // Fail closed on missing or inaccessible configured server channels.
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
    const question = interaction.options.getString("question", true).trim();
    if (
      question.length < 3 ||
      question.length > 450 ||
      SAFE_QUESTION.test(question)
    ) {
      await interaction.reply({
        content:
          "Please enter a short question without credentials or private data.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const release = this.admission.acquire(interaction.user.id, guildId);
    if (!release) {
      await interaction.reply({
        content: "AI is busy or rate-limited. Please retry later.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const began = Date.now();
    try {
      // Public server-channel reply; a bot DM is private by its channel type.
      await interaction.deferReply();
      // Force a fresh Discord membership check; never rely on model text or stale role caches.
      const verifyMembership: AiCaller["verifyMembership"] = async () => {
        try {
          const member = await guild.members.fetch({
            user: interaction.user.id,
            force: true,
          });
          return {
            member: Boolean(member),
            organiser: PermissionsUtil.hasRole(member, "organiserRole"),
          };
        } catch {
          return { member: false, organiser: false };
        }
      };
      const membership = await verifyMembership();
      if (!membership.member) {
        await interaction.editReply({
          content: "Unable to verify server membership. Try again later.",
          allowedMentions: { parse: [] },
        });
        return;
      }
      const selected = selectAiProvider({ settings: config });
      if (!selected.ok) {
        await interaction.editReply({
          content:
            selected.reason === "cloudflare-account"
              ? "AI setup is incomplete: ask an administrator to set ai.cloudflareAccountId for Cloudflare Workers AI."
              : "No AI provider is configured. Ask an administrator to add a Groq, Gemini or Cloudflare credential.",
          allowedMentions: { parse: [] },
        });
        return;
      }
      this.knowledge ??= buildApprovedKnowledge(process.cwd());
      const result = await answerAiQuestion({
        question,
        // Audience is based on the caller's verified role, not DM vs guild.
        // Reviewed workflow descriptions are public; live organiser-only
        // tools remain role-gated even when a reply appears in a public channel.
        organiser: membership.organiser,
        caller: {
          discordUserId: interaction.user.id,
          guildId,
          verifyMembership,
        },
        knowledge: this.knowledge,
        infer: selected.infer,
      });
      const citations = result.sources.length
        ? `\n\nSources: ${result.sources.slice(0, 3).join("; ")}`
        : "";
      const dataSources = [
        ...new Set(
          result.toolNames.map((name) =>
            name.startsWith("get_historical_") ||
            name.startsWith("get_my_historical_") ||
            name === "list_historical_seasons"
              ? "REST_API historical stats"
              : name === "get_current_game_state" ||
                  name === "get_game_diagnostics"
                ? "current bot process snapshot"
                : "Teams bot read-only database"
          )
        ),
      ];
      const database = dataSources.length
        ? `\nData: ${dataSources.join("; ")} (read-only)`
        : "";
      const reply = (safeDiscordText(result.text) + citations + database).slice(
        0,
        1850
      );
      const delivered = reply || "No verified answer was available.";
      await interaction.editReply({
        content: delivered,
        allowedMentions: { parse: [] },
      });
      // Log the exact final, sanitised Discord output after successful delivery.
      // JSON quoting keeps untrusted text on one log line. Never log prompts,
      // tool payloads, provider bodies, or credentials.
      console.info(
        `ai.ask outcome=${result.failureKind ? "provider_failed" : "completed"} scope=${directMessage ? "dm" : "guild"} provider=${selected.provider} duration_ms=${Date.now() - began} tools=${result.toolNames.length}${result.failureKind ? ` error_kind=${result.failureKind} error_code=${result.failureCode ?? "unknown"}` : ""} reply=${JSON.stringify(delivered)}`
      );
    } catch {
      try {
        const failure = {
          content: "AI is unavailable; /stats and /leaderboards still work.",
          allowedMentions: { parse: [] as [] },
        };
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(failure);
        } else {
          await interaction.reply({
            ...failure,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        // The interaction may have expired; never leak the original request.
      }
      console.warn(`ai.ask outcome=failed duration_ms=${Date.now() - began}`);
    } finally {
      release();
    }
  }
}
