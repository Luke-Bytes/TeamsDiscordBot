import { prismaClient } from "../database/prismaClient";

type MongoBatchResult = { cursor?: { firstBatch?: unknown[] } };

export class PrismaSafeExtractor {
  static async runCommandRawSafe<T>(
    label: string,
    command: object,
    mapRow: (row: unknown) => T | null,
    fallback: T[]
  ): Promise<T[]> {
    try {
      const result = (await prismaClient.$runCommandRaw(
        command
      )) as MongoBatchResult;
      const batch = result.cursor?.firstBatch ?? [];
      return batch
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
        filter: { organiser: { $ne: null }, host: { $ne: null } },
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
    const participations = await this.runCommandRawSafe(
      "safeFindCaptainParticipations",
      {
        find: "GameParticipation",
        filter: { captain: true, team: { $in: ["RED", "BLUE"] } },
        projection: { playerId: 1, team: 1, gameId: 1, _id: 0 },
      },
      (row) => {
        if (typeof row !== "object" || row === null) return null;
        const record = row as Record<string, unknown>;
        const playerId =
          typeof record.playerId === "string" ? record.playerId : null;
        const team = typeof record.team === "string" ? record.team : null;
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
        const id = typeof record._id === "string" ? record._id : null;
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
