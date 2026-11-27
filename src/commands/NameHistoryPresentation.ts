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

function historyLine(name: HistoricalName): string {
  const date = name.bestDate;
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
  return `**${escapeText(name.name)}** - ${labels[date.kind]}${value ? " " + value : ""}${name.conflictingDates ? " (dates differ)" : ""}`;
}

export function historyProviderSummary(result: NameHistoryResult): string {
  const responded = result.providers.filter((p) => p.status === "success" || p.status === "noHistory").length;
  const configured = result.providers.filter((p) => p.status !== "notConfigured").length;
  return `Providers responding: ${responded}/${configured} configured` +
    (result.providers.length ? "\n" + result.providers.map((p) =>
      `${providerLabel(p.provider, result.currentUsername ?? "")}: ${statusLabels[p.status]}${p.cached ? " (cached)" : ""}${p.archived ? " (archive)" : ""}${p.stale ? " (stale)" : ""}${p.limited ? " (limited)" : ""}`
    ).join(" · ") : "");
}

export function combinedHistorySummary(result: NameHistoryResult | undefined): string {
  if (!result || result.status !== "found" || !result.currentUsername) {
    return "UUID-linked history unavailable or no valid primary UUID. Local moderation records are unaffected.";
  }
  const current = result.currentUsername;
  const old = result.names.filter((n) => !n.current);
  const lines = [
    `Verified current IGN: ${escapeText(current)}`,
    result.suppressed ? "Historical records withheld." : `${old.length} distinct visible previous names (not a rename count).`,
    historyProviderSummary(result),
    ...old.slice(0, 3).map((n) => `**${escapeText(n.name)}** — ${formatHistoryDate(n.bestDate)} (${n.providers.map((p) => p === "database" ? "Friendly Wars database" : p).join(", ")})`),
    ...(old.length > 3 ? [`…${old.length - 3} more; use /name history for details.`] : []),
    result.partial ? "Partial/unavailable coverage; not evidence of an alt." : "History may be incomplete; not evidence of an alt.",
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
  const caveat = sources.includes("database")
    ? "History may be incomplete; database names are recorded associations."
    : "History may be incomplete.";
  const available = !result.suppressed && result.providers.some((p) => p.status === "success" || p.status === "noHistory");
  const emptyMessage = available ? "No previous names found." : "Name history unavailable.";
  const lines = names.map(historyLine);
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
    [current, `${names.length} previous names`, lines.join("\n"), sourceText, attribution, caveat].filter(Boolean).join("\n\n"),
    "utf8"
  ) : undefined;
  const pages = chunks.slice(0, count).map((chunk, index) =>
    new EmbedBuilder()
      .setTitle(escapeText(current))
      .setThumbnail(`https://mc-heads.net/avatar/${result.uuid}/64.png`)
      .setDescription([
        ...(index === 0 && names.length ? [`${names.length} previous ${names.length === 1 ? "name" : "names"}`] : []),
        chunk.join("\n") || emptyMessage,
        ...(index === 0 && overflow ? ["Full list attached."] : []),
        ...(attribution ? [attribution] : []),
      ].join("\n\n"))
      .setFooter({ text: [sourceText, count > 1 ? `Page ${index + 1}/${count}` : "", caveat].filter(Boolean).join(" · ") })
  );
  return { pages, overflow };
}
