export type ExternalHistoryProvider = "laby" | "winstreak" | "mcprofiles" | "bisai";
export type HistoryProvider = ExternalHistoryProvider | "database";

export interface NameHistoryScope {
  guildId?: string;
  /** Only trusted organiser callers may opt into player-linked, non-UUID-bound records. */
  includePlayerRecords?: boolean;
}
export type ProviderStatus =
  | "success" | "noHistory" | "notFound" | "unavailable" | "rateLimited"
  | "timeout" | "invalidResponse" | "uuidMismatch" | "authenticationRequired"
  | "disabled" | "notConfigured" | "withheld";

export type HistoryDateKind =
  | "accurateChange" | "estimatedChange" | "firstObserved" | "lastObserved"
  | "reported" | "unknown" | "withheld";
export interface HistoryDate {
  kind: HistoryDateKind;
  value: string | null;
  precision: "day" | "instant" | null;
}
export interface NameObservation {
  provider: HistoryProvider;
  name: string;
  date: HistoryDate;
  lastSeen?: HistoryDate;
  // A provider's ordered record, not an inferred cross-provider rename event.
  occurrence: number;
  observedCurrent?: boolean;
}
export interface ProviderHistory {
  provider: HistoryProvider;
  status: ProviderStatus;
  fetchedAt: string | null;
  cached: boolean;
  archived: boolean;
  stale?: boolean;
  observations: NameObservation[];
  limited: boolean;
  reason?: string;
}
export interface HistoricalName {
  name: string;
  normalizedName: string;
  current: boolean;
  variants: string[];
  earliest: HistoryDate | null;
  latestObservation: HistoryDate | null;
  bestDate: HistoryDate;
  conflictingDates: boolean;
  providers: HistoryProvider[];
  observations: NameObservation[];
}
export interface NameHistoryResult {
  status: "found" | "invalid" | "notFound" | "unavailable";
  requestedUsername?: string;
  uuid?: string;
  currentUsername?: string;
  verifiedAt?: string;
  names: HistoricalName[];
  /** Player-linked aliases, not verified as names of this UUID. Organiser-only. */
  localPlayerNames?: HistoricalName[];
  providers: ProviderSummary[];
  suppressed: boolean;
  partial: boolean;
}
export type ProviderSummary = Omit<ProviderHistory, "observations"> & {
  observationCount: number;
};

export function normalizeHistoryUUID(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)) return;
  return value.replace(/-/g, "").toLowerCase();
}

export function unknownDate(kind: "unknown" | "withheld" = "unknown"): HistoryDate {
  return { kind, value: null, precision: null };
}

// Preserve day precision and reject JS Date's silent rollover of impossible dates.
export function historyDate(value: unknown, kind: HistoryDateKind): HistoryDate {
  let date: Date;
  let dayOnly = false;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    date = new Date(value);
  } else if (typeof value === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(value);
    if (!match) return unknownDate();
    const calendar = new Date(match[1] + "T00:00:00Z");
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== match[1]) return unknownDate();
    dayOnly = value.length === 10;
    date = new Date(dayOnly ? value + "T00:00:00Z" : value);
  } else return unknownDate();
  if (!Number.isFinite(date.getTime()) || date.getTime() < Date.UTC(2009, 0, 1) || date.getTime() > Date.now() + 86_400_000) return unknownDate();
  return { kind, value: dayOnly ? date.toISOString().slice(0, 10) : date.toISOString(), precision: dayOnly ? "day" : "instant" };
}
