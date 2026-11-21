import { AI_DEFAULTS } from "./AiConfig";
import { AiHttpOptions, requestAiJson } from "./AiHttp";
import {
  AiFunctionCall,
  AiInference,
  AiMessage,
  AiTransportError,
  GeminiPart,
  parseToolArguments,
  validateCalls,
} from "./AiProvider";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";

function geminiHistory(messages: AiMessage[]): {
  systemInstruction?: { parts: { text: string }[] };
  contents: { role: "user" | "model"; parts: object[] }[];
} {
  const system: string[] = [];
  const contents: { role: "user" | "model"; parts: object[] }[] = [];
  let pending: AiFunctionCall[] = [];
  let previousParts: GeminiPart[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (contents.length) throw new AiTransportError("invalid");
      system.push(message.content);
    } else if (message.role === "user") {
      if (pending.length) throw new AiTransportError("invalid");
      contents.push({ role: "user", parts: [{ text: message.content }] });
    } else if (message.role === "assistant") {
      if (pending.length) throw new AiTransportError("invalid");
      const calls = message.tool_calls ?? [];
      if (calls.length) {
        if (message.continuation?.provider !== "gemini")
          throw new AiTransportError("invalid"); // never synthesize unsigned tool history
        previousParts = message.continuation.parts;
        const functions = previousParts.filter((part) => part.functionCall);
        if (
          functions.length !== calls.length ||
          functions.some(
            (part, index) =>
              part.functionCall?.name !== calls[index].function.name ||
              JSON.stringify(part.functionCall?.args) !== calls[index].function.arguments
          )
        )
          throw new AiTransportError("invalid");
        contents.push({ role: "model", parts: previousParts });
        pending = [...calls];
      } else {
        contents.push({ role: "model", parts: [{ text: message.content ?? "" }] });
        previousParts = [];
      }
    } else if (message.role === "tool") {
      const next = pending.shift();
      if (!next || next.id !== message.tool_call_id)
        throw new AiTransportError("invalid");
      let result: unknown;
      try {
        result = JSON.parse(message.content);
      } catch {
        result = { content: message.content };
      }
      const response =
        result && typeof result === "object" && !Array.isArray(result)
          ? result
          : { result };
      const index = previousParts.filter((part) => part.functionCall).length - pending.length - 1;
      const originalId = previousParts.filter((part) => part.functionCall)[index]?.functionCall?.id;
      const part = {
        functionResponse: {
          name: next.function.name,
          ...(originalId ? { id: originalId } : {}),
          response,
        },
      };
      const previous = contents[contents.length - 1];
      if (
        previous?.role === "user" &&
        previous.parts.some((p) => "functionResponse" in p)
      )
        previous.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }
  if (!contents.length || pending.length) throw new AiTransportError("invalid");
  return {
    ...(system.length
      ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } }
      : {}),
    contents,
  };
}

function parseGeminiReply(
  value: unknown,
  offered: ReadonlySet<string>,
  turnIndex: number,
  model: string
) {
  const response = value as {
    promptFeedback?: { blockReason?: unknown };
    candidates?: Array<{
      finishReason?: unknown;
      content?: { role?: unknown; parts?: unknown };
    }>;
  };
  if (response?.promptFeedback?.blockReason || !Array.isArray(response?.candidates) ||
    response.candidates.length !== 1)
    throw new AiTransportError("invalid");
  const candidate = response.candidates[0];
  if (
    candidate?.finishReason !== "STOP" ||
    candidate.content?.role !== "model" ||
    !Array.isArray(candidate.content.parts) ||
    candidate.content.parts.length < 1 ||
    candidate.content.parts.length > 32
  ) throw new AiTransportError("invalid");
  const parts: GeminiPart[] = [];
  let content = "";
  const calls: AiFunctionCall[] = [];
  for (const raw of candidate.content.parts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AiTransportError("invalid");
    if (
      (raw.text !== undefined && typeof raw.text !== "string") ||
      (raw.thought !== undefined && typeof raw.thought !== "boolean") ||
      (raw.thoughtSignature !== undefined &&
        (typeof raw.thoughtSignature !== "string" || raw.thoughtSignature.length > 32768))
    ) throw new AiTransportError("invalid");
    const part: GeminiPart = {
      ...(raw.text !== undefined ? { text: raw.text } : {}),
      ...(raw.thought !== undefined ? { thought: raw.thought } : {}),
      ...(raw.thoughtSignature !== undefined ? { thoughtSignature: raw.thoughtSignature } : {}),
    };
    if (raw.functionCall !== undefined) {
      const func = raw.functionCall;
      if (
        !func ||
        typeof func.name !== "string" ||
        !offered.has(func.name) ||
        (func.id !== undefined && (typeof func.id !== "string" || func.id.length > 100))
      ) throw new AiTransportError("invalid");
      const args = parseToolArguments(func.args);
      const id = func.id && /^[a-zA-Z0-9_-]{1,100}$/.test(func.id)
        ? func.id : `gemini_${turnIndex}_${calls.length}`;
      part.functionCall = {
        ...(func.id ? { id: func.id } : {}),
        name: func.name,
        args: JSON.parse(args) as Record<string, unknown>,
      };
      calls.push({
        id, type: "function",
        function: { name: func.name, arguments: args },
      });
    }
    if (!raw.thought && typeof raw.text === "string") content += raw.text;
    parts.push(part);
  }
  validateCalls(calls, AI_DEFAULTS.maxToolCalls);
  // Gemini 3+ rejects tool-call continuation without a provider-origin signature.
  if (calls.length && /^gemini-[3-9](?:\.|-)/.test(model) &&
    !parts.some((part) => part.thoughtSignature))
    throw new AiTransportError("invalid");
  if (content.length > 8000 || (!content.trim() && !calls.length))
    throw new AiTransportError("invalid");
  return { content, calls, ...(calls.length ? { continuation: { provider: "gemini" as const, parts } } : {}) };
}

/** Gemini REST generateContent; preserve opaque model-origin signed parts within this /ask. */
export function createGeminiInference(options: {
  model: string;
  credential: () => string;
} & AiHttpOptions): AiInference {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(options.model))
    throw new AiTransportError("invalid");
  return async (messages, tools, signal) => {
    if (signal?.aborted) throw new AiTransportError("cancelled");
    const history = geminiHistory(messages);
    const key = options.credential();
    const response = await requestAiJson(
      `${ENDPOINT}${options.model}:generateContent`,
      {
        ...history,
        ...(tools.length
          ? {
              tools: [{
                functionDeclarations: tools.map((tool) => ({
                  name: tool.function.name,
                  description: tool.function.description,
                  parametersJsonSchema: tool.function.parameters,
                })),
              }],
              toolConfig: { functionCallingConfig: { mode: "AUTO" } },
            }
          : {}),
        generationConfig: {
          maxOutputTokens: AI_DEFAULTS.maxOutputTokens,
          temperature: AI_DEFAULTS.temperature,
        },
      },
      { "x-goog-api-key": key },
      options,
      signal
    );
    return parseGeminiReply(
      response,
      new Set(tools.map((tool) => tool.function.name)),
      messages.length,
      options.model
    );
  };
}
