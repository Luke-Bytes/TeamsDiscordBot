import {
  HistoricalName, HistoryDate, NameObservation, ProviderHistory, unknownDate,
} from "./NameHistoryTypes";

const priority: Record<HistoryDate["kind"], number> = {
  accurateChange: 5, estimatedChange: 4, firstObserved: 3,
  reported: 2, lastObserved: 1, unknown: 0, withheld: 0,
};

function time(date: HistoryDate | null | undefined): number {
  return date?.value ? Date.parse(date.value) : -Infinity;
}
function byTime(a: HistoryDate, b: HistoryDate): number {
  return time(a) - time(b);
}

export function mergeNameHistory(current: string, results: ProviderHistory[], suppressed = false): HistoricalName[] {
  const groups = new Map<string, NameObservation[]>([[current.toLowerCase(), []]]);
  if (!suppressed && !results.some((r) => r.status === "withheld")) {
    for (const result of results) {
      for (const observation of result.observations) {
        const key = observation.name.toLowerCase();
        const group = groups.get(key) ?? [];
        group.push(observation);
        groups.set(key, group);
      }
    }
  }
  return [...groups].map(([key, raw]): HistoricalName => {
    const isCurrent = key === current.toLowerCase();
    const masked = raw.some((o) => o.date.kind === "withheld");
    // A null Laby change date may be a deliberate privacy choice. Keep the
    // names and sources, but don't reconstruct that date from other archives.
    const observations = masked ? raw.map((o) => ({ ...o, date: unknownDate("withheld"), lastSeen: undefined })) : raw;
    const dates = observations.flatMap((o) => [o.date, ...(o.lastSeen ? [o.lastSeen] : [])]).filter((d) => d.value !== null);
    const ordered = [...dates].sort(byTime);
    const seen = dates.filter((d) => d.kind === "firstObserved" || d.kind === "lastObserved").sort(byTime);
    const best = [...dates].sort((a, b) => priority[b.kind] - priority[a.kind] || byTime(b, a))[0] ?? unknownDate(masked ? "withheld" : "unknown");
    const exactDays = new Set(dates.filter((d) => d.kind === "accurateChange").map((d) => d.value!.slice(0, 10)));
    // Separate periods and conflicting exact dates are not reconciled by guesswork.
    const variants = [...new Set([...(isCurrent ? [current] : []), ...raw.map((o) => o.name)])].sort();
    return {
      name: isCurrent ? current : variants[0],
      normalizedName: key,
      current: isCurrent,
      variants,
      earliest: ordered[0] ?? null,
      latestObservation: seen[seen.length - 1] ?? null,
      bestDate: best,
      conflictingDates: exactDays.size > 1,
      providers: [...new Set(raw.map((o) => o.provider))].sort(),
      observations,
    };
  }).sort((a, b) => Number(b.current) - Number(a.current) || (time(b.bestDate) === time(a.bestDate) ? 0 : time(b.bestDate) - time(a.bestDate)) || a.normalizedName.localeCompare(b.normalizedName));
}
