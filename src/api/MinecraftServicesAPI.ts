import { createPublicKey, randomBytes } from "node:crypto";
import { readJSON, record, requestFailure, retryDelay } from "./StatusHttp";

export type ProbeStatus = "responding" | "error" | "unknown";

export interface MinecraftServicesStatus {
  sessionProbe: ProbeStatus;
  keysProbe: ProbeStatus;
  microsoftProbe: ProbeStatus;
}

const CACHE_MS = 60_000;

interface Cache<T> {
  value?: T;
  expires: number;
}

export class MinecraftServicesAPI {
  private microsoft: Cache<ProbeStatus> = { expires: 0 };
  private session: Cache<ProbeStatus> = { expires: 0 };
  private keys: Cache<ProbeStatus> = { expires: 0 };
  private inFlight?: Promise<MinecraftServicesStatus>;

  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 5_000,
    private readonly warn: (message: string) => void = (message) =>
      console.warn(message)
  ) {}

  getStatus(): Promise<MinecraftServicesStatus> {
    if (!this.inFlight) {
      this.inFlight = this.check().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async check(): Promise<MinecraftServicesStatus> {
    const sessionUrl = new URL(
      "https://sessionserver.mojang.com/session/minecraft/hasJoined"
    );
    // A deliberately unjoined synthetic session. No actual account or token.
    sessionUrl.searchParams.set("username", "FWStatusProbe");
    sessionUrl.searchParams.set("serverId", randomBytes(20).toString("hex"));
    const [microsoftProbe, sessionProbe, keysProbe] = await Promise.all([
      this.request(
        this.microsoft,
        "microsoft-login",
        "https://login.live.com/.well-known/openid-configuration",
        "unknown",
        async (response): Promise<ProbeStatus> => {
          if (response.status !== 200) {
            return this.probeFailure("microsoft-login", response);
          }
          const root = record(await readJSON(response));
          if (
            root?.issuer === "https://login.live.com" &&
            root.authorization_endpoint ===
              "https://login.live.com/oauth20_authorize.srf" &&
            root.token_endpoint === "https://login.live.com/oauth20_token.srf"
          ) {
            return "responding";
          }
          this.log("microsoft-login", "reason=invalid-response");
          return "unknown";
        }
      ),
      this.request(
        this.session,
        "mojang-session",
        sessionUrl,
        "unknown",
        async (response): Promise<ProbeStatus> => {
          // 204 is expected: this synthetic session was never registered.
          if (response.status === 204) return "responding";
          return this.probeFailure("mojang-session", response);
        }
      ),
      this.request(
        this.keys,
        "minecraft-publickeys",
        "https://api.minecraftservices.com/publickeys",
        "unknown",
        async (response): Promise<ProbeStatus> => {
          if (response.status !== 200) {
            return this.probeFailure("minecraft-publickeys", response);
          }
          const root = record(await readJSON(response));
          const validKeys = (value: unknown) =>
            Array.isArray(value) &&
            value.length > 0 &&
            value.every((entry: unknown) => {
              const key = record(entry)?.publicKey;
              if (typeof key !== "string" || !key.trim()) return false;
              try {
                // Minecraft publishes base64-encoded DER SubjectPublicKeyInfo.
                if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return false;
                const der = Buffer.from(key, "base64");
                if (der.toString("base64").replace(/=+$/, "") !== key.replace(/=+$/, "")) return false;
                createPublicKey({ key: der, format: "der", type: "spki" });
                return true;
              } catch {
                return false;
              }
            });
          if (
            validKeys(root?.profilePropertyKeys) &&
            validKeys(root?.playerCertificateKeys)
          ) {
            return "responding";
          }
          this.log("minecraft-publickeys", "reason=invalid-response");
          return "unknown";
        }
      ),
    ]);
    return { microsoftProbe, sessionProbe, keysProbe };
  }

  private log(source: string, reason: string): void {
    try {
      this.warn(`event=shotbow.check source=${source} ${reason}`);
    } catch {
      // Diagnostics must not invalidate an independent endpoint result.
    }
  }

  private probeFailure(source: string, response: Response): ProbeStatus {
    if (response.ok) {
      this.log(source, `reason=unexpected-status status=${response.status}`);
    }
    // 5xx is evidence of an endpoint error, not a global login outage.
    return response.status >= 500 ? "error" : "unknown";
  }

  private async request<T>(
    cache: Cache<T>,
    source: string,
    url: string | URL,
    fallback: T,
    parse: (response: Response) => Promise<T>
  ): Promise<T> {
    if (cache.value !== undefined && this.now() < cache.expires) {
      return cache.value;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response | undefined;
    let value = fallback;
    let backoff = 0;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        this.log(source, `reason=http-error status=${response.status}`);
      }
      if (response.status === 429 || response.status === 503) {
        backoff = retryDelay(
          response.headers.get("retry-after"),
          this.now(),
          CACHE_MS
        );
      }
      value = await parse(response);
    } catch (error) {
      this.log(
        source,
        requestFailure(error, controller.signal.aborted, !!response)
      );
    } finally {
      clearTimeout(timeout);
      if (response?.body && !response.body.locked) {
        void response.body.cancel().catch(() => undefined);
      }
    }
    cache.value = value;
    cache.expires = this.now() + Math.max(CACHE_MS, backoff);
    return value;
  }
}
