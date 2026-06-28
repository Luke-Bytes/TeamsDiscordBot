import {
  ConfigManager,
  DEFAULT_OLLAMA_CONFIG,
  ResolvedOllamaConfig,
} from "../../ConfigManager";
import {
  PlacementPromptPayload,
  TierConfidence,
  TierListTier,
  TierPlacement,
  TierPosition,
} from "./types";

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
};

type OllamaTagsResponse = {
  models?: { name?: string; model?: string }[];
};

export type OllamaStatus = {
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  reachable: boolean;
  modelAvailable: boolean;
  message: string;
};

type TierJudgeResult =
  | {
      source: "ollama";
      placement: Omit<TierPlacement, "playerId" | "displayName" | "score">;
    }
  | { source: "fallback"; reason: string };

const TIERS = new Set<TierListTier>(["S", "A", "B", "C", "D", "E"]);
const POSITIONS = new Set<TierPosition>(["high", "mid", "low"]);
const CONFIDENCES = new Set<TierConfidence>([
  "high",
  "medium",
  "low",
  "provisional",
]);

export class OllamaTierJudge {
  async judge(payload: PlacementPromptPayload): Promise<TierJudgeResult> {
    const config = resolveOllamaConfig();
    if (!isUsable(config)) {
      return { source: "fallback", reason: "Ollama is disabled in config." };
    }

    try {
      const response = await this.chat(config, payload);
      const parsed = parsePlacementResponse(response.message?.content ?? "");
      return {
        source: "ollama",
        placement: parsed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { source: "fallback", reason: `Ollama failed: ${message}` };
    }
  }

  async status(): Promise<OllamaStatus> {
    const config = resolveOllamaConfig();
    if (!isUsable(config)) {
      return {
        enabled: false,
        baseUrl: config.baseUrl,
        model: config.model,
        reachable: false,
        modelAvailable: false,
        message: "Ollama is disabled or missing baseUrl/model in config.",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.timeoutMs ?? 60000
    );
    try {
      const response = await fetch(
        `${trimTrailingSlash(config.baseUrl)}/api/tags`,
        { signal: controller.signal }
      );
      if (!response.ok) {
        return {
          enabled: true,
          baseUrl: config.baseUrl,
          model: config.model,
          reachable: false,
          modelAvailable: false,
          message: `Ollama returned HTTP ${response.status}.`,
        };
      }
      const body = (await response.json()) as OllamaTagsResponse;
      const modelNames = (body.models ?? []).flatMap((model) =>
        [model.name, model.model].filter(Boolean)
      );
      const modelAvailable = modelNames.includes(config.model);
      return {
        enabled: true,
        baseUrl: config.baseUrl,
        model: config.model,
        reachable: true,
        modelAvailable,
        message: modelAvailable
          ? "Configured model is available."
          : "Ollama is reachable but the configured model was not listed.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        enabled: true,
        baseUrl: config.baseUrl,
        model: config.model,
        reachable: false,
        modelAvailable: false,
        message: `Ollama status failed: ${message}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async chat(
    config: ResolvedOllamaConfig,
    payload: PlacementPromptPayload
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.timeoutMs ?? 60000
    );

    try {
      const response = await fetch(
        `${trimTrailingSlash(config.baseUrl)}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            stream: false,
            format: "json",
            options: {
              temperature: config.temperature ?? 0.2,
            },
            messages: [
              {
                role: "system",
                content: [
                  "You are ranking Annihilation players for a live community tier list.",
                  "Return only strict JSON with keys: tier, position, reasoning, confidence.",
                  "tier must be one of S, A, B, C, D, E.",
                  "position must be high, mid, or low.",
                  "confidence must be high, medium, low, or provisional.",
                  "Reason relative to existing placed players and comparables.",
                  "Do not include Discord IDs, raw player IDs, markdown, or extra keys.",
                ].join(" "),
              },
              {
                role: "user",
                content: JSON.stringify(payload),
              },
            ],
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return (await response.json()) as OllamaChatResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parsePlacementResponse(
  content: string
): Omit<TierPlacement, "playerId" | "displayName" | "score"> {
  const parsed = JSON.parse(extractJson(content)) as Record<string, unknown>;
  const tier = parsed.tier;
  const position = parsed.position;
  const confidence = parsed.confidence;
  const reasoning = parsed.reasoning;

  if (!isTier(tier)) throw new Error("Invalid or missing tier");
  if (!isPosition(position)) throw new Error("Invalid or missing position");
  if (!isConfidence(confidence)) {
    throw new Error("Invalid or missing confidence");
  }
  if (typeof reasoning !== "string" || reasoning.trim().length < 20) {
    throw new Error("Invalid or missing reasoning");
  }

  return {
    tier,
    position,
    confidence,
    reasoning: reasoning.trim().slice(0, 700),
  };
}

function resolveOllamaConfig(): ResolvedOllamaConfig {
  return {
    ...DEFAULT_OLLAMA_CONFIG,
    ...ConfigManager.getConfig().llm?.ollama,
  };
}

function isUsable(config: ResolvedOllamaConfig) {
  return Boolean(config.enabled && config.baseUrl && config.model);
}

function extractJson(content: string) {
  const trimmed = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/gi, "")
    .trim();
  const start = trimmed.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object in model response");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return trimmed.slice(start, i + 1);
  }
  throw new Error("No complete JSON object in model response");
}

function isTier(value: unknown): value is TierListTier {
  return typeof value === "string" && TIERS.has(value as TierListTier);
}

function isPosition(value: unknown): value is TierPosition {
  return typeof value === "string" && POSITIONS.has(value as TierPosition);
}

function isConfidence(value: unknown): value is TierConfidence {
  return typeof value === "string" && CONFIDENCES.has(value as TierConfidence);
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
