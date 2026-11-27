import { randomBytes } from "node:crypto";
import { readJSON, record, requestFailure, retryDelay } from "./StatusHttp";

export type MonitorStatus = "operational" | "possible" | "definite" | "unknown";
export type ProbeStatus = "responding" | "error" | "unknown";

export interface MinecraftServicesStatus {
  session: MonitorStatus;
  xbox: MonitorStatus;
  minecraft: MonitorStatus;
  sessionProbe: ProbeStatus;
  keysProbe: ProbeStatus;
}

type Monitor = Pick<MinecraftServicesStatus, "session" | "xbox" | "minecraft">;
const UNKNOWN: Monitor = {
  session: "unknown",
  xbox: "unknown",
  minecraft: "unknown",
};
const CACHE_MS = 60_000;

function monitorStatus(value: unknown): MonitorStatus {
  switch (value) {
    case "Operational":
      return "operational";
    case "PossibleProblems":
      return "possible";
    case "DefiniteProblems":
      return "definite";
    default:
      return "unknown";
  }
}

interface Cache<T> {
  value?: T;
  expires: number;
}

export class MinecraftServicesAPI {
  private monitor: Cache<Monitor> = { expires: 0 };
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
    const [monitor, sessionProbe, keysProbe] = await Promise.all([
      this.request(
        this.monitor,
        "mcping-services",
        "https://mcping.me/api/services",
        UNKNOWN,
        async (response) => {
          if (response.status !== 200) return UNKNOWN;
          const root = record(await readJSON(response));
          const result: Monitor = {
            session: monitorStatus(root?.SessionServer),
            xbox: monitorStatus(root?.["Xbox services"]),
            minecraft: monitorStatus(root?.["Minecraft API"]),
          };
          if (Object.values(result).includes("unknown")) {
            this.log("mcping-services", "reason=missing-or-invalid-status");
          }
          return result;
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
            value.every(
              (entry: unknown) =>
                typeof record(entry)?.publicKey === "string" &&
                !!(record(entry)?.publicKey as string).trim()
            );
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
    return { ...monitor, sessionProbe, keysProbe };
  }

  private log(source: string, reason: string): void {
    this.warn(`event=shotbow.check source=${source} ${reason}`);
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
