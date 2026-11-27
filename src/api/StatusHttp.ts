const MAX_BYTES = 256 * 1024;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function readJSON(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    throw new Error("Response too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let content = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Response too large");
      content += decoder.decode(value, { stream: true });
    }
    return JSON.parse(content + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function retryDelay(
  header: string | null,
  now: number,
  cacheMs: number
): number {
  if (!header?.trim()) return cacheMs;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - now;
  return Number.isFinite(delay) ? Math.max(cacheMs, delay) : cacheMs;
}

export function requestFailure(
  error: unknown,
  timedOut: boolean,
  responseReceived: boolean
): string {
  if (timedOut) return "reason=timeout";
  if (responseReceived) return "reason=invalid-or-incomplete-body";
  // Only emit known codes, never provider bodies, URLs or raw errors.
  const code = record(record(error)?.cause)?.code ?? record(error)?.code;
  if (
    typeof code === "string" &&
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(code)
  ) {
    return `reason=request-failed code=${code}`;
  }
  return "reason=request-failed";
}
