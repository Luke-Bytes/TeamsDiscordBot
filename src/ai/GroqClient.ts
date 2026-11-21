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
    const parsed = await requestAiJson(
      ENDPOINT,
      {
        model: options.model,
        messages: messages.map((message) => {
          if (message.role !== "assistant") return message;
          const { continuation, ...wire } = message;
          void continuation;
          return wire;
        }),
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? "auto" : undefined,
        parallel_tool_calls: false,
        temperature: AI_DEFAULTS.temperature,
        max_completion_tokens: AI_DEFAULTS.maxOutputTokens,
        stream: false,
      },
      { authorization: `Bearer ${key}` },
      options,
      signal
    );
    const choices = (parsed as { choices?: unknown })?.choices;
    if (!Array.isArray(choices) || choices.length !== 1)
      throw new AiTransportError("invalid");
    const choice = choices[0];
    const message = choice?.message;
    if (!message || typeof message !== "object")
      throw new AiTransportError("invalid");
    if (
      choice.finish_reason !== undefined &&
      choice.finish_reason !== "stop" &&
      choice.finish_reason !== "tool_calls"
    )
      throw new AiTransportError("invalid");
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
