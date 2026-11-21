import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { getAiSettings, AI_DEFAULTS } from "../../src/ai/AiConfig";
import { selectAiProvider } from "../../src/ai/AiProviderSelection";
import { AiTransportError, AiFunctionTool } from "../../src/ai/AiProvider";
import { createGeminiInference } from "../../src/ai/GeminiClient";
import { createCloudflareInference } from "../../src/ai/CloudflareClient";
import { loadAiCredential } from "../../src/ai/AiCredentials";
import { answerAiQuestion } from "../../src/ai/AiAssistant";

const settings = {
  enabled: true,
  channelIds: new Set(["123456789012345678"]),
  dailyRequestLimit: 50,
  cloudflareAccountId: "abcdef0123456789abcdef0123456789",
};

const sampleTool: AiFunctionTool = {
  type: "function",
  function: {
    name: "get_my_stats",
    description: "Read a caller-bound saved record",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

function fakeResponses(
  responses: { status?: number; value: unknown }[]
): { fetchImpl: typeof fetch; requests: Array<{ url: string; body: any; init: RequestInit }> } {
  const requests: Array<{ url: string; body: any; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)), init });
    const response = responses.shift();
    if (!response) throw Error("Unexpected repeat/provider HTTP call");
    return new Response(JSON.stringify(response.value), { status: response.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

test("AI credential selection is deterministic, lazy while off, and skips invalid credentials", () => {
  const disabled = getAiSettings({
    ai: { enabled: false },
    channels: { botCommands: "123456789012345678" } as any,
  });
  let reads = 0;
  assert(
    selectAiProvider({
      settings: disabled,
      credential: () => { reads++; throw Error("Should not read"); },
    }).ok === false && reads === 0,
    "Disabled /ask does not inspect credentials"
  );
  assert(AI_DEFAULTS.providerPriority.join(",") === "groq,gemini,cloudflare", "Priority is fixed");
  const all = selectAiProvider({
    settings,
    env: {
      MC_AI_GROQ_KEY: "groq-offline-test",
      MC_AI_GEMINI_KEY: "gemini-offline-test",
      MC_AI_CLOUDFLARE_KEY: "cf-offline-test",
    },
  });
  assert(all.ok && all.provider === "groq" && all.model === "openai/gpt-oss-20b",
    "Groq first when usable");
  const next = selectAiProvider({
    settings,
    env: { MC_AI_GROQ_KEY: "short", MC_AI_GEMINI_KEY: "gemini-offline-test",
      MC_AI_CLOUDFLARE_KEY: "cf-offline-test" },
  });
  assert(next.ok && next.provider === "gemini" && next.model === "gemini-2.5-flash",
    "Skip invalid Groq key and select Gemini");
  const last = selectAiProvider({
    settings,
    env: { MC_AI_CLOUDFLARE_KEY: "cf-offline-test" },
  });
  assert(last.ok && last.provider === "cloudflare" &&
    last.model === "@cf/qwen/qwen3-30b-a3b-fp8", "Cloudflare third");
  const none = selectAiProvider({ settings, env: {} });
  assert(!none.ok && none.reason === "missing-credentials", "No credential is a controlled configuration error");
  const accountMissing = selectAiProvider({
    settings: { ...settings, cloudflareAccountId: undefined },
    env: { MC_AI_CLOUDFLARE_KEY: "cf-offline-test" },
  });
  assert(!accountMissing.ok && accountMissing.reason === "cloudflare-account",
    "Cloudflare requires a real, valid account ID");
  const malformed = selectAiProvider({
    settings: { ...settings, cloudflareAccountId: "not-an-id" },
    env: { MC_AI_CLOUDFLARE_KEY: "cf-offline-test" },
  });
  assert(!malformed.ok && malformed.reason === "cloudflare-account",
    "Malformed Cloudflare account is rejected before HTTP");
  assert(
    loadAiCredential("cloudflare", { MC_AI_CLOUDFLARE_API_TOKEN: "cf-offline-alias" }) ===
      "cf-offline-alias",
    "Cloudflare env alias is compatible"
  );
});

test("Selected provider never retries another paid provider after a live failure", async () => {
  const mock = fakeResponses([{ status: 503, value: { error: "suppressed" } }]);
  const selected = selectAiProvider({
    settings,
    env: { MC_AI_GROQ_KEY: "groq-offline-test", MC_AI_GEMINI_KEY: "gemini-offline-test" },
    fetchImpl: mock.fetchImpl,
  });
  assert(selected.ok && selected.provider === "groq", "Primary chosen");
  if (!selected.ok) return;
  try {
    await selected.infer([{ role: "user", content: "hello" }], []);
    assert(false, "Must reject");
  } catch (error) {
    assert(error instanceof AiTransportError && error.kind === "unavailable",
      "Failure is safe and sanitized");
  }
  assert(mock.requests.length === 1 && mock.requests[0].url.includes("api.groq.com"),
    "Exactly one HTTP request; no cross-provider retry");
});

test("Gemini text and function calls preserve thinking signatures and group function responses", async () => {
  const mock = fakeResponses([
    {
      value: { candidates: [{
        finishReason: "STOP",
        content: { role: "model", parts: [
          { thought: true, text: "internal thought", thoughtSignature: "thought-part" },
          { functionCall: { id: "gemini-call-1", name: "get_my_stats", args: { season: 23 } },
            thoughtSignature: "opaque-signed-call" },
        ] },
      }] },
    },
    {
      value: { candidates: [{
        finishReason: "STOP",
        content: { role: "model", parts: [{ text: "You have 7 wins." }] },
      }] },
    },
  ]);
  const infer = createGeminiInference({
    model: "gemini-2.5-flash",
    credential: () => "offline-gemini-key",
    fetchImpl: mock.fetchImpl,
  });
  const messages: any[] = [
    { role: "system", content: "Trusted instruction" },
    { role: "user", content: "What are my wins?" },
  ];
  const first = await infer(messages, [sampleTool]);
  assert(first.content === "" && first.calls.length === 1 &&
    first.calls[0].function.arguments === '{"season":23}' &&
    first.continuation?.parts[1]?.thoughtSignature === "opaque-signed-call",
    "Function args parsed and opaque signature retained");
  messages.push({ role: "assistant", content: null, tool_calls: first.calls, continuation: first.continuation });
  messages.push({ role: "tool", tool_call_id: first.calls[0].id, content: '{"wins":7}' });
  const final = await infer(messages, []);
  assert(final.content === "You have 7 wins." && final.calls.length === 0,
    "Text response parsed");
  assert(
    mock.requests.length === 2 &&
    mock.requests[0].url.endsWith("gemini-2.5-flash:generateContent") &&
    mock.requests[0].body.tools[0].functionDeclarations[0].name === "get_my_stats" &&
    mock.requests[0].body.systemInstruction.parts[0].text === "Trusted instruction",
    "Fixed Gemini REST API with native function declarations");
  const history = mock.requests[1].body.contents;
  assert(
    history[1].role === "model" &&
    history[1].parts[1].thoughtSignature === "opaque-signed-call" &&
    history[2].role === "user" &&
    history[2].parts[0].functionResponse.name === "get_my_stats" &&
    history[2].parts[0].functionResponse.id === "gemini-call-1" &&
    history[2].parts[0].functionResponse.response.wins === 7,
    "Signed assistant part replayed verbatim with matched tool result");
  assert(mock.requests.every((r) => r.init.redirect === "error" && !!r.init.signal),
    "No redirects; all requests cancellable");
});

test("Gemini rejects malformed calls, non-STOP replies and unsigned continuation", async () => {
  for (const response of [
    { candidates: [{ finishReason: "MAX_TOKENS", content: { role: "model", parts: [{ text: "truncated" }] } }] },
    { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [
      { functionCall: { name: "not_offered", args: {} } },
    ] } }] },
    { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [
      { functionCall: { name: "get_my_stats", args: ["bad"] } },
    ] } }] },
  ]) {
    const mock = fakeResponses([{ value: response }]);
    try {
      await createGeminiInference({
        model: "gemini-2.5-flash", credential: () => "offline-gemini-key",
        fetchImpl: mock.fetchImpl,
      })([{ role: "user", content: "test" }], [sampleTool]);
      assert(false, "Malformed Gemini response rejected");
    } catch (error) {
      assert(error instanceof AiTransportError && error.kind === "invalid",
        "Malformed Gemini output safely rejected");
    }
  }
  const unsigned = fakeResponses([{ value: { candidates: [{
    finishReason: "STOP", content: { role: "model", parts: [
      { functionCall: { name: "get_my_stats", args: {} } },
    ] },
  }] } }]);
  try {
    await createGeminiInference({
      model: "gemini-3-flash-preview", credential: () => "offline-gemini-key",
      fetchImpl: unsigned.fetchImpl,
    })([{ role: "user", content: "stats" }], [sampleTool]);
    assert(false, "Gemini 3 unsigned tool call must be rejected");
  } catch (error) {
    assert(error instanceof AiTransportError && error.kind === "invalid",
      "Gemini 3 requires a thought signature");
  }
  const mock = fakeResponses([{ value: { candidates: [{
    finishReason: "STOP", content: { role: "model", parts: [
      { functionCall: { name: "get_my_stats", args: {} }, thoughtSignature: "signature" },
    ] },
  }] } }]);
  const infer = createGeminiInference({
    model: "gemini-3-flash-preview", credential: () => "offline-gemini-key",
    fetchImpl: mock.fetchImpl,
  });
  const first = await infer([{ role: "user", content: "stats" }], [sampleTool]);
  try {
    await infer([
      { role: "user", content: "stats" },
      { role: "assistant", content: null, tool_calls: first.calls },
      { role: "tool", tool_call_id: first.calls[0].id, content: "{}" },
    ], []);
    assert(false, "Cannot silently drop signed continuation");
  } catch (error) {
    assert(error instanceof AiTransportError && error.kind === "invalid" &&
      mock.requests.length === 1, "Unsigned replay rejected before network");
  }
});

test("Cloudflare Workers AI parses traditional and completion forms with real tool continuation", async () => {
  const mock = fakeResponses([
    { value: { success: true, result: {
      response: "",
      tool_calls: [{ name: "get_my_stats", arguments: { season: 23 } }],
    } } },
    { value: { success: true, result: { choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "Saved wins: 7" },
    }] } } },
  ]);
  const infer = createCloudflareInference({
    model: AI_DEFAULTS.models.cloudflare,
    accountId: settings.cloudflareAccountId,
    credential: () => "offline-cf-token",
    fetchImpl: mock.fetchImpl,
  });
  const messages: any[] = [{ role: "user", content: "my stats" }];
  const first = await infer(messages, [sampleTool]);
  assert(first.calls.length === 1 && first.calls[0].function.arguments === '{"season":23}',
    "Workers AI suggested a bounded function");
  messages.push({ role: "assistant", content: null, tool_calls: first.calls });
  messages.push({ role: "tool", tool_call_id: first.calls[0].id, content: '{"wins":7}' });
  const final = await infer(messages, [sampleTool]);
  assert(final.content === "Saved wins: 7" && final.calls.length === 0,
    "Completion-style output is supported");
  assert(
    mock.requests.length === 2 &&
    mock.requests[0].url ===
      "https://api.cloudflare.com/client/v4/accounts/abcdef0123456789abcdef0123456789/ai/run/@cf/qwen/qwen3-30b-a3b-fp8" &&
    mock.requests[0].body.tools[0].name === "get_my_stats" &&
    mock.requests[1].body.messages[2].role === "tool" &&
    JSON.parse(mock.requests[1].body.messages[2].content).result.wins === 7,
    "Fixed Workers AI URL, native tool schema, and tool-result continuation");
});

test("Provider adapters reject error status, malformed responses and pre-cancelled requests offline", async () => {
  for (const provider of ["gemini", "cloudflare"] as const) {
    for (const item of [
      { status: 429, value: {}, kind: "busy" },
      { status: 401, value: {}, kind: "unavailable" },
      { status: 200, value: { success: false }, kind: "invalid" },
    ]) {
      const mock = fakeResponses([{ status: item.status, value: item.value }]);
      const infer = provider === "gemini"
        ? createGeminiInference({ model: AI_DEFAULTS.models.gemini,
            credential: () => "offline-key", fetchImpl: mock.fetchImpl })
        : createCloudflareInference({ model: AI_DEFAULTS.models.cloudflare,
            accountId: settings.cloudflareAccountId,
            credential: () => "offline-key", fetchImpl: mock.fetchImpl });
      try {
        await infer([{ role: "user", content: "hi" }], []);
        assert(false, "Failure must not be accepted");
      } catch (error) {
        assert(error instanceof AiTransportError && error.kind === item.kind,
          `${provider}: expected ${item.kind}`);
      }
    }
    const cancelled = new AbortController();
    cancelled.abort();
    let requested = false;
    const infer = provider === "gemini"
      ? createGeminiInference({ model: AI_DEFAULTS.models.gemini,
          credential: () => { throw Error("Key must not load"); },
          fetchImpl: (async () => { requested = true; throw Error("network"); }) as typeof fetch })
      : createCloudflareInference({ model: AI_DEFAULTS.models.cloudflare,
          accountId: settings.cloudflareAccountId,
          credential: () => { throw Error("Key must not load"); },
          fetchImpl: (async () => { requested = true; throw Error("network"); }) as typeof fetch });
    try {
      await infer([{ role: "user", content: "hi" }], [], cancelled.signal);
      assert(false, "Pre-cancelled must fail");
    } catch (error) {
      assert(error instanceof AiTransportError && error.kind === "cancelled" && !requested,
        "No provider request or credential load on cancellation");
    }
  }
});

test("Gemini and Cloudflare enforce request deadlines with aborts", async () => {
  for (const provider of ["gemini", "cloudflare"] as const) {
    let aborted = false;
    const neverRespond = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => {
          aborted = true;
          reject(Error("aborted"));
        }, { once: true });
      })) as typeof fetch;
    const infer = provider === "gemini"
      ? createGeminiInference({
          model: AI_DEFAULTS.models.gemini,
          credential: () => "offline-key",
          timeoutMs: 1000,
          fetchImpl: neverRespond,
        })
      : createCloudflareInference({
          model: AI_DEFAULTS.models.cloudflare,
          accountId: settings.cloudflareAccountId,
          credential: () => "offline-key",
          timeoutMs: 1000,
          fetchImpl: neverRespond,
        });
    try {
      await infer([{ role: "user", content: "test" }], []);
      assert(false, "Provider must time out");
    } catch (error) {
      assert(aborted && error instanceof AiTransportError && error.kind === "timeout",
        `${provider}: bounded timeout`);
    }
  }
});

test("Navi authorisation and server tool allowlists are provider-agnostic", async () => {
  for (const provider of AI_DEFAULTS.providerPriority) {
    const result = await answerAiQuestion({
      question: "Give me organiser diagnostics",
      organiser: true, // untrusted caller hint
      caller: {
        guildId: "offline-guild",
        discordUserId: "offline-user",
        verifyMembership: async () => ({ member: true, organiser: false }),
      },
      knowledge: [{
        id: "player", source: "docs/ai/player-guide.md", heading: "Rules",
        startLine: 1, endLine: 2, hash: "abc", content: "Help content",
        scope: "player" as const,
      }],
      infer: async (_messages, offered) => {
        assert(!offered.some((tool) => tool.function.name === "get_organiser_status"),
          `${provider}: organiser tool withheld from players`);
        return {
          content: "",
          calls: [{
            id: "forged", type: "function" as const,
            function: { name: "get_organiser_status", arguments: "{}" },
          }],
        };
      },
    });
    assert(result.text.includes("not available to your role") && !result.toolNames.length,
      `${provider}: forged organiser call rejected without DB access`);
  }
});
