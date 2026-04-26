import { Team } from "@prisma/client";
import { escapeIgn, prettifyName } from "../../util/Utils";
import {
  EXCLUDED_BANNED_CLASSES,
  InsightSection,
  SeasonRecapGame,
  SeasonRecapPlayer,
  SeasonRecapPlayerStats,
} from "./types";

export function formatSection(section: InsightSection): string {
  return [`**${section.title}**`, ...section.lines].join("\n");
}

export function splitDiscordBlocks(text: string, maxLength: number): string[] {
  const blocks: string[] = [];
  let current = "";
  for (const section of text.split("\n\n")) {
    if (!current) {
      current = section;
      continue;
    }
    if (`${current}\n\n${section}`.length <= maxLength) {
      current = `${current}\n\n${section}`;
    } else {
      blocks.push(current);
      current = section;
    }
  }
  if (current) blocks.push(current);

  return blocks.flatMap((block) => splitOversizedBlock(block, maxLength));
}

export function prefixRows(label: string, rows: string[]) {
  if (!rows.length) return [];
  return rows.map(
    (row, idx) => `${idx === 0 ? `${label}: ` : "  "}${idx + 1}. ${row}`
  );
}

export function playerName(
  playerId: string,
  players: Map<string, SeasonRecapPlayer>
) {
  void playerId;
  return escapeIgn(players.get(playerId)?.latestIGN ?? "Unknown Player");
}

export function duoName(
  a: string,
  b: string,
  players: Map<string, SeasonRecapPlayer>
) {
  return `${playerName(a, players)} + ${playerName(b, players)}`;
}

export function pairKey(a: string, b: string) {
  return [a, b].sort().join("::");
}

export function totalGames(stats: SeasonRecapPlayerStats) {
  return stats.wins + stats.losses;
}

export function formatDateRange(games: SeasonRecapGame[]) {
  if (!games.length) return "No games";
  return `${formatDate(games[0].startTime)}-${formatDate(games.at(-1)!.endTime)}`;
}

export function formatDate(date: Date) {
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export function duration(game: SeasonRecapGame) {
  return Math.max(
    0,
    (game.endTime.getTime() - game.startTime.getTime()) / 60000
  );
}

export function formatMinutes(minutes: number) {
  if (!Number.isFinite(minutes)) return "0m";
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

export function mean(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function percentile(values: number[], pct: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(pct * sorted.length))
  );
  return sorted[idx];
}

export function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export function pretty(value: string) {
  return prettifyName(value);
}

export function groupBy<T, K>(items: T[], keyFn: (item: T) => K) {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const rows = grouped.get(key) ?? [];
    rows.push(item);
    grouped.set(key, rows);
  }
  return grouped;
}

export function topCounts(values: string[], limit: number) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export function isUsefulName(value: string) {
  return value.trim().length > 0 && value !== "Unknown";
}

export function bannedClasses(game: SeasonRecapGame) {
  const settings = game.settings;
  const classes = [
    ...(settings?.organiserBannedClasses ?? []),
    ...(settings?.sharedCaptainBannedClasses ?? []),
    ...(settings?.nonSharedCaptainBannedClasses?.RED ?? []),
    ...(settings?.nonSharedCaptainBannedClasses?.BLUE ?? []),
  ];
  return classes.filter((cls) => !EXCLUDED_BANNED_CLASSES.has(cls));
}

export function formatGameHighlight(game: SeasonRecapGame, eloGap: number) {
  const red = game.gameParticipations
    .filter((gp) => gp.team === Team.RED)
    .map((gp) => escapeIgn(gp.ignUsed))
    .join(", ");
  const blue = game.gameParticipations
    .filter((gp) => gp.team === Team.BLUE)
    .map((gp) => escapeIgn(gp.ignUsed))
    .join(", ");
  return `${pretty(game.settings?.map ?? "Unknown")} on ${formatDate(game.startTime)}: ${game.winner} won despite ${Math.round(eloGap)} avg Elo gap. RED: ${red}. BLUE: ${blue}.`;
}

export function formatGameSummary(game: SeasonRecapGame) {
  const captains = game.gameParticipations
    .filter((gp) => gp.captain)
    .map((gp) => escapeIgn(gp.ignUsed))
    .join(" vs ");
  const captainText = captains ? `, captains ${captains}` : "";
  return `${formatMinutes(duration(game))} on ${pretty(game.settings?.map ?? "Unknown")} (${formatDate(game.startTime)}${captainText})`;
}

function splitOversizedBlock(block: string, maxLength: number) {
  if (block.length <= maxLength) return [block];

  const chunks: string[] = [];
  let chunk = "";
  for (const line of block.split("\n")) {
    if (!chunk) {
      chunk = line;
    } else if (`${chunk}\n${line}`.length <= maxLength) {
      chunk = `${chunk}\n${line}`;
    } else {
      chunks.push(chunk);
      chunk = line;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
