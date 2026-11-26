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
    database: "Friendly Wars database",
  }[id];
}

function historyLine(name: HistoricalName, current: string): string {
  return `**${escapeText(name.name)}** — ${formatHistoryDate(name.bestDate)}${name.conflictingDates ? " (different reported change dates)" : ""}\nSources: ${name.providers.map((p) => providerLabel(p, current)).join(", ")}`;
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
  const names = result.names.filter((n) => !n.current);
  const localNames = result.suppressed ? [] : result.localPlayerNames ?? [];
  const lines = [
    ...names.map((n) => historyLine(n, current)),
    ...localNames.map((n) => `**${escapeText(n.name)}** — ${formatHistoryDate(n.bestDate)}\nFriendly Wars player record (UUID unverified; may be another account)`),
  ];
  const dates = result.names.flatMap((n) => n.earliest?.value ? [n.earliest] : []).sort((a, b) => Date.parse(a.value!) - Date.parse(b.value!));
  const summary = [
    `Current username: **${escapeText(current)}**`,
    `UUID: \`${result.uuid}\``,
    `Distinct visible previous names: ${names.length}`,
    ...(localNames.length ? [`Additional player-linked names (organiser only, UUID unverified): ${localNames.length}`] : []),
    ...(dates[0] ? [`Earliest dated evidence: ${formatHistoryDate(dates[0])}`] : []),
    historyProviderSummary(result),
    ...(result.providers.some((p) => p.provider === "database" && p.status === "success") ? ["Database names are stored associations, not verified rename events."] : []),
    ...(result.suppressed ? ["Historical records are withheld."] : result.partial ? ["Coverage is partial or unavailable."] : []),
  ].join("\n");
  // At most 4 private embed pages; if a provider's bounded response is larger,
  // include every visible name in a private text attachment as well.
  const chunks: string[][] = [[]];
  for (const line of lines) {
    let chunk = chunks[chunks.length - 1];
    if (chunk.join("\n\n").length + line.length > 2600) {
      chunk = [];
      chunks.push(chunk);
    }
    chunk.push(line);
  }
  const count = Math.min(chunks.length, 4);
  const overflow = chunks.length > count ? Buffer.from(
    `${current} — Minecraft name history\nUUID: ${result.uuid}\n${names.length} distinct visible previous names; ${localNames.length} additional UUID-unverified player-linked names\n\n${lines.join("\n\n")}\n\nHistorical records may be incomplete.`,
    "utf8"
  ) : undefined;
  const pages = chunks.slice(0, count).map((chunk, index) =>
    new EmbedBuilder()
      .setTitle(`${escapeText(current)} — Name History`)
      .setDescription([
        index === 0 ? summary : `Minecraft UUID: \`${result.uuid}\``,
        chunk.join("\n\n") || "No visible previous names returned.",
        ...(index === 0 && overflow ? ["Full visible list attached as a private text file."] : []),
      ].join("\n\n"))
      .setFooter({ text: `Page ${index + 1}/${count} · Historical records may be incomplete; distinct names are not exact rename counts.` })
  );
  return { pages, overflow };
}
