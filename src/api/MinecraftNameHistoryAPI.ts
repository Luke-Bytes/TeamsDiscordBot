import { MojangAPI } from "./MojangAPI";
import { mergeNameHistory } from "./NameHistoryMerge";
import { HistoryAdapter, historyAdapters, parseHistory, providerResult, readHistoryJSON, retryAfterMs } from "./NameHistoryProviders";
import { HistoryProvider, NameHistoryResult, NameHistoryScope, ProviderHistory, ProviderStatus, normalizeHistoryUUID } from "./NameHistoryTypes";
import { DatabaseHistory, DatabaseNameHistory } from "../database/DatabaseNameHistory";

const PROVIDER_TIMEOUT = 4500;
const LOOKUP_BUDGET = 50_000;
const MAX_CACHE = 500;
const MAX_CONCURRENT = 8;
const FAILURE_TTL = 15_000;

function empty(status: NameHistoryResult["status"], uuid?: string): NameHistoryResult {
  return { status, uuid, names: [], providers: [], suppressed: false, partial: true };
}

function suppressed(uuid: string): boolean {
  return (process.env.MC_NAME_HISTORY_SUPPRESSED_UUIDS ?? "").split(/[\s,]+/).some((value) => normalizeHistoryUUID(value) === uuid);
}

function enabled(adapter: HistoryAdapter): boolean {
  return !/^(?:false|0|off)$/i.test(process.env[`MC_NAME_HISTORY_${adapter.id.toUpperCase()}_ENABLED`]?.trim() ?? "");
}

// Mojang has bounded, retried requests of its own. Leave a separate provider
// window and stop scheduling further work when the identity budget expires.
async function within<T>(promise: Promise<T>, deadline: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, deadline - Date.now())); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class MinecraftNameHistoryAPI {
  private static readonly cache = new Map<string, { until: number; result: ProviderHistory }>();
  private static readonly inFlight = new Map<string, { epoch: number; work: Promise<ProviderHistory[]> }>();
  private static readonly identities = new Map<string, Promise<string | null>>();
  private static readonly providerCooldown = new Map<HistoryProvider, number>();
  private static readonly requestTimes = new Map<HistoryProvider, number[]>();
  private static activeNameLookups = 0;
  private static activeDatabaseLookups = 0;
  private static epoch = 0;
  private static readonly withheldUUIDs = new Set<string>();
  private static privacyCapacityReached = false;

  private static isSuppressed(uuid: string): boolean {
    return suppressed(uuid) || this.withheldUUIDs.has(uuid) || this.privacyCapacityReached;
  }

  /** Clear affected history evidence; configure the UUID suppression list for durable opt-out. */
  static invalidate(uuid?: string): void {
    const normalized = uuid === undefined ? undefined : normalizeHistoryUUID(uuid);
    if (uuid !== undefined && !normalized) return;
    this.epoch++;
    for (const key of this.cache.keys()) {
      if (!normalized || key.endsWith(":" + normalized)) this.cache.delete(key);
    }
  }

  static async lookup(username: string, scope: NameHistoryScope = {}): Promise<NameHistoryResult> {
    const requestedUsername = username.trim();
    if (!MojangAPI.validateUsername(requestedUsername)) return { ...empty("invalid"), requestedUsername };
    if (this.activeNameLookups >= MAX_CONCURRENT) return { ...empty("unavailable"), requestedUsername };
    this.activeNameLookups++;
    const deadline = Date.now() + LOOKUP_BUDGET - PROVIDER_TIMEOUT;
    try {
      for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
        const identity = await within(MojangAPI.lookupUsername(requestedUsername, attempt > 0), deadline, { status: "unavailable" as const });
        if (identity.status !== "found") return { ...empty(identity.status), requestedUsername };
        const uuid = normalizeHistoryUUID(identity.uuid);
        if (!uuid) return { ...empty("unavailable"), requestedUsername };
        const current = await within(this.currentName(uuid), deadline, null);
        if (!current) return { ...empty("unavailable", uuid), requestedUsername };
        // A cached IGN can have been reassigned. Re-resolve once without the
        // cache, never ask history providers about the now-mismatching UUID.
        if (current.toLowerCase() !== requestedUsername.toLowerCase()) continue;
        return { ...await this.verifiedHistory(uuid, current, scope), requestedUsername };
      }
      return { ...empty("unavailable"), requestedUsername };
    } catch {
      return { ...empty("unavailable"), requestedUsername };
    } finally {
      this.activeNameLookups--;
    }
  }

  static async lookupByUUID(value: string, scope: NameHistoryScope = {}): Promise<NameHistoryResult> {
    const uuid = normalizeHistoryUUID(value.trim());
    if (!uuid) return empty("invalid");
    try {
      const current = await within(this.currentName(uuid), Date.now() + LOOKUP_BUDGET - PROVIDER_TIMEOUT, null);
      return current ? await this.verifiedHistory(uuid, current, scope) : empty("unavailable", uuid);
    } catch {
      return empty("unavailable", uuid);
    }
  }

  private static currentName(uuid: string): Promise<string | null> {
    const pending = this.identities.get(uuid);
    if (pending) return pending;
    if (this.identities.size >= MAX_CONCURRENT) return Promise.resolve(null);
    const lookup = Promise.resolve().then(() => MojangAPI.uuidToUsername(uuid, true))
      .then((name) => name && MojangAPI.validateUsername(name) ? name : null)
      .catch(() => null)
      .finally(() => this.identities.delete(uuid));
    this.identities.set(uuid, lookup);
    return lookup;
  }

  private static async databaseHistory(uuid: string, scope: NameHistoryScope): Promise<DatabaseHistory> {
    const fallback = (status: ProviderStatus): DatabaseHistory => ({
      history: providerResult("database", status), playerRecords: [],
    });
    if (this.activeDatabaseLookups >= MAX_CONCURRENT) return fallback("rateLimited");
    this.activeDatabaseLookups++;
    // A timed-out database operation may still be running. Keep its slot
    // occupied until it settles, and never cache local records.
    const work = Promise.resolve().then(() => DatabaseNameHistory.lookup(uuid, scope))
      .catch(() => fallback("unavailable")).finally(() => this.activeDatabaseLookups--);
    return within(work, Date.now() + PROVIDER_TIMEOUT, fallback("timeout"));
  }

  private static async verifiedHistory(uuid: string, currentUsername: string, scope: NameHistoryScope): Promise<NameHistoryResult> {
    const verifiedAt = new Date().toISOString();
    const epoch = this.epoch;
    const [external, local] = this.isSuppressed(uuid)
      ? [historyAdapters.map((a) => providerResult(a.id, "withheld")), { history: providerResult("database", "withheld"), playerRecords: [] }]
      : await Promise.all([this.histories(uuid), this.databaseHistory(uuid, scope)]);
    const results = [...external, local.history];
    // An invalidation during a request may represent a removal request. Do
    // not publish evidence obtained before it. A fresh lookup can try again.
    const explicit = results.some((r) => r.status === "withheld");
    const hidden = this.isSuppressed(uuid) || this.epoch !== epoch || explicit;
    if (explicit && !this.isSuppressed(uuid)) {
      if (this.withheldUUIDs.size < MAX_CACHE) this.withheldUUIDs.add(uuid);
      else this.privacyCapacityReached = true;
      this.invalidate(uuid);
    }
    if (suppressed(uuid)) {
      for (const key of this.cache.keys()) if (key.endsWith(":" + uuid)) this.cache.delete(key);
    }
    const responding = (r: ProviderHistory) => r.status === "success" || r.status === "noHistory";
    const names = mergeNameHistory(currentUsername, results, hidden);
    const localPlayerNames = !hidden && scope.includePlayerRecords
      ? mergeNameHistory(currentUsername, [{ ...local.history, observations: local.playerRecords }])
          .filter((n) => !n.current && !names.some((known) => known.normalizedName === n.normalizedName))
      : [];
    return {
      status: "found", uuid, currentUsername, verifiedAt,
      names, localPlayerNames,
      providers: results.map(({ observations, ...summary }) => ({
        ...summary, observationCount: hidden ? 0 : observations.length,
      })),
      suppressed: hidden,
      partial: hidden || results.some((r) => !responding(r) || r.limited),
    };
  }

  private static histories(uuid: string): Promise<ProviderHistory[]> {
    const pending = this.inFlight.get(uuid);
    if (pending) return pending.epoch === this.epoch ? pending.work : Promise.resolve(historyAdapters.map((a) => providerResult(a.id, "unavailable", "History invalidated during lookup.")));
    if (this.inFlight.size >= MAX_CONCURRENT) return Promise.resolve(historyAdapters.map((a) => providerResult(a.id, "rateLimited", "Local lookup capacity reached.")));
    const work = Promise.allSettled(historyAdapters.map((adapter) => this.query(adapter, uuid)))
      .then((results) => results.map((result, i) => result.status === "fulfilled" ? result.value : providerResult(historyAdapters[i].id, "unavailable")))
      .finally(() => this.inFlight.delete(uuid));
    this.inFlight.set(uuid, { epoch: this.epoch, work });
    return work;
  }

  private static remember(key: string, result: ProviderHistory, ttl: number, epoch: number): void {
    if (ttl <= 0 || epoch !== this.epoch) return;
    this.cache.delete(key);
    while (this.cache.size >= MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { until: Date.now() + ttl, result: structuredClone(result) });
  }

  private static async query(adapter: HistoryAdapter, uuid: string): Promise<ProviderHistory> {
    const id = adapter.id;
    if (!enabled(adapter)) return providerResult(id, "disabled");
    const token = adapter.credential ? process.env[adapter.credential]?.trim() : undefined;
    if (adapter.credential && !token) return providerResult(id, "notConfigured");
    if (this.isSuppressed(uuid)) return providerResult(id, "withheld");
    const key = id + ":" + uuid;
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && cached.until > now) return { ...structuredClone(cached.result), cached: true };
    this.cache.delete(key);
    if ((this.providerCooldown.get(id) ?? 0) > now) return providerResult(id, "rateLimited", "Provider cooldown active.");
    const times = (this.requestTimes.get(id) ?? []).filter((t) => t > now - 30_000);
    if (times.length >= adapter.requestsPer30s) return providerResult(id, "rateLimited", "Local provider limit reached.");
    times.push(now);
    this.requestTimes.set(id, times);

    const epoch = this.epoch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT);
    let result: ProviderHistory;
    let ttl = FAILURE_TTL;
    try {
      const response = await fetch(adapter.url(uuid), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(token ? (id === "bisai" ? { "X-API-Key": token } : { Authorization: `Bearer ${token}` }) : {}),
          "User-Agent": "TeamsDiscordBot (Minecraft name history)",
        },
      });
      if (id === "bisai" && response.headers.get("x-credits-remaining") === "0") {
        const reset = Number(response.headers.get("x-credits-reset")) * 1000;
        if (Number.isFinite(reset) && reset > Date.now()) this.providerCooldown.set(id, reset);
      }
      if (!response.ok) {
        const status: ProviderStatus =
          response.status === 429 ? "rateLimited" :
          response.status === 401 || response.status === 403 ? "authenticationRequired" :
          response.status === 404 ? "notFound" :
          response.status === 451 ? "withheld" :
          "unavailable";
        if (status === "rateLimited") {
          this.providerCooldown.set(id, Math.max(this.providerCooldown.get(id) ?? 0, Date.now() + retryAfterMs(response.headers.get("retry-after"))));
          // Global cooldown already prevents upstream calls.
          ttl = 0;
        }
        result = providerResult(id, status, `HTTP ${response.status}`);
        await response.body?.cancel().catch(() => undefined);
      } else {
        try {
          result = parseHistory(id, uuid, await readHistoryJSON(response));
          if (result.status === "success" || result.status === "noHistory") {
            ttl = adapter.ttlMs;
            const cacheControl = response.headers.get("cache-control") ?? "";
            if (/\b(?:no-store|no-cache|private)\b/i.test(cacheControl)) ttl = 0;
            const maxAge = /\bmax-age=(\d+)/i.exec(cacheControl);
            if (maxAge) ttl = Math.min(ttl, Number(maxAge[1]) * 1000);
          }
        } catch {
          result = providerResult(id, controller.signal.aborted ? "timeout" : "invalidResponse");
        }
      }
    } catch {
      result = providerResult(id, controller.signal.aborted ? "timeout" : "unavailable");
    } finally {
      clearTimeout(timer);
    }
    result.fetchedAt = new Date().toISOString();
    if (!this.isSuppressed(uuid)) this.remember(key, result, ttl, epoch);
    return result;
  }
}
