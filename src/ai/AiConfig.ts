import { Config, ConfigManager } from "../ConfigManager";

/** No model IDs, channel lists, limits or feature switches are read from .env. */
export const AI_DEFAULTS = {
  dailyRequestLimit: 50,
  requestTimeoutMs: 20_000,
  maxResponseBytes: 64 * 1024,
  // GPT-OSS completion tokens also cover internal reasoning before visible text.
  // Keep a bounded but less truncation-prone allowance; the prompt remains concise.
  maxOutputTokens: 1024,
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
