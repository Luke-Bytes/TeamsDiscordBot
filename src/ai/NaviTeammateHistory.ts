import { Team } from "@prisma/client";
import { prismaClient } from "../database/prismaClient";
import { SeasonService } from "../database/SeasonService";

type TeammateRequest = {
  metric: "games" | "wins";
  season: "all" | "active" | number;
};

const MAX_GAMES = 1000;
const MAX_ROWS = 40_000;

/** Explicit self-scoped superlatives only. Never confuse global wins with pair wins. */
export function requestedTeammateHistory(
  question: string
): TeammateRequest | null {
  const q = question.trim().replace(/[?!\.]+$/, "");
  const scope =
    /\s+(?:in |during |for )?(?:season (\d{1,4})|(this|current|active) season|all[- ]time|ever|across all seasons)$/i.exec(
      q
    );
  const season = scope?.[1] ? Number(scope[1]) : scope?.[2] ? "active" : "all";
  const subject = scope ? q.slice(0, scope.index) : q;
  const wins =
    /^who (?:have i|did i|do i) (?:won|win) (?:the most (?:games )?with|with (?:the )?most)$/i.test(
      subject
    ) ||
    /^which teammate (?:have i|did i|do i) (?:won|win) (?:the most (?:games )?with|with (?:the )?most)$/i.test(
      subject
    ) ||
    /^which teammate (?:do i have|have i got) the most wins with$/i.test(
      subject
    ) ||
    /^who (?:do i have|have i got) the most wins with$/i.test(subject);
  const games =
    /^who (?:have i|did i|do i) (?:played|play|teamed up|team up) with (?:the )?most$/i.test(
      subject
    ) ||
    /^which teammate (?:have i|did i|do i) (?:played|play) with (?:the )?most$/i.test(
      subject
    ) ||
    /^who (?:is|was) my most (?:common|frequent) teammate$/i.test(subject) ||
    /^who(?:'s| is) my most played(?: with)? teammate$/i.test(subject);
  return wins || games ? { metric: wins ? "wins" : "games", season } : null;
}

/** Read only finished games for the caller, using stable player IDs across renames. */
export async function answerTeammateHistory(
  discordUserId: string,
  request: TeammateRequest
): Promise<string> {
  const player = await prismaClient.player.findUnique({
    where: { discordSnowflake: discordUserId },
    select: { id: true },
  });
  if (!player) return "I couldn't find your linked player record.";
  const season =
    request.season === "all"
      ? null
      : request.season === "active"
        ? await SeasonService.getActiveSeason()
        : await prismaClient.season.findUnique({
            where: { number: request.season },
          });
  if (request.season !== "all" && !season)
    return "I couldn't find that season.";
  const scope = season ? `season ${season.number}` : "all recorded seasons";
  const own = await prismaClient.gameParticipation.findMany({
    where: {
      playerId: player.id,
      ...(season ? { seasonId: season.id } : {}),
      team: { in: [Team.RED, Team.BLUE] },
      game: { is: { finished: true, winner: { in: [Team.RED, Team.BLUE] } } },
    },
    select: { gameId: true, team: true, game: { select: { winner: true } } },
    take: MAX_GAMES + 1,
  });
  if (own.length > MAX_GAMES)
    return "Your all-time teammate history is too large for a safe lookup. Ask for a specific season.";
  if (!own.length) return `I found no finished team games for you in ${scope}.`;

  const ownByGame = new Map(own.map((row) => [row.gameId, row]));
  const rows = await prismaClient.gameParticipation.findMany({
    where: {
      playerId: { not: player.id },
      OR: [Team.RED, Team.BLUE].map((team) => ({
        team,
        gameId: {
          in: own.filter((row) => row.team === team).map((row) => row.gameId),
        },
      })),
    },
    select: { playerId: true, gameId: true, team: true },
    take: MAX_ROWS + 1,
  });
  if (rows.length > MAX_ROWS)
    return "There are too many teammate records for a complete safe lookup. Ask for a specific season.";

  const counts = new Map<string, { games: number; wins: number }>();
  for (const row of rows) {
    const game = ownByGame.get(row.gameId);
    if (!game || row.team !== game.team || row.playerId === player.id) continue;
    const count = counts.get(row.playerId) ?? { games: 0, wins: 0 };
    count.games++;
    if (game.game.winner === game.team) count.wins++;
    counts.set(row.playerId, count);
  }
  const top = Math.max(
    0,
    ...Array.from(counts.values(), (row) => row[request.metric])
  );
  if (!top)
    return `I found no ${request.metric === "wins" ? "shared wins" : "teammate games"} for you in ${scope}.`;
  const leaders = [...counts.entries()].filter(
    ([, row]) => row[request.metric] === top
  );
  // Bound output and do not silently treat tied players as a single winner.
  const shown = leaders.slice(0, 5);
  const names = await prismaClient.player.findMany({
    where: { id: { in: shown.map(([id]) => id) } },
    select: { id: true, latestIGN: true },
  });
  const byId = new Map(names.map((row) => [row.id, row.latestIGN]));
  const labels = shown.map(([id, count]) => {
    const ign = byId.get(id);
    return `${ign && /^[a-zA-Z0-9_]{3,16}$/.test(ign) ? ign : "Unknown player"} (${count.wins} wins in ${count.games} games together)`;
  });
  return `Your ${request.metric === "wins" ? "most wins with a teammate" : "most games with a teammate"} in ${scope}:\n${labels.join("\n")}${leaders.length > shown.length ? `\nPlus ${leaders.length - shown.length} other tied players.` : ""}\nBased on finished FW games in the bot's database.`;
}
