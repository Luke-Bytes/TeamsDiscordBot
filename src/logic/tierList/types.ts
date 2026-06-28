import { gameType, Team } from "@prisma/client";

export type TierListTier = "S" | "A" | "B" | "C" | "D" | "E";
export type TierConfidence = "high" | "medium" | "low" | "provisional";
export type TierPosition = "high" | "mid" | "low";

export const TIER_ORDER: TierListTier[] = ["S", "A", "B", "C", "D", "E"];

export type TierListProfileContext = {
  preferredRoles: string[];
  proficientAtRoles: string[];
  playstyles: string[];
};

export type PlayerTierDossier = {
  playerId: string;
  displayName: string;
  gamesPlayed: number;
  seasonsPlayed: number;
  provisional: boolean;
  statisticalBand: TierListTier;
  score: number;
  objectiveSummary: string;
  notableStrengths: string[];
  riskNotes: string[];
  confidenceNotes: string[];
  profile?: TierListProfileContext;
  stats: {
    wins: number;
    losses: number;
    winRate: number;
    adjustedWinScore: number;
    mvpCount: number;
    mvpRate: number;
    smoothedMvpRate: number;
    captainGames: number;
    captainWins: number;
    captainWinRate: number | null;
    underdogWins: number;
    draftGames: number;
    averageDraftSlotPercentile: number | null;
    draftValue: number;
    peakElo: number;
    finalEloAverage: number;
    averageElo: number;
    averageSeasonEloPercentile: number;
    maps: Record<string, number>;
    modifiers: Record<string, number>;
    gameTypes: Partial<Record<gameType, number>>;
    doubleEloGames: number;
  };
};

export type TierPlacement = {
  playerId: string;
  displayName: string;
  tier: TierListTier;
  position: TierPosition;
  reasoning: string;
  confidence: TierConfidence;
  score: number;
};

export type TierListState = {
  eventId: string;
  createdAt: Date;
  unplacedPlayerIds: string[];
  placed: Record<TierListTier, TierPlacement[]>;
  placementHistory: TierPlacement[];
  reasoningByPlayerId: Record<string, string>;
  manualNotesByPlayerId: Record<string, string[]>;
  discardedCommunityNotePlayerIds: string[];
  skippedPlayerIds: string[];
  placementCount: number;
  liveSummaryMessageId?: string;
  postedImageMessageIds: string[];
};

export type TierComparable = {
  playerId: string;
  displayName: string;
  statisticalBand: TierListTier;
  gamesPlayed: number;
  score: number;
  summary: string;
};

export type PlacementPromptPayload = {
  player: Omit<PlayerTierDossier, "playerId">;
  currentTierList: Record<TierListTier, string[]>;
  nearestComparables: TierComparable[];
  communityNotes?: {
    summary: string;
    warning: "subjective community context";
  };
  manualNotes?: string[];
  placementInstructions: string[];
  instructions: string[];
};

export type CommunityAnswer = {
  userId: string;
  content: string;
};

export type FilteredCommunityNotes = {
  accepted: string[];
  rejected: { content: string; reason: string }[];
  summary: string | null;
};

export type PlayerOutcome = {
  playerId: string;
  gameId: string;
  won: boolean;
  team: Team;
  expectedWinChance: number;
  underdog: boolean;
  captain: boolean;
  mvp: boolean;
  draftSlotPercentile: number | null;
};
