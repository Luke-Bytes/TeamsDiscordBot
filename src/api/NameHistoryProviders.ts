import { MojangAPI } from "./MojangAPI";
import {
  ExternalHistoryProvider, HistoryProvider, NameObservation, ProviderHistory, ProviderStatus,
  historyDate, normalizeHistoryUUID, unknownDate,
} from "./NameHistoryTypes";

export interface HistoryAdapter {
  id: ExternalHistoryProvider;
  url: (uuid: string) => string;
  credential?: string;
  ttlMs: number;
  requestsPer30s: number;
}

export const historyAdapters: readonly HistoryAdapter[] = [
  { id: "laby", url: (uuid) => `https://laby.net/api/v3/user/${uuid}/names`, credential: "LABY_API_TOKEN", ttlMs: 0, requestsPer30s: 10 },
  { id: "winstreak", url: (uuid) => `https://api.winstreak.ws/v1/player/namehistory?player=${uuid}`, credential: "WINSTREAK_API_KEY", ttlMs: 600_000, requestsPer30s: 30 },
  { id: "mcprofiles", url: (uuid) => `https://mcprofiles.me/api/player/${uuid}`, ttlMs: 120_000, requestsPer30s: 10 },
  // Shared-IP bot traffic uses a key conservatively; the public sample alone
  // does not establish the reset window or a separate shared-backend quota.
  { id: "bisai", url: (uuid) => `https://mc-api.bisai.dev/v1/profile/${uuid}/names?limit=500`, credential: "BISAI_API_KEY", ttlMs: 600_000, requestsPer30s: 10 },
];

export function providerResult(provider: HistoryProvider, status: ProviderStatus, reason?: string): ProviderHistory {
  return { provider, status, reason, fetchedAt: null, cached: false, archived: false, observations: [], limited: false };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Defensive handling of explicit redaction markers, not a claim that every
// provider returns such flags. Never try to recover a redacted name.
function withheld(row: Record<string, unknown> | undefined): boolean {
  return !!row && (row.hidden === true || row.withheld === true || row.redacted === true || row.private === true);
}

export function parseHistory(provider: ExternalHistoryProvider, uuid: string, payload: unknown): ProviderHistory {
  const root = object(payload);
  const data = object(root?.data);
  if (withheld(root) || (provider === "mcprofiles" && withheld(data))) return providerResult(provider, "withheld");
  if (root && "uuid" in root && normalizeHistoryUUID(root.uuid) !== uuid) return providerResult(provider, "uuidMismatch");
  const result = providerResult(provider, "success");
  let records: unknown;
  switch (provider) {
    case "mcprofiles": {
      if (root?.kind === "notFound") return providerResult(provider, "notFound");
      if (root?.kind !== "profile" && root?.kind !== "archiveFallback") return providerResult(provider, "invalidResponse");
      if (normalizeHistoryUUID(data?.uuid) !== uuid) return providerResult(provider, "uuidMismatch");
      records = data?.usernameHistory;
      const cacheState = object(root.meta)?.cacheState ?? data?.cacheState;
      result.cached = cacheState === "fresh" || cacheState === "stale" || cacheState === "hit";
      result.stale = cacheState === "stale";
      result.archived = root.kind === "archiveFallback";
      break;
    }
    case "bisai": {
      if (normalizeHistoryUUID(root?.uuid) !== uuid) return providerResult(provider, "uuidMismatch");
      records = root?.names;
      const total = root?.total;
      const limit = root?.limit;
      if (!Array.isArray(records) || !nonnegativeInteger(total) || !nonnegativeInteger(limit) ||
          limit < 1 || limit > 500 || root?.offset !== 0 || records.length > limit || total < records.length) {
        return providerResult(provider, "invalidResponse");
      }
      result.limited = total > records.length;
      break;
    }
    case "laby": records = payload; break;
    case "winstreak": records = root?.nameHistory; break;
  }
  if (!Array.isArray(records)) return providerResult(provider, "invalidResponse");
  result.limited ||= records.length > 500 || (provider === "winstreak" && records.length >= 100);
  const observations: NameObservation[] = [];
  let invalid = false;
  const nameField = provider === "mcprofiles" ? "username" : "name";
  // Check all returned rows for privacy and identity before retaining anything.
  for (const item of records) {
    const row = object(item);
    const name = row?.[nameField];
    if (withheld(row) || (row && nameField in row && (name === null ||
        (typeof name === "string" && /^(?:[-－*…]+|\[(?:hidden|redacted|withheld)\])$/i.test(name))))) {
      return providerResult(provider, "withheld");
    }
    if (row && "uuid" in row && normalizeHistoryUUID(row.uuid) !== uuid) return providerResult(provider, "uuidMismatch");
  }
  for (const [index, item] of records.slice(0, 500).entries()) {
    const row = object(item);
    const name = row?.[nameField];
    if (!row || typeof name !== "string" || !MojangAPI.validateUsername(name)) {
      invalid = true;
      continue;
    }
    const occurrence = index + 1;
    if (provider === "laby") {
      if (!("changed_at" in row) || typeof row.accurate !== "boolean") {
        invalid = true;
        continue;
      }
      // The first entry may be creation, not a rename. Null may be withheld.
      const date = row.changed_at === null ? unknownDate("withheld") :
        historyDate(row.changed_at, index === 0 && row.accurate ? "reported" : row.accurate ? "accurateChange" : "firstObserved");
      observations.push({ provider, name, date, lastSeen: historyDate(row.last_seen_at, "lastObserved"), occurrence });
    } else if (provider === "mcprofiles") {
      if (!("observedAt" in row)) {
        invalid = true;
        continue;
      }
      observations.push({ provider, name, date: historyDate(row.observedAt, "lastObserved"), occurrence });
    } else if (provider === "bisai") {
      if (!nonnegativeInteger(row.occurrence) || !("first_seen" in row) || !("last_seen" in row)) {
        invalid = true;
        continue;
      }
      observations.push({
        provider, name, occurrence: row.occurrence,
        date: historyDate(row.first_seen, "firstObserved"),
        lastSeen: historyDate(row.last_seen, "lastObserved"),
        observedCurrent: row.last_seen === null,
      });
    } else {
      if (!("timestamp" in row)) {
        invalid = true;
        continue;
      }
      observations.push({ provider, name, date: historyDate(typeof row.timestamp === "number" ? row.timestamp : null, "reported"), occurrence });
    }
  }
  result.observations = observations;
  result.limited ||= invalid;
  if (!observations.length) result.status = records.length ? "invalidResponse" : "noHistory";
  if (invalid) result.reason = "Some records did not match the documented schema.";
  return result;
}

const MAX_BYTES = 256 * 1024;
export async function readHistoryJSON(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Error("Response too large");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function retryAfterMs(value: string | null): number {
  if (value === null || !value.trim()) return 30_000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(1000, delay) : 30_000;
}
