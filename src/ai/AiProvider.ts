/** Provider-neutral message contract. No adapter may execute a model-proposed tool. */
export type AiFunctionCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type AiFunctionTool = {
  type: "function";
  function: { name: string; description: string; parameters: object };
};

/** Opaque Gemini model parts must be replayed verbatim for signed tool turns. */
export type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
};

export type AiMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: AiFunctionCall[];
      continuation?: { provider: "gemini"; parts: GeminiPart[] };
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type AiTurn = {
  content: string;
  calls: AiFunctionCall[];
  continuation?: { provider: "gemini"; parts: GeminiPart[] };
};
export type AiInference = (
  messages: AiMessage[],
  tools: AiFunctionTool[],
  signal?: AbortSignal
) => Promise<AiTurn>;

export class AiTransportError extends Error {
  constructor(
    public readonly kind:
      | "unavailable"
      | "busy"
      | "timeout"
      | "invalid"
      | "cancelled"
  ) {
    super(kind);
  }
}

export function parseToolArguments(value: unknown): string {
  let obj: unknown = value;
  if (typeof value === "string") {
    if (value.length > 2000) throw new AiTransportError("invalid");
    try {
      obj = JSON.parse(value);
    } catch {
      throw new AiTransportError("invalid");
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw new AiTransportError("invalid");
  const result = JSON.stringify(obj);
  if (result.length > 2000) throw new AiTransportError("invalid");
  return result;
}

export function validateCalls(calls: AiFunctionCall[], maxCalls: number): void {
  if (calls.length > maxCalls) throw new AiTransportError("invalid");
  if (new Set(calls.map((call) => call.id)).size !== calls.length)
    throw new AiTransportError("invalid");
  for (const call of calls) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(call.id) ||
      !/^[a-zA-Z_][a-zA-Z0-9_]{0,100}$/.test(call.function.name) ||
      call.function.arguments.length > 2000
    )
      throw new AiTransportError("invalid");
    parseToolArguments(call.function.arguments);
  }
}
