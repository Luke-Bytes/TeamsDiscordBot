import { prismaClient } from "../../database/prismaClient";
import { ConfigManager } from "../../ConfigManager";
import {
  DEFAULT_MAX_BLOCK_LENGTH,
  DEFAULT_SEASON_RECAP_THRESHOLDS,
  DISCORD_HARD_LIMIT,
  GenerateOptions,
  InsightSection,
  SeasonRecapData,
  SeasonRecapGameSettings,
  SeasonRecapPlayer,
  SeasonRecapResult,
} from "./types";
import {
  formatDateRange,
  formatSection,
  splitDiscordBlocks,
} from "./formatting";
import { buildSeasonRecapModel } from "./model";
import {
  buildCaptainImpact,
  buildEloStorylines,
  buildFormTrends,
  buildMvpTrends,
  buildSnapshot,
} from "./playerSections";
import { buildDuoChemistry, buildRivalries } from "./relationshipSections";
import {
  buildBanTrends,
  buildCommunityOps,
  buildDurationStories,
  buildGameTypeAndModifierInsights,
  buildMapInsights,
  buildUpsetsAndCloseGames,
} from "./gameSections";

export {
  DEFAULT_SEASON_RECAP_THRESHOLDS,
  type GenerateOptions,
  type SeasonRecapData,
  type SeasonRecapGame,
  type SeasonRecapGameSettings,
  type SeasonRecapResult,
  type SeasonRecapThresholds,
} from "./types";

export async function generateSeasonRecap(
  options: GenerateOptions = {}
): Promise<SeasonRecapResult> {
  const seasonNumber = options.seasonNumber ?? ConfigManager.getConfig().season;
  const season = await prismaClient.season.findUnique({
    where: { number: seasonNumber },
  });

  if (!season) {
    throw new Error(`Season ${seasonNumber} not found.`);
  }

  const [games, playerStats, histories] = await Promise.all([
    prismaClient.game.findMany({
      where: { seasonId: season.id, finished: true },
      include: {
        gameParticipations: {
          include: {
            player: {
              select: {
                id: true,
                latestIGN: true,
                discordSnowflake: true,
              },
            },
          },
        },
      },
      orderBy: { startTime: "asc" },
    }),
    prismaClient.playerStats.findMany({
      where: { seasonId: season.id },
      include: {
        player: {
          select: {
            id: true,
            latestIGN: true,
            discordSnowflake: true,
          },
        },
      },
    }),
    prismaClient.eloHistory.findMany({
      where: { seasonId: season.id },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return generateSeasonRecapFromData(
    {
      seasonNumber,
      games: games.map((game) => ({
        id: game.id,
        finished: game.finished,
        startTime: game.startTime,
        endTime: game.endTime,
        settings: game.settings as SeasonRecapGameSettings,
        winner: game.winner,
        type: game.type,
        doubleElo: game.doubleElo,
        organiser: game.organiser,
        host: game.host,
        gameParticipations: game.gameParticipations.map((gp) => ({
          playerId: gp.playerId,
          ignUsed: gp.ignUsed,
          team: gp.team,
          mvp: gp.mvp,
          captain: gp.captain,
          draftSlotPlacement: gp.draftSlotPlacement,
          votedForAMVP: gp.votedForAMVP,
          player: gp.player,
        })),
      })),
      playerStats,
      histories,
    },
    options
  );
}

export function generateSeasonRecapFromData(
  data: SeasonRecapData,
  options: Omit<GenerateOptions, "seasonNumber"> = {}
): SeasonRecapResult {
  const thresholds = {
    ...DEFAULT_SEASON_RECAP_THRESHOLDS,
    ...options.thresholds,
  };
  const maxBlockLength = Math.min(
    options.maxBlockLength ?? DEFAULT_MAX_BLOCK_LENGTH,
    DISCORD_HARD_LIMIT
  );
  const games = data.games
    .filter((game) => game.finished)
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const playerById = collectPlayers(data, games);
  const uniquePlayers = new Set(
    games.flatMap((game) => game.gameParticipations.map((gp) => gp.playerId))
  );
  const dateRange = formatDateRange(games);
  const effectiveMinPlayerGames = Math.min(
    Math.max(
      thresholds.minPlayerGames,
      Math.ceil(games.length * thresholds.minPlayerSeasonShare)
    ),
    Math.max(1, games.length)
  );

  const model = buildSeasonRecapModel(games, data.histories, thresholds);
  const skippedSections: string[] = [];
  const sections = buildSections({
    data,
    games,
    playerById,
    model,
    thresholds,
    dateRange,
    playerCount: uniquePlayers.size,
    effectiveMinPlayerGames,
  }).filter((section): section is InsightSection => {
    if (!section) return false;
    if (!section.lines.length) {
      skippedSections.push(section.title);
      return false;
    }
    return true;
  });

  const body = sections.map(formatSection).join("\n\n");
  const splitLength = Math.max(100, maxBlockLength - 20);
  const blocks = splitDiscordBlocks(body, splitLength).map((block, idx, all) =>
    all.length > 1 ? `${block}\n\n_${idx + 1}/${all.length}_` : block
  );

  return {
    seasonNumber: data.seasonNumber,
    blocks,
    summary: {
      games: games.length,
      players: uniquePlayers.size,
      dateRange,
      skippedSections,
    },
  };
}

function buildSections(context: {
  data: SeasonRecapData;
  games: SeasonRecapData["games"];
  playerById: Map<string, SeasonRecapPlayer>;
  model: ReturnType<typeof buildSeasonRecapModel>;
  thresholds: typeof DEFAULT_SEASON_RECAP_THRESHOLDS;
  dateRange: string;
  playerCount: number;
  effectiveMinPlayerGames: number;
}) {
  const {
    data,
    games,
    playerById,
    model,
    thresholds,
    dateRange,
    playerCount,
    effectiveMinPlayerGames,
  } = context;

  return [
    buildSnapshot(data.seasonNumber, games, playerCount, dateRange),
    buildEloStorylines(
      data.playerStats,
      data.histories,
      model.outcomesByPlayer,
      playerById,
      thresholds,
      effectiveMinPlayerGames
    ),
    buildFormTrends(
      data.playerStats,
      model.outcomesByPlayer,
      playerById,
      thresholds,
      effectiveMinPlayerGames
    ),
    buildCaptainImpact(model.outcomesByPlayer, playerById, thresholds),
    buildMvpTrends(
      model.outcomesByPlayer,
      playerById,
      thresholds,
      effectiveMinPlayerGames
    ),
    buildDuoChemistry(games, playerById, thresholds),
    buildRivalries(games, playerById, thresholds),
    buildMapInsights(
      games,
      model.outcomesByPlayer,
      playerById,
      thresholds,
      effectiveMinPlayerGames
    ),
    buildBanTrends(games, thresholds),
    buildGameTypeAndModifierInsights(games),
    buildUpsetsAndCloseGames(games, model, playerById, thresholds),
    buildDurationStories(games, model.outcomesByPlayer, playerById, thresholds),
    buildCommunityOps(games, thresholds),
  ];
}

function collectPlayers(
  data: SeasonRecapData,
  games: SeasonRecapData["games"]
) {
  const playerById = new Map<string, SeasonRecapPlayer>();
  for (const stats of data.playerStats) {
    if (stats.player) playerById.set(stats.playerId, stats.player);
  }
  for (const game of games) {
    for (const gp of game.gameParticipations) {
      if (gp.player) playerById.set(gp.playerId, gp.player);
    }
  }
  return playerById;
}
