import { MojangAPI } from "../api/MojangAPI";
import { providerResult } from "../api/NameHistoryProviders";
import { historyDate, NameHistoryScope, NameObservation, normalizeHistoryUUID, ProviderHistory, unknownDate } from "../api/NameHistoryTypes";
import { prismaClient } from "./prismaClient";

const MAX_ROWS = 500;

export interface DatabaseHistory {
  history: ProviderHistory;
  playerRecords: NameObservation[];
}

function add(rows: NameObservation[], name: unknown, date = unknownDate()): void {
  if (typeof name !== "string" || !MojangAPI.validateUsername(name) || name === "UnknownIGN") return;
  rows.push({ provider: "database", name, date, occurrence: rows.length + 1 });
}

function uuidVariants(uuid: string): string[] {
  return [uuid, uuid.replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5")];
}

/** Read existing records only; never infer a UUID from a historical IGN. */
export class DatabaseNameHistory {
  static async lookup(uuid: string, scope: NameHistoryScope): Promise<DatabaseHistory> {
    const history = providerResult("database", "noHistory");
    const playerRecords: NameObservation[] = [];
    const variants = uuidVariants(uuid);
    const [players, signups] = await Promise.allSettled([
      prismaClient.player.findMany({
        where: { primaryMinecraftAccount: { in: variants, mode: "insensitive" } },
        select: { id: true, primaryMinecraftAccount: true, latestIGN: true,
          ...(scope.includePlayerRecords ? { minecraftAccounts: true } : {}) },
        take: 2,
      }),
      scope.guildId ? prismaClient.eventSignup.findMany({
        where: { minecraftUUID: { in: variants, mode: "insensitive" }, event: { guildId: scope.guildId } },
        select: { minecraftUUID: true, minecraftUsername: true },
        orderBy: { id: "asc" }, take: MAX_ROWS + 1,
      }) : Promise.resolve([]),
    ]);
    let limited = players.status === "rejected" || signups.status === "rejected";
    if (signups.status === "fulfilled") {
      limited ||= signups.value.length > MAX_ROWS;
      for (const row of signups.value.slice(0, MAX_ROWS)) {
        if (normalizeHistoryUUID(row.minecraftUUID) !== uuid) { limited = true; continue; }
        // Signups can be rewritten when identity changes, so neither createdAt
        // nor updatedAt is a reliable date for the name itself.
        add(history.observations, row.minecraftUsername);
      }
    }
    if (players.status === "fulfilled") {
      const matches = players.value;
      if (matches.length > 1) limited = true; // ambiguous local ownership
      if (matches.length === 1 && normalizeHistoryUUID(matches[0].primaryMinecraftAccount) === uuid) {
        const player = matches[0];
        add(history.observations, player.latestIGN);
        if (scope.includePlayerRecords) {
          const accounts = player.minecraftAccounts ?? [];
          limited ||= accounts.length > MAX_ROWS;
          for (const name of accounts.slice(0, MAX_ROWS)) {
            if (!normalizeHistoryUUID(name)) add(playerRecords, name);
          }
          try {
            const games = await prismaClient.gameParticipation.findMany({
              where: { playerId: player.id, game: { finished: true } },
              select: { ignUsed: true, game: { select: { startTime: true } } },
              orderBy: { id: "asc" }, take: MAX_ROWS + 1,
            });
            limited ||= games.length > MAX_ROWS;
            for (const game of games.slice(0, MAX_ROWS)) {
              add(playerRecords, game.ignUsed, historyDate(game.game?.startTime?.getTime(), "lastObserved"));
            }
          } catch { limited = true; }
        }
      } else if (matches.length === 1) limited = true;
    }
    history.status = history.observations.length || playerRecords.length ? "success" :
      players.status === "rejected" && (!scope.guildId || signups.status === "rejected") ? "unavailable" : "noHistory";
    history.limited = limited;
    history.fetchedAt = new Date().toISOString();
    return { history, playerRecords };
  }
}
