import { AI_DEFAULTS, AiSettings } from "./AiConfig";
import { AiProviderName, loadAiCredential } from "./AiCredentials";
import { createCloudflareInference, validCloudflareAccountId } from "./CloudflareClient";
import { createGeminiInference } from "./GeminiClient";
import { createGroqInference } from "./GroqClient";
import { AiInference, AiTransportError } from "./AiProvider";

/** Selection happens once per accepted question, never after a live failure. */
export type AiProviderSelection =
  | { ok: true; provider: AiProviderName; model: string; infer: AiInference }
  | { ok: false; reason: "disabled" | "missing-credentials" | "cloudflare-account" };

export function selectAiProvider(options: {
  settings: AiSettings;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  credential?: (provider: AiProviderName) => string;
}): AiProviderSelection {
  if (!options.settings.enabled) return { ok: false, reason: "disabled" };
  const credential =
    options.credential ??
    ((provider: AiProviderName) => loadAiCredential(provider, options.env));
  let missingCloudflareAccount = false;
  for (const provider of AI_DEFAULTS.providerPriority) {
    let key: string;
    try {
      key = credential(provider);
    } catch (error) {
      if (error instanceof AiTransportError && error.kind === "unavailable")
        continue;
      // Do not expose credential-provider failure details.
      continue;
    }
    if (!key || key.length < 8 || key.length > 4096 || /\s/.test(key))
      continue;
    const model = AI_DEFAULTS.models[provider];
    const opts = { model, fetchImpl: options.fetchImpl, credential: () => key };
    if (provider === "groq")
      return { ok: true, provider, model, infer: createGroqInference(opts) };
    if (provider === "gemini")
      return { ok: true, provider, model, infer: createGeminiInference(opts) };
    if (!validCloudflareAccountId(options.settings.cloudflareAccountId)) {
      missingCloudflareAccount = true;
      continue;
    }
    return {
      ok: true,
      provider,
      model,
      infer: createCloudflareInference({
        ...opts,
        accountId: options.settings.cloudflareAccountId,
      }),
    };
  }
  return {
    ok: false,
    reason: missingCloudflareAccount ? "cloudflare-account" : "missing-credentials",
  };
}
