import { Config, ConfigManager } from "../ConfigManager";

/** No model IDs, channel lists, limits or feature switches are read from .env. */
export const AI_DEFAULTS = {
  // Shared process-wide cap across all users/providers, not per-user.
  // Five rolling requests/minute per caller limits bursts separately.
  dailyRequestLimit: 300,
  requestTimeoutMs: 20_000,
  maxResponseBytes: 64 * 1024,
  // Non-Groq providers keep their existing completion cap.
  maxOutputTokens: 1024,
  // GPT-OSS also spends completion tokens on hidden reasoning. Keep the first
  // Groq request generous and reserve one bounded larger retry for truncation.
  groqMaxOutputTokens: 3072,
  groqRetryMaxOutputTokens: 4096,
  maxToolCalls: 4,
  maxToolRounds: 2,
  temperature: 0.1,
  models: {
    groq: "openai/gpt-oss-20b",
    gemini: "gemini-2.5-flash",
    cloudflare: "@cf/qwen/qwen3-30b-a3b-fp8",
  },
  /** The first provider with usable credentials and prerequisites wins. */
  providerPriority: ["groq", "gemini", "cloudflare"] as const,
} as const;

export type AiSettings = {
  enabled: boolean;
  mentionEnabled?: boolean;
  mentionExcludedChannels?: ReadonlySet<string>;
  channelIds: ReadonlySet<string>;
  dailyRequestLimit: number;
  cloudflareAccountId?: string;
};

export function getAiSettings(
  config: Pick<Config, "ai" | "channels"> = ConfigManager.getConfig()
): AiSettings {
  const commands = config.channels.botCommands;
  return {
    enabled: config.ai?.enabled === true,
    mentionEnabled:
      config.ai?.enabled === true && config.ai.mentionEnabled !== false,
    mentionExcludedChannels: new Set(
      (config.ai?.mentionExcludedChannels ?? []).filter(
        (id) => typeof id === "string" && /^\d{8,25}$/.test(id)
      )
    ),
    // A missing/invalid bot-command channel is never an invitation to run everywhere.
    channelIds: new Set(
      typeof commands === "string" && /^\d{8,25}$/.test(commands)
        ? [commands]
        : []
    ),
    dailyRequestLimit: AI_DEFAULTS.dailyRequestLimit,
    cloudflareAccountId: config.ai?.cloudflareAccountId,
  };
}
