import {
  ChatInputCommandInteraction,
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

/** Explicit, ephemeral opt-in command. AI never listens to ordinary messages. */
export default class AskCommand implements Command {
  public name = "ask";
  public description =
    "Ask about Friendly Wars rules or approved public statistics";
  public buttonIds: string[] = [];
  public data: SlashCommandOptionsOnlyBuilder = new SlashCommandBuilder()
    .setName("ask")
    .setDescription(
      "Ask the optional AI assistant (sends your question to an external provider)"
    )
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("Your question (no passwords or private data)")
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
    const guild = interaction.guild;
    if (
      !guild ||
      !interaction.guildId ||
      !config.channelIds.has(interaction.channelId) ||
      (ConfigManager.getConfig().dev.enabled &&
        interaction.guildId !== ConfigManager.getConfig().dev.guildId)
    ) {
      await interaction.reply({
        content: "AI questions are only available in approved server channels.",
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
    const release = this.admission.acquire(
      interaction.user.id,
      interaction.guildId
    );
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
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
        organiser: membership.organiser,
        caller: {
          discordUserId: interaction.user.id,
          guildId: interaction.guildId,
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
      await interaction.editReply({
        content: reply || "No verified answer was available.",
        allowedMentions: { parse: [] },
      });
      // Only aggregate outcome/latency. Never log questions, retrieved text, tool JSON or keys.
      console.info(
        `ai.ask outcome=completed duration_ms=${Date.now() - began} tools=${result.toolNames.length}`
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
