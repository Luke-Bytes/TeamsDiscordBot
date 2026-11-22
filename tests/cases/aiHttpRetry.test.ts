import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { requestAiJson } from "../../src/ai/AiHttp";
import { AiTransportError } from "../../src/ai/AiProvider";

const url = "https://example.invalid/ai";
const payload = { message: "hello" };

test("AI retries a short 429 and transient server errors with unchanged request details", async () => {
  for (const statuses of [
    [429, 200],
    [503, 502, 200],
  ]) {
    const sent: Array<{ body: string; url: string; auth: string | undefined }> =
      [];
    const fetchImpl = (async (target: string, init: RequestInit) => {
      sent.push({
        body: String(init.body),
        url: target,
        auth: (init.headers as Record<string, string>).authorization,
      });
      const status = statuses[sent.length - 1];
      if (status === undefined) throw Error("Unbounded retry");
      return new Response(JSON.stringify({ status: "ok" }), { status });
    }) as typeof fetch;
    const result = (await requestAiJson(
      url,
      payload,
      { authorization: "Bearer offline" },
      { fetchImpl }
    )) as { status: string };
    assert(
      result.status === "ok" &&
        sent.length === statuses.length &&
        sent.every(
          (item) =>
            item.body === JSON.stringify(payload) &&
            item.url === url &&
            item.auth === "Bearer offline"
        ),
      "Only the selected provider is retried with the original request"
    );
  }
});

test("AI waits for a short provider Retry-After before retrying", async () => {
  let calls = 0;
  const began = Date.now();
  let retriedAt = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1)
      return new Response("{}", {
        status: 429,
        headers: { "Retry-After": "0.7" },
      });
    retriedAt = Date.now();
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  const reply = (await requestAiJson(url, payload, {}, { fetchImpl })) as {
    ok: boolean;
  };
  assert(
    reply.ok && calls === 2 && retriedAt - began >= 650,
    "A short Retry-After is observed before another HTTP request"
  );
});

test("AI does not retry non-transient errors or a long Retry-After", async () => {
  for (const [status, headers, kind, code] of [
    [401, {}, "unavailable", "http_401"],
    [400, {}, "unavailable", "http_400"],
    [429, { "Retry-After": "10" }, "busy", "http_429"],
  ] as Array<[number, Record<string, string>, string, string]>) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("{}", { status, headers });
    }) as typeof fetch;
    try {
      await requestAiJson(url, payload, {}, { fetchImpl });
      assert(false, "Expected a safe provider failure");
    } catch (error) {
      assert(
        error instanceof AiTransportError &&
          error.kind === kind &&
          error.code === code &&
          calls === 1,
        "Non-retryable error or long provider cooldown must fail immediately"
      );
    }
  }
});

test("AI retries only twice, then keeps the original 429 error classification", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("{}", { status: 429 });
  }) as typeof fetch;
  try {
    await requestAiJson(url, payload, {}, { fetchImpl });
    assert(false, "Permanent rate limit must fail after bounded retries");
  } catch (error) {
    assert(
      error instanceof AiTransportError &&
        error.kind === "busy" &&
        error.code === "http_429" &&
        calls === 3,
      "Two retries maximum; keep safe provider failure metadata"
    );
  }
});

test("AI cancellation interrupts the backoff without making another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    setTimeout(() => controller.abort(), 25);
    return new Response("{}", { status: 429 });
  }) as typeof fetch;
  try {
    await requestAiJson(url, payload, {}, { fetchImpl }, controller.signal);
    assert(false, "Cancelled backoff should not finish");
  } catch (error) {
    assert(
      error instanceof AiTransportError &&
        error.kind === "cancelled" &&
        calls === 1,
      "Cancellation stops delay and prevents repeat HTTP calls"
    );
  }
});

test("AI retries share one overall timeout rather than resetting it", async () => {
  let calls = 0;
  const fetchImpl = (async (_target: string, init: RequestInit) => {
    calls++;
    if (calls === 1) return new Response("{}", { status: 503 });
    return new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener(
        "abort",
        () => reject(Error("aborted")),
        { once: true }
      );
    });
  }) as typeof fetch;
  try {
    await requestAiJson(url, payload, {}, { fetchImpl, timeoutMs: 1000 });
    assert(false, "Shared deadline must abort a hanging retry");
  } catch (error) {
    assert(
      error instanceof AiTransportError &&
        error.kind === "timeout" &&
        calls === 2,
      "The timeout covers the initial call, backoff and subsequent request"
    );
  }
});
