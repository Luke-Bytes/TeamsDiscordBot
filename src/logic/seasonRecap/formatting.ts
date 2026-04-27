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
  return [`**${label}**`, ...rows.map((row, idx) => `${idx + 1}. ${row}`)];
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

export function formatSeasonSpan(games: SeasonRecapGame[]) {
  if (!games.length) return "0 days";
  const first = games[0].startTime.getTime();
  const last = games.at(-1)!.endTime.getTime();
  const days = Math.max(1, Math.ceil((last - first) / 86_400_000));
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`;
  const weeks = Math.floor(days / 7);
  const remainder = days % 7;
  return remainder
    ? `${weeks} week${weeks === 1 ? "" : "s"} and ${remainder} day${remainder === 1 ? "" : "s"}`
    : `${weeks} week${weeks === 1 ? "" : "s"}`;
}

export function formatDate(date: Date) {
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export function mean(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
