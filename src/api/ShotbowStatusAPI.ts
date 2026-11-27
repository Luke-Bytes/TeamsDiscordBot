import { readJSON, record, requestFailure, retryDelay } from "./StatusHttp";

export const SHOTBOW_ADDRESS = "play.shotbow.net";

const GAME_MODES = {
  minez: "MineZ",
  smash: "SMASH",
  annihilation: "Annihilation",
  gg: "GG",
  slaughter: "Slaughter",
  ghostcraft: "Ghostcraft",
} as const;

export interface ShotbowPopulation {
  total: number;
  modes: {
    name: (typeof GAME_MODES)[keyof typeof GAME_MODES];
    players: number;
  }[];
}

type PingStatus =
  | { kind: "online"; online: number; max: number }
  | { kind: "offline" }
  | { kind: "unavailable" };

export type ShotbowStatus =
  | (PingStatus & { population?: ShotbowPopulation })
  | {
      kind: "reported-online";
      population: ShotbowPopulation;
      reachability: "offline" | "unavailable";
    };

const UNAVAILABLE: PingStatus = { kind: "unavailable" };
const CACHE_MS = 30_000;

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePopulation(payload: unknown): ShotbowPopulation | undefined {
  const root = record(payload);
  if (!root || !count(root.all)) return undefined;

  const modes: ShotbowPopulation["modes"] = [];
  for (const [key, name] of Object.entries(GAME_MODES)) {
    const players = root[key];
    if (count(players) && players > 0 && players <= root.all) {
      modes.push({ name, players });
    }
  }
  modes.sort((a, b) => b.players - a.players);
  return { total: root.all, modes };
}

function parseStatus(payload: unknown, httpStatus: number): PingStatus {
  const root = record(payload);
  if (httpStatus === 200 && root?.success === true) {
    const players = record(record(root.data)?.players);
    if (count(players?.online) && count(players?.max)) {
      return { kind: "online", online: players.online, max: players.max };
    }
  }

  // The documented error envelope is generic. Only an explicit statement
  // about the Minecraft server itself is evidence of an unsuccessful ping.
  // Never interpret authentication, gateway or other provider errors as offline.
  if (
    [200, 400, 404, 422].includes(httpStatus) &&
    root?.success === false &&
    typeof root.message === "string" &&
    /^(?:the )?(?:minecraft )?server is (?:offline|unreachable)[.!]?$/i.test(
      root.message.trim()
    )
  ) {
    return { kind: "offline" };
  }
  return UNAVAILABLE;
}

export class ShotbowStatusAPI {
  private pingCached?: { result: PingStatus; expires: number };
  private populationCached?: {
    result: ShotbowPopulation | undefined;
    expires: number;
  };
  private inFlight?: Promise<ShotbowStatus>;
  private blockedUntil = 0;
  private populationBlockedUntil = 0;

  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
    private readonly token: () => string | undefined = () =>
      process.env.CRAFTY_API_TOKEN,
    private readonly timeoutMs = 5_000,
    private readonly warn: (message: string) => void = (message) =>
      console.warn(message)
  ) {}

  getStatus(): Promise<ShotbowStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.requestStatus().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async requestStatus(): Promise<ShotbowStatus> {
    const [ping, population] = await Promise.all([
      this.getPing(),
      this.getPopulation(),
    ]);
    if (!population) return ping;
    // Positive official counts are evidence of network activity, not proof
    // that new connections to the public login address will succeed.
    if (ping.kind !== "online" && population.total > 0) {
      return {
        kind: "reported-online",
        population,
        reachability: ping.kind,
      };
    }
    if (ping.kind === "offline") return ping;
    return { ...ping, population };
  }

  private async getPing(): Promise<PingStatus> {
    const now = this.now();
    if (now < this.blockedUntil) return UNAVAILABLE;
    if (this.pingCached && now < this.pingCached.expires) {
      return this.pingCached.result;
    }
    const result = await this.request();
    this.pingCached = {
      result,
      expires:
        this.blockedUntil > now ? this.blockedUntil : this.now() + CACHE_MS,
    };
    return result;
  }

  private async getPopulation(): Promise<ShotbowPopulation | undefined> {
    const now = this.now();
    if (now < this.populationBlockedUntil) return undefined;
    if (this.populationCached && now < this.populationCached.expires) {
      return this.populationCached.result;
    }
    const result = await this.requestPopulation();
    this.populationCached = {
      result,
      expires:
        this.populationBlockedUntil > now
          ? this.populationBlockedUntil
          : this.now() + CACHE_MS,
    };
    return result;
  }

  private logFailure(
    source: "shotbow-population" | "crafty-ping",
    reason: string
  ): void {
    this.warn(`event=shotbow.check source=${source} ${reason}`);
  }

  private async requestPopulation(): Promise<ShotbowPopulation | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      const url = new URL("https://shotbow.net/serverList.json");
      url.searchParams.set("t", String(this.now()));
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (response.status === 429 || response.status === 503) {
        const now = this.now();
        this.populationBlockedUntil =
          now + retryDelay(response.headers.get("retry-after"), now, CACHE_MS);
      }
      if (!response.ok) {
        this.logFailure(
          "shotbow-population",
          `reason=http-error status=${response.status}`
        );
        return undefined;
      }
      const population = parsePopulation(await readJSON(response));
      if (!population) {
        this.logFailure("shotbow-population", "reason=invalid-response");
      }
      return population;
    } catch (error) {
      this.logFailure(
        "shotbow-population",
        requestFailure(error, controller.signal.aborted, !!response)
      );
      return undefined;
    } finally {
      clearTimeout(timeout);
      if (response?.body && !response.body.locked) {
        void response.body.cancel().catch(() => undefined);
      }
    }
  }

  private async request(): Promise<PingStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      const url = new URL("https://api.crafty.gg/api/v2/servers/ping");
      url.searchParams.set("ip", SHOTBOW_ADDRESS);
      url.searchParams.set("edition", "java");
      const token = this.token()?.trim();
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (response.status === 429 || response.status === 503) {
        this.blockedUntil =
          this.now() +
          retryDelay(response.headers.get("retry-after"), this.now(), CACHE_MS);
        this.logFailure(
          "crafty-ping",
          `reason=http-error status=${response.status}`
        );
        return UNAVAILABLE;
      }
      if (![200, 400, 404, 422].includes(response.status)) {
        this.logFailure(
          "crafty-ping",
          `reason=http-error status=${response.status}`
        );
        return UNAVAILABLE;
      }
      const ping = parseStatus(await readJSON(response), response.status);
      if (ping.kind !== "online") {
        const reason =
          ping.kind === "offline"
            ? "address-unreachable"
            : "unconfirmed-response";
        this.logFailure(
          "crafty-ping",
          `reason=${reason} status=${response.status}`
        );
      }
      return ping;
    } catch (error) {
      this.logFailure(
        "crafty-ping",
        requestFailure(error, controller.signal.aborted, !!response)
      );
      return UNAVAILABLE;
    } finally {
      clearTimeout(timeout);
      if (response?.body && !response.body.locked) {
        void response.body.cancel().catch(() => undefined);
      }
    }
  }
}
