import { AI_DEFAULTS } from "./AiConfig";
import { loadAiCredential } from "./AiCredentials";
import { AiHttpOptions, requestAiJson } from "./AiHttp";
import {
  AiFunctionCall,
  AiInference,
  AiTransportError,
  validateCalls,
} from "./AiProvider";

// Compatibility for existing consumers; the contract itself lives in AiProvider.
export type {
  AiMessage,
  AiFunctionCall,
  AiFunctionTool,
  AiTurn,
  AiInference,
} from "./AiProvider";
export { AiTransportError } from "./AiProvider";

export function loadGroqCredential(
  env: NodeJS.ProcessEnv = process.env
): string {
  return loadAiCredential("groq", env);
}

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export function createGroqInference(
  options: {
    model: string;
    credential?: () => string;
  } & AiHttpOptions
): AiInference {
  const credential = options.credential ?? loadGroqCredential;
  return async (messages, tools, signal) => {
    if (signal?.aborted) throw new AiTransportError("cancelled");
    const key = credential();
    // A truncated completion is not usable as a tool call or an answer.
    // Re-run inference at most once, without executing any partial tool calls
    // or switching providers. Both attempts share the same inference deadline.
    const timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? AI_DEFAULTS.requestTimeoutMs, 1000),
      30_000
    );
    const deadline = Date.now() + timeoutMs;
    const wireMessages = messages.map((message) => {
      if (message.role !== "assistant") return message;
      const { continuation, ...wire } = message;
      void continuation;
      return wire;
    });
    let choice:
      | {
          finish_reason?: string;
          message?: { content?: unknown; tool_calls?: unknown };
        }
      | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new AiTransportError("cancelled");
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || (attempt > 0 && remainingMs < 1000))
        throw new AiTransportError("timeout");
      const parsed = await requestAiJson(
        ENDPOINT,
        {
          model: options.model,
          messages: wireMessages,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? "auto" : undefined,
          parallel_tool_calls: false,
          temperature: AI_DEFAULTS.temperature,
          max_completion_tokens:
            attempt === 0
              ? AI_DEFAULTS.groqMaxOutputTokens
              : AI_DEFAULTS.groqRetryMaxOutputTokens,
          // Use less hidden reasoning on the recovery request to leave room
          // for a complete tool call or a concise visible answer.
          reasoning_effort: attempt === 0 ? "medium" : "low",
          stream: false,
        },
        { authorization: `Bearer ${key}` },
        { ...options, timeoutMs: remainingMs },
        signal
      );
      const choices = (parsed as { choices?: unknown })?.choices;
      if (!Array.isArray(choices) || choices.length !== 1)
        throw new AiTransportError("invalid");
      choice = choices[0] as typeof choice;
      if (choice?.finish_reason === "length" && attempt === 0) continue;
      break;
    }
    if (!choice || !choice.message || typeof choice.message !== "object")
      throw new AiTransportError("invalid");
    const message = choice.message;
    if (
      choice.finish_reason !== undefined &&
      choice.finish_reason !== "stop" &&
      choice.finish_reason !== "tool_calls"
    )
      throw new AiTransportError(
        "invalid",
        choice.finish_reason === "length" ? "finish_length" : "finish_other"
      );
    if (message.content != null && typeof message.content !== "string")
      throw new AiTransportError("invalid");
    if (typeof message.content === "string" && message.content.length > 8000)
      throw new AiTransportError("invalid");
    const calls: AiFunctionCall[] = [];
    if (message.tool_calls !== undefined) {
      if (
        !Array.isArray(message.tool_calls) ||
        message.tool_calls.length > AI_DEFAULTS.maxToolCalls
      )
        throw new AiTransportError("invalid");
      for (const call of message.tool_calls) {
        if (
          call?.type !== "function" ||
          typeof call.id !== "string" ||
          typeof call.function?.name !== "string" ||
          typeof call.function?.arguments !== "string"
        )
          throw new AiTransportError("invalid");
        calls.push({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        });
      }
      validateCalls(calls, AI_DEFAULTS.maxToolCalls);
    }
    if (choice.finish_reason === "tool_calls" && !calls.length)
      throw new AiTransportError("invalid");
    const content: string =
      typeof message.content === "string" ? message.content : "";
    if (!calls.length && !content.trim()) throw new AiTransportError("invalid");
    return { content, calls };
  };
}
