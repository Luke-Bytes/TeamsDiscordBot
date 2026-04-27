import { gameType, Team } from "@prisma/client";

export type SeasonRecapThresholds = {
  minPlayerGames: number;
  minPlayerSeasonShare: number;
  minDuoGames: number;
  minCaptainGames: number;
  minMapPlayerGames: number;
  minMvpGames: number;
  minFastLongGames: number;
  closeGameEloGap: number;
  underdogEloGap: number;
  recoveryEloThreshold: number;
  minLateDraftGames: number;
  lateDraftSlotPercentile: number;
  earlyDraftSlotMax: number;
  minTurnaroundHalfGames: number;
  minTrioGames: number;
  topLimit: number;
};

export const DEFAULT_SEASON_RECAP_THRESHOLDS: SeasonRecapThresholds = {
  minPlayerGames: 5,
  minPlayerSeasonShare: 0.2,
  minDuoGames: 4,
  minCaptainGames: 3,
  minMapPlayerGames: 3,
  minMvpGames: 3,
  minFastLongGames: 5,
  closeGameEloGap: 25,
  underdogEloGap: 50,
  recoveryEloThreshold: 950,
  minLateDraftGames: 3,
  lateDraftSlotPercentile: 0.6,
  earlyDraftSlotMax: 2,
  minTurnaroundHalfGames: 2,
  minTrioGames: 3,
  topLimit: 3,
};

export const DEFAULT_MAX_BLOCK_LENGTH = 1650;
export const DISCORD_HARD_LIMIT = 2000;
export const EXCLUDED_BANNED_CLASSES = new Set(["SWAPPER"]);

export type SeasonRecapPlayer = {
  id: string;
  latestIGN: string | null;
  discordSnowflake?: string | null;
};

export type SeasonRecapPlayerStats = {
  playerId: string;
  elo: number;
  wins: number;
  losses: number;
  winStreak: number;
  loseStreak: number;
  biggestWinStreak: number;
  biggestLosingStreak: number;
  player?: SeasonRecapPlayer | null;
};

export type SeasonRecapParticipation = {
  playerId: string;
  ignUsed: string;
  team: Team;
  mvp: boolean;
  captain: boolean;
  draftSlotPlacement?: number | null;
  votedForAMVP?: boolean | null;
  player?: SeasonRecapPlayer | null;
};

export type SeasonRecapGameSettings = {
  organiserBannedClasses?: string[] | null;
  sharedCaptainBannedClasses?: string[] | null;
  nonSharedCaptainBannedClasses?: {
    RED?: string[] | null;
    BLUE?: string[] | null;
  } | null;
  map?: string | null;
  modifiers?: { category: string; name: string }[] | null;
  delayedBan?: number | null;
};

export type SeasonRecapGame = {
  id: string;
  finished: boolean;
  startTime: Date;
  endTime: Date;
  settings?: SeasonRecapGameSettings | null;
  winner: Team;
  type?: gameType | null;
  doubleElo?: boolean | null;
  organiser: string;
  host: string;
  gameParticipations: SeasonRecapParticipation[];
};

export type SeasonRecapEloHistory = {
  playerId: string;
  gameId: string;
  elo: number;
  createdAt: Date;
};

export type SeasonRecapData = {
  seasonNumber: number;
  games: SeasonRecapGame[];
  playerStats: SeasonRecapPlayerStats[];
  histories: SeasonRecapEloHistory[];
};

export type SeasonRecapResult = {
  seasonNumber: number;
  blocks: string[];
  summary: {
    games: number;
    players: number;
    dateRange: string;
    skippedSections: string[];
  };
};

export type GenerateOptions = {
  seasonNumber?: number;
  thresholds?: Partial<SeasonRecapThresholds>;
  maxBlockLength?: number;
};

export type InsightSection = {
  title: string;
  lines: string[];
};

export type PlayerGameOutcome = {
  playerId: string;
  gameIndex: number;
  won: boolean;
  team: Team;
  map: string;
  closeGame: boolean;
  underdog: boolean;
  captain: boolean;
  mvp: boolean;
};

export type SeasonRecapModel = {
  preEloByGamePlayer: Map<string, number>;
  gameContexts: Map<
    string,
    {
      redMean: number;
      blueMean: number;
      eloGap: number;
      underdogTeam: Team | null;
      closeGame: boolean;
    }
  >;
  outcomesByPlayer: Map<string, PlayerGameOutcome[]>;
};
