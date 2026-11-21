import { SeasonType } from "@prisma/client";
import { prismaClient } from "../database/prismaClient";
import { SeasonService } from "../database/SeasonService";
import { AiFunctionTool } from "./AiProvider";
import {
  getCurrentGameStateSnapshot,
  getOrganiserGameSnapshot,
} from "./GameReadSnapshot";
import {
  HistoricalStatsClient,
  validHistoricalIgn,
  validHistoricalSeason,
  validHistoricalLimit,
} from "./HistoricalStatsClient";

/** Authorisation is re-evaluated from Discord guild membership for every tool call. */
export type AiCaller = {
  discordUserId: string;
  guildId: string;
  verifyMembership: () => Promise<{ member: boolean; organiser: boolean }>;
};

export const AI_TOOLS: AiFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "get_my_stats",
      description:
        "Public saved season wins, losses, streaks and Ranked Elo/rank for MY Discord-linked player. Optional season (default active). No MVP breakdown, live-match status or historical REST_API evidence. Missing player/season/stats is not zero.",
      parameters: {
        type: "object",
        properties: { season: { type: "integer", minimum: 1, maximum: 10000 } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_player_stats",
      description:
        "Public saved season wins, losses, streaks and Ranked Elo/rank for a named player's latest exact Minecraft IGN. Required ign, optional season (default active). No old aliases, match details or live game state; missing or ambiguous records are not zero.",
      parameters: {
        type: "object",
        properties: {
          ign: {
            type: "string",
            minLength: 3,
            maxLength: 16,
            pattern: "^[A-Za-z0-9_]{3,16}$",
          },
          season: { type: "integer", minimum: 1, maximum: 10000 },
        },
        required: ["ign"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_leaderboard",
      description:
        "Public saved leaderboard for an optional season (default active), optional limit 1-10 (default 5). Returns player entries with Elo order for Ranked, wins/streak activity for Relaxed (no Elo champion). Not full history; unknown season returns season_not_found.",
      parameters: {
        type: "object",
        properties: {
          season: { type: "integer", minimum: 1, maximum: 10000 },
          limit: { type: "integer", minimum: 1, maximum: 10 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_season_summary",
      description:
        "Public saved season type, active flag, finished-game count and game/month/rollover limits. Optional season (default active). A rollover date is not a game start time; not a live-match snapshot. Unknown season returns season_not_found.",
      parameters: {
        type: "object",
        properties: { season: { type: "integer", minimum: 1, maximum: 10000 } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_games",
      description:
        "Public last saved finished games: end timestamps and winning teams only. Optional season (default active), limit 1-5 (default 3). Does not show unsaved current game, rosters or Elo changes; unknown season returns season_not_found.",
      parameters: {
        type: "object",
        properties: {
          season: { type: "integer", minimum: 1, maximum: 10000 },
          limit: { type: "integer", minimum: 1, maximum: 5 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_game_diagnostics",
      description:
        "Verified organisers only; no inputs. Legacy compatibility alias of get_current_game_state's organiser process snapshot: lifecycle, teams, captain/ban/poll/timer/recovery flags. Prefer get_current_game_state for new questions; neither proves saved results or Discord delivery.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_organiser_status",
      description:
        "Verified organisers only; no inputs. Read saved active-season type, limits, finished-game count and pending announcement blocks. For rollover status, not live game state or proof of Discord delivery; unavailable read is not zero.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_current_game_state",
      description:
        "Preferred no-input current-game tool for all players and verified organisers. Returns one process-memory lifecycle/registration/team/settings snapshot; organisers also receive filtered readiness, captain, poll, timer and recovery flags. No player IDs, live Discord verification or saved-result proof; not for historical statistics.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_historical_seasons",
      description:
        "Conditional public REST_API history tool; no inputs. Lists up to 20 validated season numbers/types/active flags with truncation indicator. Not a complete archive guarantee or current bot season view; unavailable if history is disabled or invalid.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_historical_player_stats",
      description:
        "Conditional public REST_API historical stats for exact latest ign and required season: wins/losses/streaks, Ranked-only Elo. Use only for named past records, not current-game status; for MY stats use get_my_historical_stats. Missing is not_found, errors unavailable.",
      parameters: {
        type: "object",
        properties: {
          ign: { type: "string", minLength: 3, maxLength: 16 },
          season: { type: "integer", minimum: 1, maximum: 10000 },
        },
        required: ["ign", "season"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_historical_stats",
      description:
        "Conditional public historical REST_API season wins/losses/streaks and Ranked Elo for MY server-resolved linked IGN. Required season, no model-supplied IGN. Missing link/record is not_found, failed read unavailable; not for current in-progress games.",
      parameters: {
        type: "object",
        properties: { season: { type: "integer", minimum: 1, maximum: 10000 } },
        required: ["season"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_historical_elo",
      description:
        "Conditional public historical REST_API Ranked Elo observations and observed change for exact ign, required season, optional limit 2-20 (default 12). Not a full match audit or guaranteed season endpoints. Relaxed is unsupported; missing/unavailable is not zero. For MY Elo use get_my_historical_elo.",
      parameters: {
        type: "object",
        properties: {
          ign: { type: "string", minLength: 3, maxLength: 16 },
          season: { type: "integer", minimum: 1, maximum: 10000 },
          limit: { type: "integer", minimum: 2, maximum: 20 },
        },
        required: ["ign", "season"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_historical_elo",
      description:
        "Conditional public historical REST_API Ranked Elo observations for MY server-resolved IGN. Required season, optional limit 2-20 (default 12); no IGN input. Not a full match audit. Relaxed unsupported; missing/unavailable is not zero.",
      parameters: {
        type: "object",
        properties: {
          season: { type: "integer", minimum: 1, maximum: 10000 },
          limit: { type: "integer", minimum: 2, maximum: 20 },
        },
        required: ["season"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_historical_season_summary",
      description:
        "Conditional public REST_API summary for required historical season: type, observed finished-game count and dates from up to 200 game records. Not proof of complete upstream history; oversized/invalid history is unavailable, not a partial count.",
      parameters: {
        type: "object",
        properties: { season: { type: "integer", minimum: 1, maximum: 10000 } },
        required: ["season"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_historical_comparison",
      description:
        "Conditional public historical REST_API comparison for MY server-resolved IGN: required distinct firstSeason and secondSeason. Returns two seasonal stats and second-minus-first wins/losses and Ranked-only Elo differences. Not match-by-match progression; missing/failed reads cannot become zero.",
      parameters: {
        type: "object",
        properties: {
          firstSeason: { type: "integer", minimum: 1, maximum: 10000 },
          secondSeason: { type: "integer", minimum: 1, maximum: 10000 },
        },
        required: ["firstSeason", "secondSeason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_historical_comparison",
      description:
        "Conditional public REST_API comparison for a named latest exact ign and two distinct required seasons. Returns seasonal wins/losses and Ranked-only Elo differences, not Elo change between matches. Missing/failed read is not zero; for MY record use get_my_historical_comparison.",
      parameters: {
        type: "object",
        properties: {
          ign: { type: "string", minLength: 3, maxLength: 16 },
          firstSeason: { type: "integer", minimum: 1, maximum: 10000 },
          secondSeason: { type: "integer", minimum: 1, maximum: 10000 },
        },
        required: ["ign", "firstSeason", "secondSeason"],
        additionalProperties: false,
      },
    },
  },
];

const ORGANISER_TOOLS = new Set([
  "get_organiser_status",
  "get_game_diagnostics",
]);

/** Send only authorised and operator-enabled schemas to the provider. */
export function permittedAiTools(
  organiser: boolean,
  historicalEnabled = new HistoricalStatsClient().enabled
): AiFunctionTool[] {
  return AI_TOOLS.filter(
    (tool) =>
      (organiser || !ORGANISER_TOOLS.has(tool.function.name)) &&
      (historicalEnabled ||
        !(
          tool.function.name.includes("historical_") ||
          tool.function.name === "list_historical_seasons"
        ))
  );
}

export class AiToolDenied extends Error {
  constructor() {
    super("Tool request denied");
  }
}

function parseArguments(name: string, raw: string): Record<string, unknown> {
  const tool = AI_TOOLS.find((entry) => entry.function.name === name);
  if (!tool || raw.length > 2000) throw new AiToolDenied();
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    throw new AiToolDenied();
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new AiToolDenied();
  const obj = args as Record<string, unknown>;
  const allowed =
    name === "get_player_stats" || name === "get_historical_player_stats"
      ? ["ign", "season"]
      : name === "get_historical_elo"
        ? ["ign", "season", "limit"]
        : name === "get_my_historical_elo"
          ? ["season", "limit"]
          : name === "get_historical_comparison"
            ? ["ign", "firstSeason", "secondSeason"]
            : name === "get_my_historical_comparison"
              ? ["firstSeason", "secondSeason"]
              : name === "get_leaderboard" || name === "get_recent_games"
                ? ["season", "limit"]
                : ORGANISER_TOOLS.has(name) ||
                    name === "get_current_game_state" ||
                    name === "list_historical_seasons"
                  ? []
                  : ["season"];
  if (Object.keys(obj).some((key) => !allowed.includes(key)))
    throw new AiToolDenied();
  if (
    obj.season !== undefined &&
    (!Number.isInteger(obj.season) ||
      Number(obj.season) < 1 ||
      Number(obj.season) > 10000)
  )
    throw new AiToolDenied();
  const maxLimit =
    name === "get_recent_games"
      ? 5
      : name === "get_historical_elo" || name === "get_my_historical_elo"
        ? 20
        : 10;
  if (
    obj.limit !== undefined &&
    (!Number.isInteger(obj.limit) ||
      Number(obj.limit) < 1 ||
      Number(obj.limit) > maxLimit)
  )
    throw new AiToolDenied();
  if (name === "get_player_stats" && !validHistoricalIgn(obj.ign))
    throw new AiToolDenied();
  if (
    [
      "get_historical_player_stats",
      "get_historical_elo",
      "get_historical_comparison",
    ].includes(name) &&
    !validHistoricalIgn(obj.ign)
  )
    throw new AiToolDenied();
  if (
    [
      "get_historical_player_stats",
      "get_my_historical_stats",
      "get_historical_elo",
      "get_my_historical_elo",
      "get_historical_season_summary",
    ].includes(name) &&
    !validHistoricalSeason(obj.season)
  )
    throw new AiToolDenied();
  if (
    ["get_historical_comparison", "get_my_historical_comparison"].includes(
      name
    ) &&
    (!validHistoricalSeason(obj.firstSeason) ||
      !validHistoricalSeason(obj.secondSeason) ||
      obj.firstSeason === obj.secondSeason)
  )
    throw new AiToolDenied();
  if (
    ["get_historical_elo", "get_my_historical_elo"].includes(name) &&
    obj.limit !== undefined &&
    !validHistoricalLimit(obj.limit)
  )
    throw new AiToolDenied();
  return obj;
}

async function getSeason(number?: number) {
  if (number !== undefined) {
    return prismaClient.season.findUnique({ where: { number } });
  }
  return SeasonService.getActiveSeason();
}

function publicSeason(season: {
  number: number;
  type: SeasonType | null;
  isActive: boolean;
  gameLimit: number | null;
  monthLimit: number | null;
  rolloverDeadline: Date | null;
  firstRolloverAt: Date | null;
}) {
  return {
    season: season.number,
    type: season.type ?? SeasonType.RANKED,
    active: season.isActive,
    gameLimit: season.gameLimit,
    monthLimit: season.monthLimit,
    rolloverDeadline: season.rolloverDeadline?.toISOString() ?? null,
    scheduledFirstRollover: season.firstRolloverAt?.toISOString() ?? null,
    deadlineIsEstimated:
      !season.firstRolloverAt && Boolean(season.rolloverDeadline),
  };
}

async function statsFor(
  player: { id: string; latestIGN: string | null },
  seasonNumber?: number
) {
  const season = await getSeason(seasonNumber);
  if (!season) return { status: "season_not_found" };
  const stats = await prismaClient.playerStats.findUnique({
    where: { playerId_seasonId: { playerId: player.id, seasonId: season.id } },
    select: {
      wins: true,
      losses: true,
      elo: true,
      winStreak: true,
      loseStreak: true,
    },
  });
  if (!stats) return { status: "no_stats", season: season.number };
  const ranked = season.type !== SeasonType.RELAXED;
  const rank = ranked
    ? 1 +
      (await prismaClient.playerStats.count({
        where: { seasonId: season.id, elo: { gt: stats.elo } },
      }))
    : null;
  return {
    status: "ok",
    player: player.latestIGN ?? "Unknown",
    season: season.number,
    type: season.type ?? SeasonType.RANKED,
    wins: stats.wins,
    losses: stats.losses,
    winStreak: stats.winStreak,
    loseStreak: stats.loseStreak,
    elo: ranked ? stats.elo : null,
    rank,
    ranking: ranked ? "Elo" : "unranked",
  };
}

/** Only this function touches the database. No model-controlled Prisma filters or writes. */
export async function executeAiTool(
  name: string,
  rawArguments: string,
  caller: AiCaller,
  historicalClient?: HistoricalStatsClient
): Promise<unknown> {
  if (!caller.guildId || !caller.discordUserId) throw new AiToolDenied();
  const args = parseArguments(name, rawArguments);
  const permission = await caller.verifyMembership();
  if (
    !permission.member ||
    (ORGANISER_TOOLS.has(name) && !permission.organiser)
  )
    throw new AiToolDenied();
  const requestedSeason = args.season as number | undefined;
  const history = historicalClient ?? new HistoricalStatsClient();
  const selfIgn = async () => {
    const player = await prismaClient.player.findUnique({
      where: { discordSnowflake: caller.discordUserId },
      select: { latestIGN: true },
    });
    return validHistoricalIgn(player?.latestIGN) ? player.latestIGN : null;
  };
  switch (name) {
    case "get_current_game_state":
      return getCurrentGameStateSnapshot(
        permission.organiser ? "organiser" : "player"
      );
    case "list_historical_seasons":
      return history.listSeasons();
    case "get_historical_player_stats":
      return history.playerStats(args.ign as string, requestedSeason!);
    case "get_my_historical_stats": {
      const ign = await selfIgn();
      return ign
        ? history.playerStats(ign, requestedSeason!)
        : {
            status: "not_found",
            source: "REST_API historical stats",
            detail: "linked_minecraft_identity_unavailable",
          };
    }
    case "get_historical_elo":
      return history.elo(
        args.ign as string,
        requestedSeason!,
        (args.limit as number | undefined) ?? 12
      );
    case "get_my_historical_elo": {
      const ign = await selfIgn();
      return ign
        ? history.elo(
            ign,
            requestedSeason!,
            (args.limit as number | undefined) ?? 12
          )
        : {
            status: "not_found",
            source: "REST_API historical stats",
            detail: "linked_minecraft_identity_unavailable",
          };
    }
    case "get_historical_season_summary":
      return history.seasonSummary(requestedSeason!);
    case "get_my_historical_comparison": {
      const ign = await selfIgn();
      return ign
        ? history.compare(
            ign,
            args.firstSeason as number,
            args.secondSeason as number
          )
        : {
            status: "not_found",
            source: "REST_API historical stats",
            detail: "linked_minecraft_identity_unavailable",
          };
    }
    case "get_historical_comparison":
      return history.compare(
        args.ign as string,
        args.firstSeason as number,
        args.secondSeason as number
      );
    case "get_my_stats": {
      const player = await prismaClient.player.findUnique({
        where: { discordSnowflake: caller.discordUserId },
        select: { id: true, latestIGN: true },
      });
      return player
        ? statsFor(player, requestedSeason)
        : { status: "player_not_found" };
    }
    case "get_player_stats": {
      const matches = await prismaClient.player.findMany({
        where: {
          latestIGN: { equals: args.ign as string, mode: "insensitive" },
        },
        select: { id: true, latestIGN: true },
        take: 2,
      });
      if (matches.length > 1) return { status: "ambiguous_player" };
      return matches.length
        ? statsFor(matches[0], requestedSeason)
        : { status: "player_not_found" };
    }
    case "get_leaderboard": {
      const season = await getSeason(requestedSeason);
      if (!season) return { status: "season_not_found" };
      const ranked = season.type !== SeasonType.RELAXED;
      const entries = await prismaClient.playerStats.findMany({
        where: { seasonId: season.id },
        take: (args.limit as number | undefined) ?? 5,
        orderBy: ranked
          ? [{ elo: "desc" }]
          : [{ wins: "desc" }, { biggestWinStreak: "desc" }],
        select: {
          wins: true,
          losses: true,
          elo: true,
          winStreak: true,
          player: { select: { latestIGN: true } },
        },
      });
      return {
        status: "ok",
        season: season.number,
        type: ranked ? "RANKED" : "RELAXED",
        orderedBy: ranked ? "Elo" : "wins then biggest streak",
        notes: ranked ? "Elo ranking" : "Activity board; no Elo champion",
        entries: entries.map((entry, index) => ({
          position: index + 1,
          player: entry.player?.latestIGN ?? "Unknown",
          wins: entry.wins,
          losses: entry.losses,
          winStreak: entry.winStreak,
          elo: ranked ? entry.elo : null,
        })),
      };
    }
    case "get_season_summary": {
      const season = await getSeason(requestedSeason);
      if (!season) return { status: "season_not_found" };
      const finishedGames = await prismaClient.game.count({
        where: { seasonId: season.id, finished: true },
      });
      return { status: "ok", ...publicSeason(season), finishedGames };
    }
    case "get_recent_games": {
      const season = await getSeason(requestedSeason);
      if (!season) return { status: "season_not_found" };
      const games = await prismaClient.game.findMany({
        where: { seasonId: season.id, finished: true },
        orderBy: { endTime: "desc" },
        take: (args.limit as number | undefined) ?? 3,
        select: { endTime: true, winner: true },
      });
      return {
        status: "ok",
        season: season.number,
        games: games.map((game) => ({
          endedAt: game.endTime.toISOString(),
          winner: game.winner,
        })),
      };
    }
    case "get_game_diagnostics":
      return getOrganiserGameSnapshot();
    case "get_organiser_status": {
      const status = await SeasonService.getStatus();
      return {
        status: "ok",
        ...publicSeason(status.season),
        finishedGames: status.finishedGames,
        pendingAnnouncements: status.pendingAnnouncements,
      };
    }
    default:
      throw new AiToolDenied();
  }
}
