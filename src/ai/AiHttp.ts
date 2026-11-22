import { AI_DEFAULTS } from "./AiConfig";
import { AiTransportError } from "./AiProvider";

export type AiHttpOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const RETRY_DELAYS_MS = [400, 800] as const;
const MAX_RETRY_AFTER_MS = 3_000;

/** Only repeat transient provider HTTP failures, never invalid/auth responses. */
function retryDelayMs(response: Response, attempt: number): number | null {
  if (
    attempt >= RETRY_DELAYS_MS.length ||
    ![429, 500, 502, 503, 504].includes(response.status)
  )
    return null;
  const fallback = RETRY_DELAYS_MS[attempt];
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return fallback;
  const seconds = Number(raw);
  const indicated =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1_000
      : Date.parse(raw) - Date.now();
  if (!Number.isFinite(indicated) || indicated < 0) return fallback;
  // Respect a long provider cooldown rather than hammering it early.
  if (indicated > MAX_RETRY_AFTER_MS) return null;
  return Math.max(fallback, Math.ceil(indicated));
}

/** The caller's abort and overall deadline also interrupt the backoff. */
function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AiTransportError("timeout"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiTransportError("timeout"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
  const deadline = Date.now() + timeoutMs;
  try {
    if (signal?.aborted) throw new AiTransportError("cancelled");
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (controller.signal.aborted)
        throw new AiTransportError(signal?.aborted ? "cancelled" : "timeout");
      const response = await (options.fetchImpl ?? fetch)(url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", ...headers },
        body,
      });
      const delay = retryDelayMs(response, attempt);
      if (!response.ok) {
        // Don't read or log provider error bodies, even when retrying.
        void response.body?.cancel().catch(() => undefined);
        if (delay !== null && delay + 100 < deadline - Date.now()) {
          await waitForRetry(delay, controller.signal);
          continue;
        }
        if (response.status === 429)
          throw new AiTransportError("busy", "http_429");
        if (response.status === 408)
          throw new AiTransportError("timeout", "http_408");
        throw new AiTransportError("unavailable", `http_${response.status}`);
      }
      if (!response.body) throw new AiTransportError("invalid");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted)
            throw new AiTransportError(
              signal?.aborted ? "cancelled" : "timeout"
            );
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
    }
    throw new AiTransportError("unavailable");
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
