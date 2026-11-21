import { lstatSync, readFileSync } from "fs";
import { join } from "path";
import { AiTransportError } from "./AiProvider";

export type AiProviderName = "groq" | "gemini" | "cloudflare";

const CREDENTIALS: Record<
  AiProviderName,
  { file: string; environment: readonly string[] }
> = {
  groq: { file: "ai-groq", environment: ["MC_AI_GROQ_KEY"] },
  gemini: { file: "ai-gemini", environment: ["MC_AI_GEMINI_KEY"] },
  cloudflare: {
    file: "ai-cloudflare",
    environment: ["MC_AI_CLOUDFLARE_KEY", "MC_AI_CLOUDFLARE_API_TOKEN"],
  },
};

function validSecret(secret: string | undefined): secret is string {
  return !!secret && secret.length >= 8 && secret.length <= 4096 && !/\s/.test(secret);
}

/** Resolve credentials lazily, only for an already-enabled /ask request. */
export function loadAiCredential(
  provider: AiProviderName,
  env: NodeJS.ProcessEnv = process.env
): string {
  const reference = CREDENTIALS[provider];
  if (env.CREDENTIALS_DIRECTORY) {
    const file = join(env.CREDENTIALS_DIRECTORY, reference.file);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096)
        throw new AiTransportError("unavailable");
      const value = readFileSync(file, "utf8").trim();
      if (!validSecret(value)) throw new AiTransportError("unavailable");
      return value;
    } catch (error) {
      // A missing per-provider systemd copy may use an explicitly injected env key.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new AiTransportError("unavailable");
    }
  }
  for (const name of reference.environment) {
    const value = env[name]?.trim();
    if (validSecret(value)) return value;
  }
  throw new AiTransportError("unavailable");
}
