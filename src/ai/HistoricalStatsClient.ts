import { isIP } from "node:net";

/**
 * REST_API read adapter. No model-controlled URLs, headers, queries or methods.
 * Responses are untrusted: every public field is projected after validation.
 */
export type HistoricalOutcome = {
  status: "not_found" | "unavailable";
  source: "REST_API historical stats";
  detail: string;
};
export type HistoricalResult = Record<string, unknown> & {
  source: "REST_API historical stats";
  status: string;
};
export type HistoricalClientOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRequests?: number;
};

const SOURCE = "REST_API historical stats" as const;
const MAX_BYTES = 128 * 1024;
const MAX_GAMES = 200;
const MAX_ELO_POINTS = 500;
const MAX_SEASONS = 200;

class HistoricalError extends Error {
  constructor(
    public readonly kind: "not_found" | "unavailable",
    public readonly detail: string
  ) {
    super(kind);
  }
}

export function validHistoricalIgn(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_]{3,16}$/.test(value);
}
export function validHistoricalSeason(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10000
  );
}
export function validHistoricalLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 2 &&
    value <= 20
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HistoricalError("unavailable", "malformed_response");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 10_000_000
  )
    throw new HistoricalError("unavailable", "malformed_response");
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new HistoricalError("unavailable", "malformed_response");
  return new Date(value).toISOString();
}
function seasonRecord(value: unknown) {
  const item = object(value);
  const number = item.number;
  if (!validHistoricalSeason(number))
    throw new HistoricalError("unavailable", "malformed_response");
  const type =
    item.type === "RANKED" || item.type === "RELAXED" ? item.type : "unknown";
  if (item.type != null && type === "unknown")
    throw new HistoricalError("unavailable", "malformed_response");
  if (typeof item.isActive !== "boolean")
    throw new HistoricalError("unavailable", "malformed_response");
  return { number, type, active: item.isActive };
}

function approvedOrigin(env: NodeJS.ProcessEnv): string | null {
  if (env.TEAMS_AI_HISTORICAL_ENABLED !== "true") return null;
  const configured = env.TEAMS_AI_REST_API_ORIGIN;
  const approved = env.TEAMS_AI_REST_API_APPROVED_ORIGIN;
  if (!configured || !approved || configured !== approved) return null;
  try {
    const url = new URL(configured);
    // Literal IPs remove DNS rebinding and cloud metadata host aliases.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (
      isIP(host) === 0 ||
      url.origin !== configured ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol)
    )
      return null;
    // Explicitly deny unspecified, link-local and multicast destinations.
    if (isIP(host) === 4) {
      const octets = host.split(".").map(Number);
      if (
        octets[0] === 0 ||
        octets[0] >= 224 ||
        (octets[0] === 169 && octets[1] === 254)
      )
        return null;
    } else {
      if (
        host === "::" ||
        host.toLowerCase().startsWith("fe80:") ||
        host.toLowerCase().startsWith("ff") ||
        host.toLowerCase().startsWith("::ffff:") ||
        host.includes(".")
      )
        return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json")
  )
    throw new HistoricalError("unavailable", "malformed_response");
  const advertised = Number(response.headers.get("content-length"));
  if (advertised > MAX_BYTES)
    throw new HistoricalError("unavailable", "response_too_large");
  if (!response.body)
    throw new HistoricalError("unavailable", "malformed_response");
  const reader = response.body.getReader();
  const pieces: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES)
        throw new HistoricalError("unavailable", "response_too_large");
      pieces.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    combined.set(piece, offset);
    offset += piece.length;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(combined)
    );
  } catch {
    throw new HistoricalError("unavailable", "malformed_response");
  }
}

export class HistoricalStatsClient {
  private readonly origin: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRequests: number;
  private requests = 0;

  get enabled(): boolean {
    return this.origin !== null;
  }

  constructor(options: HistoricalClientOptions = {}) {
    this.origin = approvedOrigin(options.env ?? process.env);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 1500, 100), 2500);
    this.maxRequests = Math.min(Math.max(options.maxRequests ?? 6, 1), 6);
  }

  private async get(path: string): Promise<unknown> {
    if (!this.origin)
      throw new HistoricalError("unavailable", "not_configured");
    if (++this.requests > this.maxRequests)
      throw new HistoricalError("unavailable", "request_budget_exceeded");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // path is constructed only from fixed templates and validated inputs.
      const response = await this.fetchImpl(this.origin + path, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw new HistoricalError("unavailable", "redirect_rejected");
      if (response.status === 404)
        throw new HistoricalError("not_found", "not_found");
      if (!response.ok)
        throw new HistoricalError("unavailable", "upstream_unavailable");
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof HistoricalError) throw error;
      throw new HistoricalError(
        "unavailable",
        controller.signal.aborted ? "timeout" : "connection_failed"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async outcome<T extends HistoricalResult>(
    read: () => Promise<T>
  ): Promise<T | HistoricalOutcome> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof HistoricalError)
        return { status: error.kind, detail: error.detail, source: SOURCE };
      return { status: "unavailable", detail: "unverified", source: SOURCE };
    }
  }

  playerStats(ign: string, season: number) {
    return this.outcome(async () => {
      if (!validHistoricalIgn(ign) || !validHistoricalSeason(season))
        throw new HistoricalError("unavailable", "invalid_input");
      const [seasonRaw, playerRaw] = await Promise.all([
        this.get(`/api/seasons/${season}`),
        this.get(`/api/player/${encodeURIComponent(ign)}?season=${season}`),
      ]);
      const metadata = seasonRecord(seasonRaw);
      if (metadata.number !== season)
        throw new HistoricalError("unavailable", "malformed_response");
      const player = object(playerRaw);
      if (
        !validHistoricalIgn(player.latestIGN) ||
        player.latestIGN.toLowerCase() !== ign.toLowerCase()
      )
        throw new HistoricalError("unavailable", "malformed_response");
      const wins = integer(player.wins);
      const losses = integer(player.losses);
      const winStreak = integer(player.winStreak);
      const loseStreak = integer(player.loseStreak);
      const biggestWinStreak = integer(player.biggestWinStreak);
      const biggestLosingStreak = integer(player.biggestLosingStreak);
      return {
        status: "ok",
        source: SOURCE,
        player: player.latestIGN,
        season,
        type: metadata.type,
        wins,
        losses,
        winStreak,
        loseStreak,
        biggestWinStreak,
        biggestLosingStreak,
        elo: metadata.type === "RANKED" ? integer(player.elo) : null,
        eloAvailability:
          metadata.type === "RANKED"
            ? "reported"
            : "not_applicable_or_unverified",
      };
    });
  }

  elo(ign: string, season: number, limit = 12) {
    return this.outcome(async () => {
      if (
        !validHistoricalIgn(ign) ||
        !validHistoricalSeason(season) ||
        !validHistoricalLimit(limit)
      )
        throw new HistoricalError("unavailable", "invalid_input");
      const metadata = seasonRecord(await this.get(`/api/seasons/${season}`));
      if (metadata.number !== season)
        throw new HistoricalError("unavailable", "malformed_response");
      if (metadata.type !== "RANKED")
        return {
          status: "unsupported",
          source: SOURCE,
          season,
          type: metadata.type,
          detail:
            "Elo progression is only reported for verified Ranked seasons",
        };
      const raw = await this.get(
        `/api/elohistory/${encodeURIComponent(ign)}?season=${season}`
      );
      if (
        !Array.isArray(raw) ||
        raw.length > MAX_ELO_POINTS ||
        raw.length === 0
      )
        throw new HistoricalError(
          "unavailable",
          raw instanceof Array && raw.length > MAX_ELO_POINTS
            ? "history_too_large"
            : "malformed_response"
        );
      const points = raw
        .map((value) => {
          const entry = object(value);
          return { at: timestamp(entry.createdAt), elo: integer(entry.elo) };
        })
        .sort((a, b) => a.at.localeCompare(b.at));
      const start = points[0].elo;
      const latest = points[points.length - 1].elo;
      return {
        status: "ok",
        source: SOURCE,
        player: ign,
        season,
        type: "RANKED",
        startingElo: start,
        latestElo: latest,
        highestObservedElo: Math.max(...points.map((p) => p.elo)),
        lowestObservedElo: Math.min(...points.map((p) => p.elo)),
        observedChange: latest - start,
        observationCount: points.length,
        points: points.slice(-limit),
        pointsScope: "latest chronological points",
        note: "Observations returned by REST_API; not necessarily the original season opening Elo",
      };
    });
  }

  seasonSummary(season: number) {
    return this.outcome(async () => {
      if (!validHistoricalSeason(season))
        throw new HistoricalError("unavailable", "invalid_input");
      const [seasonRaw, gamesRaw] = await Promise.all([
        this.get(`/api/seasons/${season}`),
        this.get(`/api/gameHistory?season=${season}`),
      ]);
      const metadata = seasonRecord(seasonRaw);
      if (metadata.number !== season)
        throw new HistoricalError("unavailable", "malformed_response");
      if (!Array.isArray(gamesRaw) || gamesRaw.length > MAX_GAMES)
        throw new HistoricalError(
          "unavailable",
          "history_too_large_or_malformed"
        );
      let completedMatches = 0;
      const dates: string[] = [];
      for (const raw of gamesRaw) {
        const game = object(raw);
        if (typeof game.finished !== "boolean")
          throw new HistoricalError("unavailable", "malformed_response");
        if (!game.finished) continue;
        completedMatches++;
        if (game.startTime != null) dates.push(timestamp(game.startTime));
        if (game.endTime != null) dates.push(timestamp(game.endTime));
      }
      dates.sort();
      return {
        status: "ok",
        source: SOURCE,
        season,
        type: metadata.type,
        active: metadata.active,
        completedMatches,
        observedDateRange: dates.length
          ? { first: dates[0], last: dates[dates.length - 1] }
          : null,
        dateRangeScope: dates.length
          ? "timestamps of returned completed games"
          : "unavailable",
        inspectedGameRecords: gamesRaw.length,
      };
    });
  }

  listSeasons() {
    return this.outcome(async () => {
      const raw = await this.get("/api/seasons");
      if (!Array.isArray(raw) || raw.length > MAX_SEASONS)
        throw new HistoricalError(
          "unavailable",
          "seasons_too_large_or_malformed"
        );
      const seasons = raw.map(seasonRecord).sort((a, b) => a.number - b.number);
      if (
        new Set(seasons.map((season) => season.number)).size !== seasons.length
      )
        throw new HistoricalError("unavailable", "malformed_response");
      return {
        status: "ok",
        source: SOURCE,
        seasons: seasons.slice(-20),
        totalAvailable: seasons.length,
        truncated: seasons.length > 20,
      };
    });
  }

  compare(ign: string, firstSeason: number, secondSeason: number) {
    return this.outcome(async () => {
      if (
        !validHistoricalIgn(ign) ||
        !validHistoricalSeason(firstSeason) ||
        !validHistoricalSeason(secondSeason) ||
        firstSeason === secondSeason
      )
        throw new HistoricalError("unavailable", "invalid_input");
      const [first, second] = await Promise.all([
        this.playerStats(ign, firstSeason),
        this.playerStats(ign, secondSeason),
      ]);
      if (first.status !== "ok" || second.status !== "ok")
        return {
          status: "unavailable",
          source: SOURCE,
          detail: "one_or_both_seasons_unavailable",
          firstStatus: first.status,
          secondStatus: second.status,
        };
      const a = first as HistoricalResult;
      const b = second as HistoricalResult;
      return {
        status: "ok",
        source: SOURCE,
        player: ign,
        first: a,
        second: b,
        winsDifference: (b.wins as number) - (a.wins as number),
        lossesDifference: (b.losses as number) - (a.losses as number),
        eloDifference:
          a.type === "RANKED" && b.type === "RANKED"
            ? (b.elo as number) - (a.elo as number)
            : null,
        note: "Elo difference compares recorded season values; not chronological Elo movement",
      };
    });
  }
}
