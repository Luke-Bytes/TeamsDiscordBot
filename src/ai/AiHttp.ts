import { AI_DEFAULTS } from "./AiConfig";
import { AiTransportError } from "./AiProvider";

export type AiHttpOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function requestAiJson(
  url: string,
  payload: object,
  headers: Record<string, string>,
  options: AiHttpOptions,
  signal?: AbortSignal
): Promise<unknown> {
  if (signal?.aborted) throw new AiTransportError("cancelled");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? AI_DEFAULTS.requestTimeoutMs, 1000),
    30_000
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (signal?.aborted) throw new AiTransportError("cancelled");
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    if (response.status === 429) throw new AiTransportError("busy");
    if (response.status === 408) throw new AiTransportError("timeout");
    if (!response.ok) throw new AiTransportError("unavailable");
    if (!response.body) throw new AiTransportError("invalid");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted)
          throw new AiTransportError(signal?.aborted ? "cancelled" : "timeout");
        if (done) break;
        size += value.byteLength;
        if (size > AI_DEFAULTS.maxResponseBytes)
          throw new AiTransportError("invalid");
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
    try {
      return JSON.parse(new TextDecoder().decode(combined)) as unknown;
    } catch {
      throw new AiTransportError("invalid");
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new AiTransportError(signal?.aborted ? "cancelled" : "timeout");
    if (error instanceof AiTransportError) throw error;
    throw new AiTransportError("unavailable");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
