import { readFileSync, lstatSync } from "fs";
import { join } from "path";

export type AiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: AiFunctionCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type AiFunctionCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type AiFunctionTool = {
  type: "function";
  function: { name: string; description: string; parameters: object };
};
export type AiTurn = { content: string; calls: AiFunctionCall[] };
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

/** A per-service systemd credential copy, or an injected PM2 environment reference. */
export function loadGroqCredential(
  env: NodeJS.ProcessEnv = process.env
): string {
  const directory = env.CREDENTIALS_DIRECTORY;
  if (directory) {
    const file = join(directory, "ai-groq");
    try {
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4096 ||
        stat.size < 1
      ) {
        throw new Error("invalid credential file");
      }
      const secret = readFileSync(file, "utf8").trim();
      if (secret.length < 8 || secret.length > 4096)
        throw new Error("invalid credential");
      return secret;
    } catch {
      throw new AiTransportError("unavailable");
    }
  }
  const secret = env.MC_AI_GROQ_KEY?.trim();
  if (!secret || secret.length < 8 || secret.length > 4096)
    throw new AiTransportError("unavailable");
  return secret;
}

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CALLS = 4;

async function boundedBody(response: Response): Promise<string> {
  if (!response.body) throw new AiTransportError("invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new AiTransportError("invalid");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export function createGroqInference(options: {
  model: string;
  fetchImpl?: typeof fetch;
  credential?: () => string;
  timeoutMs?: number;
}): AiInference {
  const fetchImpl = options.fetchImpl ?? fetch;
  const credential = options.credential ?? loadGroqCredential;
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? 20_000, 1000),
    30_000
  );
  return async (messages, tools, signal) => {
    if (signal?.aborted) throw new AiTransportError("cancelled");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const key = credential();
      const response = await fetchImpl(ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? "auto" : undefined,
          parallel_tool_calls: false,
          temperature: 0.1,
          max_completion_tokens: 500,
          stream: false,
        }),
      });
      if (response.status === 429) throw new AiTransportError("busy");
      if (response.status === 408 || response.status >= 500)
        throw new AiTransportError("unavailable");
      if (!response.ok) throw new AiTransportError("unavailable");
      const raw = await boundedBody(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AiTransportError("invalid");
      }
      const message = (parsed as { choices?: Array<{ message?: unknown }> })
        ?.choices?.[0]?.message;
      if (!message || typeof message !== "object")
        throw new AiTransportError("invalid");
      const candidate = message as { content?: unknown; tool_calls?: unknown };
      if (
        candidate.content !== null &&
        candidate.content !== undefined &&
        typeof candidate.content !== "string"
      ) {
        throw new AiTransportError("invalid");
      }
      if (
        typeof candidate.content === "string" &&
        candidate.content.length > 8000
      )
        throw new AiTransportError("invalid");
      const calls: AiFunctionCall[] = [];
      if (candidate.tool_calls !== undefined) {
        if (
          !Array.isArray(candidate.tool_calls) ||
          candidate.tool_calls.length > MAX_CALLS
        )
          throw new AiTransportError("invalid");
        for (const call of candidate.tool_calls) {
          if (
            typeof call?.id !== "string" ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(call.id) ||
            call.type !== "function" ||
            typeof call.function?.name !== "string" ||
            typeof call.function?.arguments !== "string" ||
            call.function.arguments.length > 2000
          ) {
            throw new AiTransportError("invalid");
          }
          calls.push({
            id: call.id,
            type: "function",
            function: {
              name: call.function.name,
              arguments: call.function.arguments,
            },
          });
        }
        if (new Set(calls.map((call) => call.id)).size !== calls.length)
          throw new AiTransportError("invalid");
      }
      if (
        calls.length === 0 &&
        !(typeof candidate.content === "string" && candidate.content.trim())
      ) {
        throw new AiTransportError("invalid");
      }
      return {
        content: typeof candidate.content === "string" ? candidate.content : "",
        calls,
      };
    } catch (error) {
      if (error instanceof AiTransportError) throw error;
      if (controller.signal.aborted)
        throw new AiTransportError(signal?.aborted ? "cancelled" : "timeout");
      throw new AiTransportError("unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
