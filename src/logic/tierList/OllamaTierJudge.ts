import {
  ConfigManager,
  DEFAULT_OLLAMA_CONFIG,
  ResolvedOllamaConfig,
} from "../../ConfigManager";
import {
  PlacementPromptPayload,
  TierConfidence,
  TierListFinalVerdict,
  TierListFinalVerdictPayload,
  TierListFinalReviewPayload,
  TierListFinalReviewRevision,
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
const OLLAMA_MAX_ATTEMPTS = 2;
const FINAL_VERDICT_MAX_LENGTH = 900;

export class OllamaTierJudge {
  async judge(payload: PlacementPromptPayload): Promise<TierJudgeResult> {
    const config = resolveOllamaConfig();
    if (!isUsable(config)) {
      return { source: "fallback", reason: "Ollama is disabled in config." };
    }

    try {
      const parsed = await this.withRetry(async () => {
        const response = await this.chat(config, payload);
        return parsePlacementResponse(response.message?.content ?? "");
      });
      return {
        source: "ollama",
        placement: parsed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { source: "fallback", reason: `Ollama failed: ${message}` };
    }
  }

  async reviewFinalTier(
    payload: TierListFinalReviewPayload
  ): Promise<
    | { source: "ollama"; revisions: TierListFinalReviewRevision[] }
    | { source: "fallback"; reason: string }
  > {
    const config = resolveOllamaConfig();
    if (!isUsable(config)) {
      return { source: "fallback", reason: "Ollama is disabled in config." };
    }

    try {
      const revisions = await this.withRetry(async () => {
        const response = await this.chat(config, payload, [
          "You are doing the final review pass for an Annihilation community tier list.",
          "Return only strict JSON: an array of objects with playerId, tier, position, reasoning, confidence.",
          payload.segment
            ? "Review only the players in the requested segment payload; do not return players from other segments."
            : "Review all players in the requested tier against each other and adjacent tier references.",
          "C is the community-average tier. B is above average, not the midpoint. S is exceptional and rare.",
          "Low-sample players are C/D by default; B requires accepted community or organiser context, and S/A/E are unavailable.",
          "High, mid, and low position must express ordering within the selected tier.",
          "Only move players to adjacent tiers unless the reasoning explicitly gives strong evidence.",
          "Treat raw team-game win rate as noisy context; prefer adjusted win score, MVP opportunity rate/count, captain opportunity/performance with sample size, draft value, and underdog wins.",
          "MVP and captain rates use opportunity denominators because a player cannot be MVP and captain in the same game.",
          "Do not cite a raw captain win percentage as decisive unless captainGames is large enough; use sample-smoothed captain context and mention tiny leadership samples as caveats.",
          "Elo values in the payload are all-season averages/percentiles, not a single current-season Elo.",
          "Do not include Discord IDs, markdown, or extra keys.",
        ]);
        return parseFinalReviewResponse(response.message?.content ?? "");
      });
      return {
        source: "ollama",
        revisions,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { source: "fallback", reason: `Ollama failed: ${message}` };
    }
  }

  async finalVerdict(
    payload: TierListFinalVerdictPayload
  ): Promise<
    | { source: "ollama"; verdict: TierListFinalVerdict }
    | { source: "fallback"; reason: string }
  > {
    const config = resolveOllamaConfig();
    if (!isUsable(config)) {
      return { source: "fallback", reason: "Ollama is disabled in config." };
    }

    try {
      const verdict = await this.withRetry(async () => {
        const response = await this.chat(config, payload, [
          "You are writing the final commentary verdict for a completed Annihilation community tier list.",
          "Return only strict JSON with exactly these string keys: S, A, B, C, D, E, overall.",
          "Write interesting tier commentary, not a completion report.",
          "For each tier, discuss what players in that tier are capable of as a group, how independent they look, the primary factors that put them there, and what limitations or caveats separate them from adjacent tiers.",
          "Refer to notable player names from the payload when useful, but do not list everyone.",
          "Account for sample size when discussing captain record, MVP rate, win rate, or limited-sample players.",
          "The verdict is commentary only. Do not change placements, invent moves, include Discord IDs, markdown, or extra keys.",
          "Keep each value concise and under 900 characters.",
        ]);
        return parseFinalVerdictResponse(response.message?.content ?? "");
      });
      return { source: "ollama", verdict };
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
    payload:
      | PlacementPromptPayload
      | TierListFinalReviewPayload
      | TierListFinalVerdictPayload,
    systemMessages?: string[]
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
              temperature: config.temperature ?? 0,
            },
            messages: [
              {
                role: "system",
                content: (
                  systemMessages ?? [
                    "You are ranking Annihilation players for a live community tier list.",
                    "Return only strict JSON with keys: tier, position, reasoning, confidence.",
                    "tier must be one of S, A, B, C, D, E.",
                    "position must be high, mid, or low.",
                    "confidence must be high, medium, low, or provisional.",
                    "C is the community-average tier.",
                    "B is above average, not the midpoint.",
                    "S requires exceptional evidence and should stay very small even with hundreds of players.",
                    "Low-sample players are C/D by default; B requires accepted community or organiser context, and S/A/E are unavailable.",
                    "MVP and captain rates use opportunity denominators because a player cannot be MVP and captain in the same game.",
                    "Do not cite a raw captain win percentage as decisive unless captainGames is large enough; use sample-smoothed captain context and mention tiny leadership samples as caveats.",
                    "Statistical bands are provisional evidence, not final authority.",
                    "Reason relative to existing placed players and comparables.",
                    "Do not include Discord IDs, raw player IDs, markdown, or extra keys.",
                  ]
                ).join(" "),
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

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= OLLAMA_MAX_ATTEMPTS; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= OLLAMA_MAX_ATTEMPTS) break;
      }
    }
    throw lastError;
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

export function parseFinalReviewResponse(
  content: string
): TierListFinalReviewRevision[] {
  const parsed = JSON.parse(extractJsonValue(content)) as unknown;
  const revisions = finalReviewRevisionArray(parsed);
  return revisions.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Invalid final review item");
    }
    const record = item as Record<string, unknown>;
    const playerId = record.playerId;
    const tier = record.tier;
    const position = record.position;
    const confidence = record.confidence;
    const reasoning = record.reasoning;

    if (typeof playerId !== "string" || playerId.length < 1) {
      throw new Error("Invalid or missing playerId");
    }
    if (!isTier(tier)) throw new Error("Invalid or missing tier");
    if (!isPosition(position)) throw new Error("Invalid or missing position");
    if (!isConfidence(confidence)) {
      throw new Error("Invalid or missing confidence");
    }
    if (typeof reasoning !== "string" || reasoning.trim().length < 20) {
      throw new Error("Invalid or missing reasoning");
    }

    return {
      playerId,
      tier,
      position,
      confidence,
      reasoning: reasoning.trim().slice(0, 700),
    };
  });
}

export function parseFinalVerdictResponse(
  content: string
): TierListFinalVerdict {
  const parsed = JSON.parse(extractJson(content)) as Record<string, unknown>;
  const verdict = {} as TierListFinalVerdict;
  for (const tier of ["S", "A", "B", "C", "D", "E"] as TierListTier[]) {
    verdict[tier] = parseVerdictText(parsed[tier], `${tier} verdict`);
  }
  verdict.overall = parseVerdictText(parsed.overall, "overall verdict");
  return verdict;
}

function finalReviewRevisionArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Final review must be an array or object");
  }

  const record = parsed as Record<string, unknown>;
  for (const key of ["revisions", "placements", "players", "items"]) {
    if (Array.isArray(record[key])) return record[key];
  }

  if (
    typeof record.playerId === "string" &&
    record.tier &&
    record.position &&
    record.reasoning &&
    record.confidence
  ) {
    return [record];
  }

  throw new Error("Final review must be an array or an object with revisions");
}

function parseVerdictText(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length < 10) {
    throw new Error(`Invalid or missing ${label}`);
  }
  return value.trim().slice(0, FINAL_VERDICT_MAX_LENGTH);
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
  const value = extractJsonValue(content);
  if (!value.startsWith("{")) {
    throw new Error("No JSON object in model response");
  }
  return value;
}

function extractJsonValue(content: string) {
  const trimmed = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/gi, "")
    .trim();
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start === -1) {
    throw new Error("No JSON in model response");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  const open = trimmed[start];
  const close = open === "{" ? "}" : "]";
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
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0) return trimmed.slice(start, i + 1);
  }
  throw new Error("No complete JSON in model response");
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
