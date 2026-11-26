import { prismaClient } from "../../../database/prismaClient";
import type { MaskedClue } from "./MaskedDraftHints";
import { deriveMaskedClues } from "./MaskedDraftHistory";

interface Candidate {
  playerId: string;
  discordSnowflake: string;
}

const MAX_ROWS = 20_000;
const DAYS = 365;

/** One bounded read of the entire initial lobby, including both known captains. */
export async function loadMaskedStatistics(
  players: readonly Candidate[],
  captainDiscordIds: { RED: string; BLUE: string },
  now = Date.now(),
  currentMap?: string,
): Promise<Map<string, MaskedClue[]>> {
  const ids = players.map((player) => player.playerId);
  const red = players.find((player) => player.discordSnowflake === captainDiscordIds.RED)?.playerId;
  const blue = players.find((player) => player.discordSnowflake === captainDiscordIds.BLUE)?.playerId;
  if (!red || !blue || red === blue || new Set(ids).size !== ids.length || ids.some((id) => !id)) return new Map();
  const since = new Date(now - DAYS * 24 * 60 * 60 * 1000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      prismaClient.gameParticipation.findMany({
        where: {
          playerId: { in: ids },
          game: { is: {
            finished: true, winner: { in: ["RED", "BLUE"] },
            endTime: { gte: since, lte: new Date(now) },
          } },
        },
        select: {
          playerId: true, gameId: true, team: true, captain: true, mvp: true,
          game: { select: { winner: true, endTime: true, settings: { select: { map: true } } } },
        },
        take: MAX_ROWS + 1,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Card statistics unavailable.")), 5000);
      }),
    ]);
    // A truncated history must not be used to claim a best partner or map.
    if (rows.length > MAX_ROWS) return new Map();
    const clues = deriveMaskedClues(rows, ids, { RED: red, BLUE: blue }, currentMap);
    return new Map(players.flatMap((player) =>
      clues.has(player.playerId) ? [[player.discordSnowflake, clues.get(player.playerId)!] as const] : []));
  } catch {
    // Optional clues fail closed; never expose Prisma errors or private IDs.
    return new Map();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
