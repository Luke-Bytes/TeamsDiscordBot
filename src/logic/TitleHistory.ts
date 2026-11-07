import { Team } from "@prisma/client";
import { prismaClient } from "../database/prismaClient";

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error("Title history query returned an invalid document list");
  }
  return value.map((row: unknown) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("Title history query returned an invalid document");
    }
    return row as Record<string, unknown>;
  });
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function id(value: unknown): string | null {
  if (typeof value === "string") return value;
  // Raw MongoDB ObjectIds use Extended JSON. Older imports may use these IDs.
  if (typeof value === "object" && value !== null && "$oid" in value) {
    return string(value.$oid);
  }
  return null;
}

function team(value: unknown): Team | null {
  const normalized = string(value)?.trim().toUpperCase();
  return normalized === Team.RED || normalized === Team.BLUE
    ? normalized
    : null;
}

/** Read legacy fields without Prisma's non-null scalar/enum decoding.
 * findRaw consumes MongoDB's cursor, unlike a single $runCommandRaw firstBatch.
 * Let query failures propagate so incomplete history never becomes an award run.
 */
export async function loadTitleHistory(): Promise<{
  games: Array<{ organiser: string | null; host: string | null }>;
  captainWins: Array<{ playerId: string }>;
}> {
  const [rawGames, rawCaptains] = await Promise.all([
    prismaClient.game.findRaw({
      options: { projection: { _id: 1, organiser: 1, host: 1, winner: 1 } },
    }),
    prismaClient.gameParticipation.findRaw({
      filter: { captain: { $in: [true, "true", 1] } },
      options: { projection: { _id: 0, playerId: 1, gameId: 1, team: 1 } },
    }),
  ]);

  const games = records(rawGames);
  const winnerByGame = new Map<string, Team>();
  for (const game of games) {
    const gameId = id(game._id);
    const winner = team(game.winner);
    if (gameId && winner) winnerByGame.set(gameId, winner);
  }

  const captainWins: Array<{ playerId: string }> = [];
  for (const participation of records(rawCaptains)) {
    const playerId = id(participation.playerId);
    const gameId = id(participation.gameId);
    const captainTeam = team(participation.team);
    if (
      playerId &&
      gameId &&
      captainTeam &&
      captainTeam === winnerByGame.get(gameId)
    ) {
      captainWins.push({ playerId });
    }
  }

  return {
    games: games.map((game) => ({
      organiser: string(game.organiser),
      host: string(game.host),
    })),
    captainWins,
  };
}
