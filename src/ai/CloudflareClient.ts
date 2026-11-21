import { AI_DEFAULTS } from "./AiConfig";
import { AiHttpOptions, requestAiJson } from "./AiHttp";
import {
  AiFunctionCall,
  AiInference,
  AiMessage,
  AiTransportError,
  parseToolArguments,
  validateCalls,
} from "./AiProvider";

const ENDPOINT = "https://api.cloudflare.com/client/v4/accounts/";
export function validCloudflareAccountId(id: string | undefined): id is string {
  return typeof id === "string" && /^[0-9a-fA-F]{32}$/.test(id);
}

/** Workers AI's traditional tool-call format, as in HiveOps' direct /ai/run adapter. */
function cloudflareHistory(messages: AiMessage[]): { role: string; content: string }[] {
  const pending = new Map<string, string>();
  return messages.map((message) => {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? [])
        pending.set(call.id, call.function.name);
      return {
        role: "assistant",
        content: [
          message.content ?? "",
          message.tool_calls?.length
            ? JSON.stringify(message.tool_calls.map((call) => ({
                name: call.function.name,
                arguments: JSON.parse(call.function.arguments),
              })))
            : "",
        ].filter(Boolean).join("\n"),
      };
    }
    if (message.role === "tool") {
      const name = pending.get(message.tool_call_id);
      if (!name) throw new AiTransportError("invalid");
      pending.delete(message.tool_call_id);
      let value: unknown;
      try {
        value = JSON.parse(message.content);
      } catch {
        value = { content: message.content };
      }
      return { role: "tool", content: JSON.stringify({ name, result: value }) };
    }
    return { role: message.role, content: message.content };
  });
}

function parseCloudflareReply(value: unknown, offered: Set<string>, turnIndex: number) {
  const envelope = value as {
    success?: unknown;
    result?: {
      response?: unknown;
      tool_calls?: unknown;
      choices?: Array<{
        finish_reason?: unknown;
        message?: { role?: unknown; content?: unknown; tool_calls?: unknown };
      }>;
    };
  };
  if (envelope?.success !== true || !envelope.result ||
    typeof envelope.result !== "object")
    throw new AiTransportError("invalid");
  const result = envelope.result;
  let content: unknown;
  let rawCalls: unknown;
  if (result.choices !== undefined) {
    if (!Array.isArray(result.choices) || result.choices.length !== 1)
      throw new AiTransportError("invalid");
    const choice = result.choices[0];
    if (
      (choice.finish_reason !== undefined &&
        choice.finish_reason !== null &&
        choice.finish_reason !== "stop" &&
        choice.finish_reason !== "tool_calls") ||
      choice.message?.role !== "assistant"
    ) throw new AiTransportError("invalid");
    content = choice.message.content ?? "";
    rawCalls = choice.message.tool_calls;
    if (choice.finish_reason === "tool_calls" && (!Array.isArray(rawCalls) || !rawCalls.length))
      throw new AiTransportError("invalid");
  } else {
    content = result.response;
    rawCalls = result.tool_calls;
  }
  if (typeof content === "object" && content !== null && !Array.isArray(content))
    content = JSON.stringify(content);
  if (typeof content !== "string" || content.length > 8000)
    throw new AiTransportError("invalid");
  const calls: AiFunctionCall[] = [];
  if (rawCalls !== undefined) {
    if (!Array.isArray(rawCalls) || rawCalls.length > AI_DEFAULTS.maxToolCalls)
      throw new AiTransportError("invalid");
    for (const raw of rawCalls) {
      const func = raw?.function ?? raw;
      if (
        !func ||
        typeof func.name !== "string" ||
        !offered.has(func.name) ||
        (raw?.type !== undefined && raw.type !== "function")
      ) throw new AiTransportError("invalid");
      const id =
        typeof raw.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(raw.id)
          ? raw.id
          : `cloudflare_${turnIndex}_${calls.length}`;
      calls.push({
        id,
        type: "function",
        function: {
          name: func.name,
          arguments: parseToolArguments(func.arguments),
        },
      });
    }
  }
  validateCalls(calls, AI_DEFAULTS.maxToolCalls);
  if (!calls.length && !content.trim()) throw new AiTransportError("invalid");
  return { content, calls };
}

export function createCloudflareInference(options: {
  model: string;
  accountId: string;
  credential: () => string;
} & AiHttpOptions): AiInference {
  if (!validCloudflareAccountId(options.accountId))
    throw new AiTransportError("unavailable");
  return async (messages, tools, signal) => {
    if (signal?.aborted) throw new AiTransportError("cancelled");
    const history = cloudflareHistory(messages);
    const token = options.credential();
    const response = await requestAiJson(
      `${ENDPOINT}${options.accountId}/ai/run/${options.model}`,
      {
        messages: history,
        stream: false,
        max_tokens: AI_DEFAULTS.maxOutputTokens,
        temperature: AI_DEFAULTS.temperature,
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters,
              })),
            }
          : {}),
      },
      { authorization: `Bearer ${token}` },
      options,
      signal
    );
    return parseCloudflareReply(
      response,
      new Set(tools.map((tool) => tool.function.name)),
      messages.length
    );
  };
}
