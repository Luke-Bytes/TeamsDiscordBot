import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  Client,
  Guild,
} from "discord.js";
import { ConfigManager } from "../ConfigManager";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { AiSettings, getAiSettings } from "./AiConfig";
import { selectAiProvider } from "./AiProviderSelection";
import { AiAdmission } from "./Admission";
import { answerAiQuestion, safeDiscordText } from "./AiAssistant";
import { AiCaller } from "./AiTools";
import { getGameDiscordDiagnostics } from "./GameDiscordRead";
import { buildApprovedKnowledge, KnowledgeChunk } from "./Knowledge";

// These checks apply to both entry points, before admission or any provider read.
const CREDENTIAL_INPUT =
  /(?:gsk_[a-zA-Z0-9_-]{16,}|sk-[a-zA-Z0-9_-]{16,}|AIza[a-zA-Z0-9_-]{20,}|(?:MC_AI_[A-Z0-9_]+|BOT_TOKEN|DATABASE_URL)\s*=|-----BEGIN .*PRIVATE KEY-----)/i;

export function validAiQuestion(question: string): boolean {
  const trimmed = question.trim();
  return (
    trimmed.length >= 3 &&
    trimmed.length <= 450 &&
    !CREDENTIAL_INPUT.test(trimmed)
  );
}

export type AiRequest = {
  question: string;
  userId: string;
  guild: Guild;
  client: Client;
  scope: "dm" | "guild";
  invocation: "slash" | "mention";
  /** Discord-specific initial acknowledgement (defer or typing). */
  onAdmitted: () => Promise<void>;
  /** Discord-specific delivery (ephemeral preflight or public reply). */
  respond: (text: string, admitted: boolean) => Promise<void>;
};

export class AiRequestService {
  // Exactly one process-local admission shared by /ask and @Navi when invoked
  // through the same AskCommand instance. No independent mention limiter.
  private readonly admission: AiAdmission;
  private knowledge?: KnowledgeChunk[];
  private commandCatalogue?: {
    expiresAt: number;
    value: {
      status: "ok";
      commands: string[];
      paths: string[];
      total: number;
      truncated: boolean;
    };
  };

  constructor(private readonly injectedSettings?: AiSettings) {
    this.admission = new AiAdmission(
      injectedSettings?.dailyRequestLimit ?? getAiSettings().dailyRequestLimit
    );
  }

  getSettings(): AiSettings {
    return this.injectedSettings ?? getAiSettings();
  }

  private async respondBeforeAdmission(request: AiRequest, content: string) {
    try {
      await request.respond(content, false);
    } catch {
      // Deleted messages or missing permissions must not reject the event listener.
      console.warn(
        `ai.ask outcome=delivery_failed invocation=${request.invocation}`
      );
    }
  }

  async handle(request: AiRequest): Promise<void> {
    const config = this.getSettings();
    if (!config.enabled) {
      await this.respondBeforeAdmission(
        request,
        "The AI assistant is not enabled. Use /help, /stats or /season view."
      );
      return;
    }
    const question = request.question.trim();
    if (!validAiQuestion(question)) {
      await this.respondBeforeAdmission(
        request,
        "Please enter a short question without credentials or private data."
      );
      return;
    }
    const admission = this.admission.tryAcquire(
      request.userId,
      request.guild.id
    );
    if (!admission.ok) {
      const content =
        admission.reason === "user_cooldown"
          ? `Give me ${admission.retryAfterSeconds} more second${admission.retryAfterSeconds === 1 ? "" : "s"} before asking again.`
          : admission.reason === "user_minute_limit"
            ? `You've reached 5 questions in a minute. Try again in ${admission.retryAfterSeconds} second${admission.retryAfterSeconds === 1 ? "" : "s"}.`
            : admission.reason === "user_inflight"
              ? "I'm still working on your previous question."
              : admission.reason === "daily_limit"
                ? "Navi's daily AI request limit has been reached. Try again after 00:00 UTC."
                : "Navi is handling other questions right now. Try again shortly.";
      await this.respondBeforeAdmission(request, content);
      console.info(
        `ai.ask outcome=denied scope=${request.scope} reason=${admission.reason}${admission.retryAfterSeconds === undefined ? "" : ` retry_after_s=${admission.retryAfterSeconds}`} invocation=${request.invocation}`
      );
      return;
    }

    const began = Date.now();
    let acknowledged = false;
    let deliveryAttempted = false;
    const deliver = async (content: string) => {
      deliveryAttempted = true;
      await request.respond(content, true);
    };
    try {
      await request.onAdmitted();
      acknowledged = true;
      // Caller identity and privileges are never sourced from the question.
      // Re-fetch before answering and during every tool round.
      const verifyMembership: AiCaller["verifyMembership"] = async () => {
        try {
          const member = await request.guild.members.fetch({
            user: request.userId,
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
        await deliver("Unable to verify server membership. Try again later.");
        return;
      }

      const selected = selectAiProvider({ settings: config });
      if (!selected.ok) {
        await deliver(
          selected.reason === "cloudflare-account"
            ? "AI setup is incomplete: ask an administrator to set ai.cloudflareAccountId for Cloudflare Workers AI."
            : "No AI provider is configured. Ask an administrator to add a Groq, Gemini or Cloudflare credential."
        );
        return;
      }
      this.knowledge ??= buildApprovedKnowledge(process.cwd());
      const caller: AiCaller = {
        discordUserId: request.userId,
        guildId: request.guild.id,
        verifyMembership,
        inspectGameDiscord: (focus, targetIGN) =>
          getGameDiscordDiagnostics(request.guild, focus, targetIGN),
        listCommands: async () => {
          if (
            this.commandCatalogue &&
            this.commandCatalogue.expiresAt > Date.now()
          )
            return this.commandCatalogue.value;
          try {
            const registered = ConfigManager.getConfig().dev.enabled
              ? await request.guild.commands.fetch()
              : await request.client.application?.commands.fetch();
            if (!registered) return { status: "unavailable" as const };
            const definitions = registered.filter(
              (command) => command.type === ApplicationCommandType.ChatInput
            );
            const commands = definitions
              .map(
                (command) =>
                  `/${command.name}: ${command.description.slice(0, 42)}`
              )
              .sort((a, b) => a.localeCompare(b));
            const paths = [...definitions.values()].flatMap((command) => {
              const root = `/${command.name}`;
              const paths = [root];
              for (const option of command.options) {
                if (option.type === ApplicationCommandOptionType.Subcommand)
                  paths.push(`${root} ${option.name}`);
                if (
                  option.type === ApplicationCommandOptionType.SubcommandGroup
                )
                  for (const nested of option.options ?? [])
                    if (nested.type === ApplicationCommandOptionType.Subcommand)
                      paths.push(`${root} ${option.name} ${nested.name}`);
              }
              return paths;
            });
            const value = {
              status: "ok" as const,
              commands: commands.slice(0, 60),
              paths,
              total: commands.length,
              truncated: commands.length > 60,
            };
            this.commandCatalogue = { expiresAt: Date.now() + 180_000, value };
            return value;
          } catch {
            return { status: "unavailable" as const };
          }
        },
        listOrganisers: async () => {
          if (request.guild.memberCount > 3000)
            return { status: "unavailable" as const };
          try {
            const members = await request.guild.members.fetch();
            const names = members
              .filter(
                (member) =>
                  !member.user.bot &&
                  PermissionsUtil.hasRole(member, "organiserRole")
              )
              .map((member) => member.displayName.slice(0, 32))
              .sort((a, b) => a.localeCompare(b));
            return {
              status: "ok" as const,
              names: names.slice(0, 40),
              total: names.length,
              truncated: names.length > 40,
            };
          } catch {
            return { status: "unavailable" as const };
          }
        },
      };
      const result = await answerAiQuestion({
        question,
        organiser: membership.organiser,
        caller,
        knowledge: this.knowledge,
        infer: selected.infer,
      });
      const delivered =
        safeDiscordText(result.text, result.trustedLinks) ||
        "No verified answer was available.";
      await deliver(delivered);
      // Only the sanitised delivered reply and bounded metadata enter logs.
      // No prompt, provider body, tool payload or credentials are logged.
      console.info(
        `ai.ask outcome=${result.failureKind ? "provider_failed" : "completed"} scope=${request.scope} invocation=${request.invocation} provider=${selected.provider} duration_ms=${Date.now() - began} tools=${result.toolNames.length} sources_used=${result.sources.length}${result.failureKind ? ` error_kind=${result.failureKind} error_code=${result.failureCode ?? "unknown"}` : ""} reply=${JSON.stringify(delivered)}`
      );
    } catch {
      if (!deliveryAttempted) {
        try {
          await request.respond(
            "AI is unavailable; /stats and /leaderboards still work.",
            acknowledged
          );
        } catch {
          // Discord message may be deleted or interaction expired; no fallback sends.
        }
      }
      // Never attempt a second reply if Discord already rejected the first.
      console.warn(
        `ai.ask outcome=failed scope=${request.scope} invocation=${request.invocation} duration_ms=${Date.now() - began}`
      );
    } finally {
      admission.release();
    }
  }
}
