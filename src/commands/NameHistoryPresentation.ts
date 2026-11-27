import { EmbedBuilder } from "discord.js";
import { HistoryDate, HistoricalName, NameHistoryResult, HistoryProvider } from "../api/NameHistoryTypes";
import { escapeText } from "../util/Utils";

const statusLabels = {
  success: "responded", noHistory: "no records", notFound: "not found",
  unavailable: "unavailable", rateLimited: "rate limited", timeout: "timed out",
  invalidResponse: "invalid response", uuidMismatch: "identity mismatch",
  authenticationRequired: "authentication required",
  notConfigured: "not configured", withheld: "withheld",
};

export function formatHistoryDate(date: HistoryDate): string {
  if (!date.value) return date.kind === "withheld" ? "Date unknown or withheld" : "Date unknown";
  const value = date.precision === "day" ? date.value : date.value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  const label = {
    accurateChange: "Provider-reported change",
    estimatedChange: "Estimated change",
    firstObserved: "First observed",
    lastObserved: "Last observed",
    reported: "Provider-reported date",
    unknown: "Unknown date",
    withheld: "Withheld date",
  }[date.kind];
  return `${label}: ${value}`;
}

function providerLabel(id: HistoryProvider, current: string): string {
  return {
    laby: `[Laby](https://laby.net/${current})`,
    winstreak: "[Winstreak API](https://api.winstreak.ws/)",
    mcprofiles: "[MCProfiles](https://mcprofiles.me/docs)",
    bisai: "[Bisai](https://mc-api.bisai.dev/docs)",
    crafty: "[Crafty](https://crafty.gg/public-api)",
    database: "Friendly Wars database",
  }[id];
}

const publicSourceLabels: Record<HistoryProvider, string> = {
  laby: "Laby",
  winstreak: "Winstreak",
  mcprofiles: "MCProfiles",
  bisai: "Bisai",
  crafty: "Crafty",
  database: "Friendly Wars",
};

function historyDateText(date: HistoryDate, compact = false): string {
  const labels = {
    accurateChange: "Reported change",
    estimatedChange: "Estimated change",
    firstObserved: "First seen",
    lastObserved: "Last seen",
    reported: "Reported",
    unknown: "Date unknown",
    withheld: "Date withheld",
  };
  const value = date.value
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(date.value))
    : "";
  const label = compact && value && date.kind === "accurateChange" ? "" : labels[date.kind];
  return [label, value].filter(Boolean).join(" ");
}

function historyLine(name: HistoricalName, compact = false): string {
  const date = compact && !name.bestDate.value && name.bestDate.kind !== "withheld" &&
    name.providers.length === 1 && name.providers[0] === "database"
    ? "Friendly Wars record"
    : historyDateText(name.bestDate, compact);
  return `**${escapeText(name.name)}** - ${date}${name.conflictingDates ? " (dates differ)" : ""}`;
}

function isChangeDate(kind: HistoryDate["kind"], provider?: HistoryProvider): boolean {
  // Crafty and Laby supply changed_at; Winstreak's generic timestamp has
  // undocumented semantics and cannot establish a rename date.
  return kind === "accurateChange" || kind === "estimatedChange" ||
    (kind === "reported" && (provider === "crafty" || provider === "laby"));
}

// Only change-like dates can bracket a possible period of username use.
function changeDay(name: HistoricalName): number | undefined {
  const date = name.bestDate;
  if (!date.value || name.conflictingDates || !name.observations.some((observation) =>
    observation.date.kind === date.kind && observation.date.value === date.value &&
    isChangeDate(date.kind, observation.provider))) return;

  // The merge groups names, not individual periods. Don't assign one duration
  // to a name that has multiple distinct change dates from the same source.
  const byProvider = new Map<HistoryProvider, string>();
  for (const observation of name.observations) {
    if (!observation.date.value || !isChangeDate(observation.date.kind, observation.provider)) continue;
    const day = observation.date.value.slice(0, 10);
    const previous = byProvider.get(observation.provider);
    if (previous && previous !== day) return;
    byProvider.set(observation.provider, day);
  }
  const day = Date.parse(date.value.slice(0, 10));
  if (Number.isFinite(day)) return day;
}

function durationText(days: number | undefined): string {
  return days === undefined ? "" : ` (${days} day${days === 1 ? "" : "s"})`;
}

function publicHistoryLine(name: HistoricalName, newer: HistoricalName | undefined): { line: string; duration: boolean } {
  const start = changeDay(name);
  const end = newer && changeDay(newer);
  const days = start !== undefined && end !== undefined && end > start
    ? (end - start) / 86_400_000
    : undefined;
  return { line: historyLine(name, true) + durationText(days), duration: days !== undefined };
}

function currentHistoryLine(name: HistoricalName | undefined, previous: HistoricalName[], now: number, withheld: boolean): { line: string; duration: boolean } {
  if (!name || (!name.bestDate.value && name.bestDate.kind !== "withheld")) {
    return { line: "", duration: false };
  }
  const start = changeDay(name);
  const today = Math.floor(now / 86_400_000) * 86_400_000;
  const laterPrevious = previous.some((old) => {
    const day = changeDay(old);
    return day !== undefined && start !== undefined && day > start;
  });
  const days = !withheld && !laterPrevious && start !== undefined && today >= start
    ? (today - start) / 86_400_000
    : undefined;
  const label = days !== undefined ? "Since " : name.bestDate.kind === "accurateChange" ? "Recorded " : "";
  const date = historyDateText(days !== undefined ? { ...name.bestDate, kind: "accurateChange" } : name.bestDate, true);
  return {
    line: label + date + durationText(days) + (name.conflictingDates ? " (dates differ)" : ""),
    duration: days !== undefined,
  };
}

export function historyProviderSummary(result: NameHistoryResult): string {
  const responded = result.providers.filter((p) => p.status === "success" || p.status === "noHistory").length;
  const configured = result.providers.filter((p) => p.status !== "notConfigured").length;
  return `Providers responding: ${responded}/${configured} configured` +
    (result.providers.length ? "\n" + result.providers.map((p) =>
      `${providerLabel(p.provider, result.currentUsername ?? "")}: ${statusLabels[p.status]}${p.cached ? " (cached)" : ""}${p.archived ? " (archive)" : ""}${p.stale ? " (stale)" : ""}${p.limited ? " (limited)" : ""}`
    ).join(" · ") : "");
}

export function combinedHistorySummary(
  result: NameHistoryResult | undefined,
  storedIGN?: string | null
): string {
  if (!result || result.status !== "found" || !result.currentUsername) {
    return "UUID-linked name history unavailable.";
  }
  const current = result.currentUsername;
  const old = result.suppressed ? [] : result.names.filter((n) => !n.current);
  const sources = [...new Set(old.flatMap((n) => n.providers))];
  const lines = [
    ...(current.toLowerCase() !== storedIGN?.toLowerCase()
      ? [`Verified current IGN: **${escapeText(current)}**`]
      : []),
    result.suppressed
      ? "Historical records withheld."
      : `**${old.length} previous name${old.length === 1 ? "" : "s"} found**`,
    ...old.slice(0, 5).map((name) => historyLine(name)),
    ...(old.length > 5 ? [`…${old.length - 5} more · /name history`] : []),
    ...(sources.length
      ? [`Sources: ${sources.map((p) => p === "winstreak" ? providerLabel(p, current) : publicSourceLabels[p]).join(", ")}`]
      : []),
    result.partial ? "History coverage is incomplete." : "History may be incomplete.",
  ];
  return lines.join("\n");
}

export function buildNameHistoryPages(result: NameHistoryResult): { pages: EmbedBuilder[]; overflow?: Buffer } {
  if (result.status !== "found" || !result.currentUsername || !result.uuid) return { pages: [] };
  const current = result.currentUsername;
  // This presentation is public even if a privileged caller supplied extra records.
  const names = result.suppressed ? [] : result.names.filter((n) => !n.current);
  const sources = result.suppressed ? [] : [...new Set(result.names.flatMap((n) => n.providers))];
  const sourceText = sources.length ? `Sources: ${sources.map((p) => publicSourceLabels[p]).join(", ")}` : "";
  // Discord footer text cannot contain clickable Markdown links.
  // Keep the required Winstreak attribution link once, not on every record.
  const attribution = sources.includes("winstreak") ? providerLabel("winstreak", current) : "";
  const currentName = result.suppressed ? undefined : result.names.find((n) => n.current);
  // Compute before pagination, so the first row on a new page still has its
  // next change date. Never bridge an explicitly withheld date.
  const withheld = result.names.some((n) => n.bestDate.kind === "withheld");
  const rows = names.map((name, index) => publicHistoryLine(
    name, withheld ? undefined : index === 0 ? currentName : names[index - 1],
  ));
  const lines = rows.map((row) => row.line);
  const now = result.verifiedAt ? Date.parse(result.verifiedAt) : Date.now();
  const currentRow = currentHistoryLine(currentName, names, now, withheld);
  const available = !result.suppressed && result.providers.some((p) => p.status === "success" || p.status === "noHistory");
  const emptyMessage = available ? "No previous names found." : "Name history unavailable.";
  // Optional, unconfigured sources and ordinary empty results are not failures.
  const unavailable = result.providers.filter((p) => !["success", "noHistory", "notFound", "notConfigured", "withheld"].includes(p.status));
  const limited = result.providers.filter((p) => p.limited && (p.status === "success" || p.status === "noHistory"));
  const caveat = [
    currentRow.duration || rows.some((row) => row.duration) ? "Estimated durations" : "",
    !result.suppressed && (available || names.length || currentRow.line) && unavailable.length
      ? `Unavailable: ${unavailable.map((p) => publicSourceLabels[p.provider]).join(", ")}` : "",
    !result.suppressed && limited.length
      ? `Limited records: ${limited.map((p) => publicSourceLabels[p.provider]).join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  // At most four public embed messages, with a complete list attached if needed.
  const chunks: string[][] = [[]];
  for (const line of lines) {
    let chunk = chunks[chunks.length - 1];
    if (chunk.join("\n").length + line.length + 1 > 2600 || chunk.length >= 40) {
      chunk = [];
      chunks.push(chunk);
    }
    chunk.push(line);
  }
  const count = Math.min(chunks.length, 4);
  const overflow = chunks.length > count ? Buffer.from(
    [current, currentRow.line, `${names.length} previous names`, lines.join("\n"), sourceText, attribution, caveat].filter(Boolean).join("\n\n"),
    "utf8"
  ) : undefined;
  const pages = chunks.slice(0, count).map((chunk, index) => {
    const page = new EmbedBuilder()
      .setTitle(escapeText(current))
      .setThumbnail(`https://mc-heads.net/avatar/${result.uuid}/64.png`)
      .setDescription([
        ...(index === 0 && currentRow.line ? [currentRow.line] : []),
        ...(index === 0 && names.length ? [`${names.length} previous ${names.length === 1 ? "name" : "names"}`] : []),
        chunk.join("\n") || emptyMessage,
        ...(index === 0 && overflow ? ["Full list attached."] : []),
        ...(attribution ? [attribution] : []),
      ].join("\n\n"));
    const footer = [sourceText, count > 1 ? `Page ${index + 1}/${count}` : "", caveat].filter(Boolean).join(" · ");
    if (footer) page.setFooter({ text: footer });
    return page;
  });
  return { pages, overflow };
}
