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

export type ShotbowStatus = PingStatus & { population?: ShotbowPopulation };

const UNAVAILABLE: ShotbowStatus = { kind: "unavailable" };
const CACHE_MS = 30_000;
const MAX_BYTES = 256 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

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

async function readJSON(response: Response): Promise<unknown> {
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

function retryDelay(header: string | null, now: number): number {
  if (!header?.trim()) return CACHE_MS;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - now;
  return Number.isFinite(delay) ? Math.max(CACHE_MS, delay) : CACHE_MS;
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
    private readonly timeoutMs = 5_000
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
    // A populated network and a failed address ping are conflicting signals.
    // Do not claim the entire network is offline in that case.
    if (ping.kind === "offline") {
      return population.total > 0 ? { ...UNAVAILABLE, population } : ping;
    }
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
          now + retryDelay(response.headers.get("retry-after"), now);
      }
      if (!response.ok) return undefined;
      return parsePopulation(await readJSON(response));
    } catch {
      // The optional breakdown must not prevent the normal ping result.
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
          retryDelay(response.headers.get("retry-after"), this.now());
        return UNAVAILABLE;
      }
      if (![200, 400, 404, 422].includes(response.status)) return UNAVAILABLE;
      return parseStatus(await readJSON(response), response.status);
    } catch {
      // Provider failures (including aborts and invalid JSON) are not outages
      // of the Minecraft server. Do not log provider content or credentials.
      return UNAVAILABLE;
    } finally {
      clearTimeout(timeout);
      if (response?.body && !response.body.locked) {
        void response.body.cancel().catch(() => undefined);
      }
    }
  }
}
