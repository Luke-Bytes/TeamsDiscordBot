import { prismaClient } from "../database/prismaClient";

type MongoBatchResult = {
  cursor?: { firstBatch?: unknown[] };
};

export class PrismaSafeExtractor {
  static async runCommandRawSafe<T>(
    label: string,
    command: object,
    mapRow: (row: unknown) => T | null,
    fallback: T[]
  ): Promise<T[]> {
    try {
      const base = command as {
        find?: string;
        batchSize?: number;
        singleBatch?: boolean;
      };
      const enriched =
        base.find && !base.singleBatch
          ? { ...base, batchSize: base.batchSize ?? 10000, singleBatch: true }
          : base;
      const result = (await prismaClient.$runCommandRaw(
        enriched
      )) as MongoBatchResult;
      const items: unknown[] = [...(result.cursor?.firstBatch ?? [])];

      return items
        .map((row) => mapRow(row))
        .filter((row): row is T => row !== null);
    } catch (error) {
      console.warn(`[PrismaSafeExtractor] ${label} failed:`, error);
      return fallback;
    }
  }

  static async safeFindGamesForHostOrganiserCounts(): Promise<
    Array<{ organiser: string | null; host: string | null }>
  > {
    return this.runCommandRawSafe(
      "safeFindGamesForHostOrganiserCounts",
      {
        find: "Game",
        projection: { organiser: 1, host: 1, _id: 0 },
      },
      (row) => {
        if (typeof row !== "object" || row === null) return null;
        const record = row as Record<string, unknown>;
        return {
          organiser:
            typeof record.organiser === "string" ? record.organiser : null,
          host: typeof record.host === "string" ? record.host : null,
        };
      },
      []
    );
  }

  static async safeFindCaptainParticipations(): Promise<
    Array<{ playerId: string; team: string | null; winner: string | null }>
  > {
    const normalizeId = (value: unknown): string | null => {
      if (typeof value === "string") return value;
      if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        const oid = record.$oid;
        if (typeof oid === "string") return oid;
        const toHex = record.toHexString;
        if (typeof toHex === "function") {
          try {
            const hex = toHex.call(value);
            if (typeof hex === "string") return hex;
          } catch (error) {
            void error;
          }
        }
        const toStr = record.toString;
        if (typeof toStr === "function") {
          try {
            const str = toStr.call(value);
            if (typeof str === "string" && str !== "[object Object]") {
              return str;
            }
          } catch (error) {
            void error;
          }
        }
      }
      return null;
    };

    const participations = await this.runCommandRawSafe(
      "safeFindCaptainParticipations",
      {
        find: "GameParticipation",
        filter: { captain: { $in: [true, "true", 1] } },
        projection: { playerId: 1, team: 1, gameId: 1, _id: 0 },
      },
      (row) => {
        if (typeof row !== "object" || row === null) return null;
        const record = row as Record<string, unknown>;
        const playerId =
          typeof record.playerId === "string" ? record.playerId : null;
        const team =
          typeof record.team === "string"
            ? record.team.trim().toUpperCase()
            : null;
        const gameId = typeof record.gameId === "string" ? record.gameId : null;
        if (!playerId || !gameId) return null;
        return { playerId, team, gameId };
      },
      []
    );

    if (!participations.length) return [];

    const gameIds = Array.from(new Set(participations.map((p) => p.gameId)));
    const gameRows = await this.runCommandRawSafe(
      "safeFindCaptainParticipations.games",
      {
        find: "Game",
        filter: { _id: { $in: gameIds } },
        projection: { _id: 1, winner: 1 },
      },
      (row) => {
        if (typeof row !== "object" || row === null) return null;
        const record = row as Record<string, unknown>;
        const id = normalizeId(record._id);
        const winner = typeof record.winner === "string" ? record.winner : null;
        if (!id) return null;
        return { id, winner };
      },
      []
    );

    const winners = new Map<string, string | null>();
    for (const row of gameRows) {
      winners.set(row.id, row.winner);
    }

    return participations.map((p) => ({
      playerId: p.playerId,
      team: p.team,
      winner: winners.get(p.gameId) ?? null,
    }));
  }
}
