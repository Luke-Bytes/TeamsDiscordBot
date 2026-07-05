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
  lastPlayedAt: Date;
  provisional: boolean;
  limitedSample: boolean;
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
    mvpEligibleGames: number;
    mvpRate: number;
    smoothedMvpRate: number;
    captainEligibleGames: number;
    captainRate: number;
    captainGames: number;
    captainWins: number;
    captainWinRate: number | null;
    smoothedCaptainWinRate: number | null;
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
  limitedSampleEvidence?: boolean;
};

export type TierListPlacementReview = {
  playerId: string;
  placementId: string;
  messageId?: string;
  voters: string[];
  justifications: string[];
  statusNote?: string;
  thresholdReached: boolean;
};

export type AnchorTierVote = "A" | "B" | "C" | "D" | "E";

export type TierListAnchorVoteSummary = {
  playerId: string;
  displayName: string;
  votes: Record<AnchorTierVote, number>;
  consensus: AnchorTierVote | null;
  totalVotes: number;
};

export type TierListPhase = "anchor" | "provisional" | "final";

export type TierListState = {
  eventId: string;
  createdAt: Date;
  phase: TierListPhase;
  finalReviewTierIndex: number;
  finalReviewedTiers: TierListTier[];
  unplacedPlayerIds: string[];
  placed: Record<TierListTier, TierPlacement[]>;
  placementHistory: TierPlacement[];
  reasoningByPlayerId: Record<string, string>;
  manualNotesByPlayerId: Record<string, string[]>;
  discardedCommunityNotePlayerIds: string[];
  skippedPlayerIds: string[];
  placementCount: number;
  anchorPlayerIds: string[];
  activeAnchorIndex: number;
  anchorVotesByPlayerId: Record<string, TierListAnchorVoteSummary>;
  liveSummaryMessageId?: string;
  postedImageMessageIds: string[];
  paused: boolean;
  fastMode?: boolean;
  noCommunityInput?: boolean;
  placementReviewsByPlayerId: Record<string, TierListPlacementReview>;
  activePlacementReview?: TierListPlacementReview;
  autoAdvanceTimer?: NodeJS.Timeout;
};

export type TierComparable = {
  playerId: string;
  displayName: string;
  statisticalBand: TierListTier;
  gamesPlayed: number;
  limitedSample: boolean;
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

export type TierListFinalReviewPlayer = {
  playerId: string;
  displayName: string;
  tier: TierListTier;
  position: TierPosition;
  score: number;
  confidence: TierConfidence;
  statisticalBand: TierListTier;
  gamesPlayed: number;
  limitedSample: boolean;
  reasoning: string;
  objectiveSummary: string;
  statContext: {
    record: string;
    adjustedWinScore: number;
    mvpCount: number;
    mvpEligibleGames: number;
    mvpRate: number;
    captainEligibleGames: number;
    captainRate: number;
    captainGames: number;
    captainWins: number;
    captainWinRate: number | null;
    averageElo: number;
    averageSeasonEloPercentile: number;
  };
};

export type TierListFinalReviewPayload = {
  tier: TierListTier;
  segment?: TierPosition;
  players: TierListFinalReviewPlayer[];
  sameTierReferences?: {
    higherSegment?: TierListFinalReviewPlayer[];
    lowerSegment?: TierListFinalReviewPlayer[];
  };
  adjacentReferences: {
    higherTier?: TierListFinalReviewPlayer[];
    lowerTier?: TierListFinalReviewPlayer[];
  };
  currentTierList: Record<TierListTier, string[]>;
  instructions: string[];
};

export type TierListFinalReviewRevision = {
  playerId: string;
  tier: TierListTier;
  position: TierPosition;
  reasoning: string;
  confidence: TierConfidence;
};

export type TierListFinalVerdictPlayer = TierListFinalReviewPlayer & {
  rank: number;
  notableStrengths: string[];
  riskNotes: string[];
};

export type TierListFinalVerdictPayload = {
  tiers: Record<TierListTier, TierListFinalVerdictPlayer[]>;
  currentTierList: Record<TierListTier, string[]>;
  instructions: string[];
};

export type TierListFinalVerdict = Record<TierListTier, string> & {
  overall: string;
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
