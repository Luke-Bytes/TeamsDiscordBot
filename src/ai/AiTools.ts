import { SeasonType } from "@prisma/client";
import type { MentionedPlayer } from "./AiPlayerReferences";
import { prismaClient } from "../database/prismaClient";
import { SeasonService } from "../database/SeasonService";
import { getSavedPlayerCareerStats } from "../logic/PlayerCareerStats";
import { getPlayerPerformanceShortlist } from "./PlayerPerformanceShortlist";
import { AiFunctionTool } from "./AiProvider";
import {
  searchTournamentMatches,
  validTournamentSearchQuery,
} from "./TournamentMatchSearch";
import { getGameOrganiserRoster } from "./GameOrganiserReads";
import { getGamePersistenceDiagnostics } from "./GamePersistenceRead";
import type { DiscordDiagnosticFocus } from "./GameDiscordRead";
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
  /** Checks a mentioned member in the home guild, then reads their linked IGN. */
  resolveMentionedPlayer?: (discordUserId: string) => Promise<MentionedPlayer>;
  /** Optional trusted Discord-role lookup; never takes a role ID from the model. */
  listCommands?: () => Promise<{
    status: "ok" | "unavailable";
    commands?: string[];
    /** Exact slash paths from registered Discord command definitions. */
    paths?: string[];
    total?: number;
    truncated?: boolean;
  }>;
  listOrganisers?: () => Promise<{
    status: "ok" | "unavailable";
    names?: string[];
    total?: number;
    truncated?: boolean;
  }>;
  /** Server-bound, authorised targeted Discord checks; not a model-selected guild. */
  inspectGameDiscord?: (
    focus: DiscordDiagnosticFocus,
    targetIGN?: string
  ) => Promise<unknown>;
};

export const AI_TOOLS: AiFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "search_tournament_matches",
      description:
        "Search a reviewed, incomplete PUBLIC Shotbow Annihilation / Friendly Wars tournament MATCH and video archive. For remembered games (even wrong map/year), use text with the user's wording; optional team, opponent, map, year, stage or uploader can narrow ranking. Results distinguish source-backed matches (including four-clan events), unknown maps/outcomes, unverified stream timestamps and community-reported FW placements. Use offset=nextOffset for more ranked matches; results are partial, not a complete tournament bracket. Not a live FW game search or internet browser.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 240 },
          team: { type: "string", minLength: 1, maxLength: 64 },
          opponent: { type: "string", minLength: 1, maxLength: 64 },
          map: { type: "string", minLength: 1, maxLength: 64 },
          tournament: { type: "string", minLength: 1, maxLength: 64 },
          stage: { type: "string", minLength: 1, maxLength: 64 },
          uploader: { type: "string", minLength: 1, maxLength: 64 },
          year: { type: "integer", minimum: 2010, maximum: 2100 },
          fromYear: { type: "integer", minimum: 2010, maximum: 2100 },
          toYear: { type: "integer", minimum: 2010, maximum: 2100 },
          limit: { type: "integer", minimum: 1, maximum: 6 },
          offset: { type: "integer", minimum: 0, maximum: 1000 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_command_catalog",
      description:
        "Read currently registered FW slash-command names and brief descriptions from Discord. Commands may require a role, channel or game stage; a failed or truncated read is not a complete available-command list.",
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
      name: "list_organisers",
      description:
        "List public display names of current FW organiser-role members, from a fresh Discord guild read. No private IDs or member details; unavailable or truncated results must not be presented as a complete roster.",
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
      name: "get_all_time_leaderboard",
      description:
        "Top 10 by TOTAL saved wins across all bot seasons (Ranked and Relaxed combined), with losses and games. No universal 'best' player or highest all-time Elo claim; archived REST_API-only history is not included.",
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
      name: "get_player_performance_shortlist",
      description:
        "For best FW players or draft picks WITHOUT named candidates: bounded multi-metric career, current Ranked Elo/activity and finished-game MVP shortlist. Optional minGames/maxGames filter actual wins+losses within a sampled pool, NOT all players. focus=mvps provides the highest recorded MVP totals, NOT a skill ranking. Not an eligible live roster; use get_game_roster for current registrations. Do not claim universal completeness.",
      parameters: {
        type: "object",
        properties: {
          minGames: { type: "integer", minimum: 0, maximum: 5000 },
          maxGames: { type: "integer", minimum: 0, maximum: 5000 },
          focus: { type: "string", minLength: 4, maxLength: 4, enum: ["mvps"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_all_time_stats",
      description:
        "Public lifetime saved bot stats for MY linked Discord player across ALL seasons: wins, losses, win rate, MVPs, captain games/wins, double Elo wins, largest within-season streaks, best saved Ranked season rating and last game. No season input or model-supplied identity; not external REST_API history or an in-progress match.",
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
      name: "get_player_all_time_stats",
      description:
        "Public lifetime saved bot stats for a named player's latest exact Minecraft IGN across ALL seasons: wins/losses, win rate, MVPs, captain record, best within-season streaks and saved Ranked rating. Required exact ign; not current-season-only, old aliases, REST_API-only archive or live gameplay.",
      parameters: {
        type: "object",
        properties: {
          ign: {
            type: "string",
            minLength: 3,
            maxLength: 16,
            pattern: "^[A-Za-z0-9_]{3,16}$",
          },
        },
        required: ["ign"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_stats",
      description:
        "Public saved season wins, losses, streaks and Ranked Elo/rank for MY Discord-linked player. Optional season (default active), with up to 10 recent saved season records for context when season is omitted. No MVP breakdown, live-match status or historical REST_API evidence. Missing player/season/stats is not zero.",
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
        "Public saved season wins, losses, streaks and Ranked Elo/rank for a named player's latest exact Minecraft IGN. Required ign, optional season (default active), with up to 10 saved seasons automatically checked when season is omitted. No old aliases, match details or live game state; missing or ambiguous records are not zero.",
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
        "Public saved leaderboard for an optional season (default active), optional limit 1-10 (default 10). Returns player entries with Elo order for Ranked, wins/streak activity for Relaxed (no Elo champion). Not full history; unknown season returns season_not_found.",
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
        "Public last saved finished games: end timestamps and winning teams only. Optional season (default active), limit 1-5 (default 5). Does not show unsaved current game, rosters or Elo changes; unknown season returns season_not_found.",
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
      name: "get_game_roster",
      description:
        "Verified organisers only; exact latest IGN names in RED/BLUE/UNDECIDED (up to 24), captain ban counts and names, live or paused draft progress, recorded bans, in-memory winner and MVP progress. Process memory only; not a Discord verification.",
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
      name: "get_game_discord_state",
      description:
        "Verified organisers only; targeted Discord checks. focus=players checks up to 16 assigned roster members, or one exact current-roster targetIGN, for fresh REST roles and gateway-cache voice; polls/announcement check referenced messages. Partial reads never prove an entire Discord operation succeeded.",
      parameters: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            enum: ["players", "polls", "announcement"],
            minLength: 5,
            maxLength: 12,
          },
          targetIGN: {
            type: "string",
            minLength: 3,
            maxLength: 16,
            pattern: "^[A-Za-z0-9_]{3,16}$",
          },
        },
        required: ["focus"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_game_persistence",
      description:
        "Verified organisers only; exact current match ID database lookup of finished result fingerprint and PENDING/COMPLETE cleanup checkpoint. Never assumes no record means a failed transaction; never recommends blind retry after uncertain shutdown. Does not verify actual Discord cleanup.",
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
  "get_game_roster",
  "get_game_discord_state",
  "get_game_persistence",
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
    name === "search_tournament_matches"
      ? [
          "text",
          "team",
          "opponent",
          "map",
          "tournament",
          "stage",
          "uploader",
          "year",
          "fromYear",
          "toYear",
          "limit",
        ]
      : name === "get_game_discord_state"
        ? ["focus", "targetIGN"]
        : name === "get_player_performance_shortlist"
          ? ["minGames", "maxGames", "focus"]
          : name === "get_player_stats" ||
              name === "get_historical_player_stats"
            ? ["ign", "season"]
            : name === "get_player_all_time_stats"
              ? ["ign"]
              : name === "get_historical_elo"
                ? ["ign", "season", "limit"]
                : name === "get_my_historical_elo"
                  ? ["season", "limit"]
                  : name === "get_historical_comparison"
                    ? ["ign", "firstSeason", "secondSeason"]
                    : name === "get_my_historical_comparison"
                      ? ["firstSeason", "secondSeason"]
                      : name === "get_leaderboard" ||
                          name === "get_recent_games"
                        ? ["season", "limit"]
                        : ORGANISER_TOOLS.has(name) ||
                            name === "get_current_game_state" ||
                            name === "list_historical_seasons" ||
                            name === "list_organisers" ||
                            name === "get_command_catalog" ||
                            name === "get_all_time_leaderboard" ||
                            name === "get_my_all_time_stats"
                          ? []
                          : ["season"];
  if (Object.keys(obj).some((key) => !allowed.includes(key)))
    throw new AiToolDenied();
  if (name === "search_tournament_matches" && !validTournamentSearchQuery(obj))
    throw new AiToolDenied();
  if (name === "get_player_performance_shortlist") {
    if (
      [obj.minGames, obj.maxGames].some(
        (value) =>
          value !== undefined &&
          (!Number.isInteger(value) ||
            Number(value) < 0 ||
            Number(value) > 5000)
      ) ||
      (obj.focus !== undefined && obj.focus !== "mvps") ||
      (obj.minGames !== undefined &&
        obj.maxGames !== undefined &&
        Number(obj.minGames) > Number(obj.maxGames))
    )
      throw new AiToolDenied();
  }
  if (name === "get_game_discord_state") {
    if (!["players", "polls", "announcement"].includes(obj.focus as string))
      throw new AiToolDenied();
    if (
      obj.targetIGN !== undefined &&
      (obj.focus !== "players" || !validHistoricalIgn(obj.targetIGN))
    )
      throw new AiToolDenied();
  }
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
  if (
    (name === "get_player_stats" || name === "get_player_all_time_stats") &&
    !validHistoricalIgn(obj.ign)
  )
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

/** Bounded cross-season context prevents 'no stats this season' from hiding old records. */
async function otherSeasonStats(playerId: string) {
  const records = await prismaClient.playerStats.findMany({
    where: { playerId },
    orderBy: { createdAt: "desc" },
    take: 11,
    select: {
      wins: true,
      losses: true,
      elo: true,
      season: { select: { number: true, type: true } },
    },
  });
  return {
    recentSeasons: records.slice(0, 10).map((record) => ({
      season: record.season.number,
      type: record.season.type ?? SeasonType.RANKED,
      wins: record.wins,
      losses: record.losses,
      elo: record.season.type === SeasonType.RELAXED ? null : record.elo,
    })),
    moreSeasonsExist: records.length > 10,
    note: "Recent saved bot seasons only; not necessarily complete career or REST_API history",
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
  // Explicit season requests stay narrow; an omitted season also checks
  // older saved seasons so the first lookup can answer career questions.
  let otherSeasons: Awaited<ReturnType<typeof otherSeasonStats>> | undefined;
  if (seasonNumber === undefined) {
    try {
      otherSeasons = await otherSeasonStats(player.id);
    } catch {
      // A failed secondary read must not erase a verified current result.
    }
  }
  if (!stats)
    return { status: "no_stats", season: season.number, ...otherSeasons };
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
    ...otherSeasons,
  };
}

/** Self-only public identity preloaded into the initial prompt; never trust user-supplied IGN. */
export async function getAiCallerIdentity(
  caller: AiCaller
): Promise<{ status: "linked" | "unlinked"; latestIGN: string | null }> {
  const player = await prismaClient.player.findUnique({
    where: { discordSnowflake: caller.discordUserId },
    select: { latestIGN: true },
  });
  return validHistoricalIgn(player?.latestIGN)
    ? { status: "linked", latestIGN: player.latestIGN }
    : { status: "unlinked", latestIGN: null };
}

/** Only approved read-only functions touch the database. No model-controlled Prisma filters or writes. */
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
    case "search_tournament_matches":
      return searchTournamentMatches(args);
    case "get_command_catalog": {
      if (!caller.listCommands)
        return { status: "unavailable", detail: "command_catalog_unavailable" };
      const { status, commands, total, truncated } =
        await caller.listCommands();
      // Exact paths are for server-side validation, not a bloated model observation.
      return { status, commands, total, truncated };
    }
    case "list_organisers":
      return caller.listOrganisers
        ? caller.listOrganisers()
        : { status: "unavailable", detail: "discord_role_lookup_unavailable" };
    case "get_player_performance_shortlist":
      return getPlayerPerformanceShortlist({
        minGames: args.minGames as number | undefined,
        maxGames: args.maxGames as number | undefined,
        focus: args.focus as "mvps" | undefined,
      });
    case "get_my_all_time_stats": {
      const player = await prismaClient.player.findUnique({
        where: { discordSnowflake: caller.discordUserId },
        select: { id: true, latestIGN: true },
      });
      return player
        ? getSavedPlayerCareerStats(player)
        : { status: "player_not_found" };
    }
    case "get_player_all_time_stats": {
      const matches = await prismaClient.player.findMany({
        where: {
          latestIGN: { equals: args.ign as string, mode: "insensitive" },
        },
        select: { id: true, latestIGN: true },
        take: 2,
      });
      if (matches.length > 1) return { status: "ambiguous_player" };
      return matches.length
        ? getSavedPlayerCareerStats(matches[0])
        : { status: "player_not_found" };
    }
    case "get_all_time_leaderboard": {
      const leaders = await prismaClient.playerStats.groupBy({
        by: ["playerId"],
        _sum: { wins: true, losses: true },
        orderBy: { _sum: { wins: "desc" } },
        take: 10,
      });
      const players = await prismaClient.player.findMany({
        where: { id: { in: leaders.map((item) => item.playerId) } },
        select: { id: true, latestIGN: true },
      });
      const ignById = new Map(players.map((p) => [p.id, p.latestIGN]));
      return {
        status: "ok",
        metric: "total saved wins across all bot seasons",
        caveat:
          "Ranked and Relaxed combined; excludes REST_API-only archives and does not determine an objective best player",
        entries: leaders.map((item, index) => ({
          position: index + 1,
          player: ignById.get(item.playerId) ?? "Unknown",
          wins: item._sum.wins ?? 0,
          losses: item._sum.losses ?? 0,
          gamesPlayed: (item._sum.wins ?? 0) + (item._sum.losses ?? 0),
        })),
      };
    }
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
        take: (args.limit as number | undefined) ?? 10,
        orderBy: ranked
          ? [{ elo: "desc" }, { id: "asc" }]
          : [{ wins: "desc" }, { biggestWinStreak: "desc" }, { id: "asc" }],
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
        take: (args.limit as number | undefined) ?? 5,
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
    case "get_game_roster":
      return getGameOrganiserRoster();
    case "get_game_discord_state":
      return caller.inspectGameDiscord
        ? caller.inspectGameDiscord(
            args.focus as DiscordDiagnosticFocus,
            args.targetIGN as string | undefined
          )
        : {
            status: "unavailable",
            reason: "Discord diagnostics not configured",
          };
    case "get_game_persistence":
      return getGamePersistenceDiagnostics();
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
