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

function parseStatus(payload: unknown): PingStatus {
  const root = record(payload);
  if (root?.online === true) {
    const players = record(root.players);
    if (count(players?.online) && count(players?.max)) {
      return { kind: "online", online: players.online, max: players.max };
    }
  }
  // Only a successful provider response explicitly reporting a failed ping
  // is evidence of address unreachability, not an HTTP error from the API.
  if (root?.online === false && root.eula_blocked === false) {
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
    source: "shotbow-population" | "mcstatus-ping",
    reason: string
  ): void {
    try {
      this.warn(`event=shotbow.check source=${source} ${reason}`);
    } catch {
      // Diagnostics must not invalidate an independent provider result.
    }
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
      const url = new URL(
        `https://api.mcstatus.io/v2/status/java/${SHOTBOW_ADDRESS}`
      );
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (response.status === 429 || response.status === 503) {
        this.blockedUntil =
          this.now() +
          retryDelay(response.headers.get("retry-after"), this.now(), CACHE_MS);
        this.logFailure(
          "mcstatus-ping",
          `reason=http-error status=${response.status}`
        );
        return UNAVAILABLE;
      }
      if (response.status !== 200) {
        this.logFailure(
          "mcstatus-ping",
          `reason=http-error status=${response.status}`
        );
        return UNAVAILABLE;
      }
      const ping = parseStatus(await readJSON(response));
      if (ping.kind !== "online") {
        const reason =
          ping.kind === "offline"
            ? "address-unreachable"
            : "unconfirmed-response";
        this.logFailure(
          "mcstatus-ping",
          `reason=${reason} status=${response.status}`
        );
      }
      return ping;
    } catch (error) {
      this.logFailure(
        "mcstatus-ping",
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
