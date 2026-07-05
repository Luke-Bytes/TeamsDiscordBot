import { Message } from "discord.js";
import {
  applyLimitedSampleGuardrail,
  commitTierPlacement,
  createTierListState,
  prepareAnchorFirstQueue,
  resolveLimitedSamplePolicy,
  TIER_LIST_REASONING_STYLE_INSTRUCTION,
} from "./AllSeasonTierList";
import { filterCommunityAnswers } from "./CommunityNotes";
import {
  AnchorTierVote,
  CommunityAnswer,
  FilteredCommunityNotes,
  PlayerTierDossier,
  TierListFinalVerdictPayload,
  TierListAnchorVoteSummary,
  TierListFinalReviewPayload,
  TierListFinalReviewRevision,
  TierListState,
  TierListTier,
  TierPlacement,
  TierPosition,
  TIER_ORDER,
} from "./types";
import { ROLE_LABELS } from "../../util/ProfileUtil";

export type TierListQuestionResult = {
  action: "continue" | "discard" | "skip" | "timeout";
  notes: FilteredCommunityNotes;
};

export type TierListConsistencyMove = {
  playerId: string;
  player: string;
  targetTier: TierListTier;
  targetPosition: TierPosition;
  suggestion: string;
};

type ActiveQuestionSession = {
  playerId: string;
  channelId: string;
  question: string;
  questionIndex: number;
  answers: CommunityAnswer[];
  answeredUserIds: Set<string>;
  extensionVoterIds: Set<string>;
  extended: boolean;
  discard: boolean;
  closed: boolean;
  paused: boolean;
  closesAt: number | null;
  timer: NodeJS.Timeout | null;
  resolve: (result: TierListQuestionResult) => void;
};

type ActiveAnchorSession = {
  playerId: string;
  channelId: string;
  votes: Map<string, AnchorTierVote>;
  closed: boolean;
  paused: boolean;
  timer: NodeJS.Timeout | null;
  resolve: (summary: TierListAnchorVoteSummary) => void;
};

const ANCHOR_TIER_VOTES: AnchorTierVote[] = ["A", "B", "C", "D", "E"];

const ROLE_OPTIONS = Object.values(ROLE_LABELS).join(", ");

const QUESTION_TEMPLATES = [
  {
    text: `What roles is {player} best at? Options: ${ROLE_OPTIONS}. Reply with 1-3 roles.`,
    needsPlacedPlayers: false,
  },
  {
    text: "Is {player} more useful as a specialist or a flex pick? Options: specialist, flex, both. Add the role if specialist.",
    needsPlacedPlayers: false,
  },
  {
    text: "What does {player} add that stats may miss? Options: shotcalling, comms, pressure, defence, support, clutch, consistency, morale.",
    needsPlacedPlayers: false,
  },
  {
    text: "Where should a captain use {player} in a close game? Options: rush, mid, defend, support, mine rush, grief, sky TP, farm/gold.",
    needsPlacedPlayers: false,
  },
  {
    text: "What is the main caveat with {player}? Options: inconsistent, quiet comms, role-limited, needs support, risky plays, rusty, unknown.",
    needsPlacedPlayers: false,
  },
  {
    text: "Which placed player is {player} most comparable to? Pick one option from the placed-player list and add 1-3 words why.",
    needsPlacedPlayers: true,
  },
];

export class TierListEventManager {
  private state: TierListState | null = null;
  private dossiers: PlayerTierDossier[] = [];
  private activeQuestion: ActiveQuestionSession | null = null;
  private activeAnchor: ActiveAnchorSession | null = null;
  private pendingConsistencyMoves: TierListConsistencyMove[] = [];

  start(
    dossiers: PlayerTierDossier[],
    options: { fastMode?: boolean; noCommunityInput?: boolean } = {}
  ) {
    const noCommunityInput = options.noCommunityInput || options.fastMode;
    const prepared = noCommunityInput
      ? { dossiers, anchorPlayerIds: [] }
      : prepareAnchorFirstQueue(dossiers);
    this.dossiers = prepared.dossiers;
    this.state = createTierListState(prepared.dossiers, {
      ...options,
      anchorPlayerIds: prepared.anchorPlayerIds,
    });
    this.activeQuestion = null;
    this.activeAnchor = null;
    this.pendingConsistencyMoves = [];
    return this.state;
  }

  reset() {
    this.clearAutoAdvanceTimer();
    this.state = null;
    this.dossiers = [];
    this.pendingConsistencyMoves = [];
    this.closeAnchorPoll();
    this.closeQuestion("discard");
  }

  getState() {
    return this.state;
  }

  getDossiers() {
    return this.dossiers;
  }

  getActiveQuestion() {
    return this.activeQuestion;
  }

  getActiveAnchor() {
    return this.activeAnchor;
  }

  currentAnchorDossier() {
    if (!this.state || this.state.phase !== "anchor") return null;
    const playerId = this.state.anchorPlayerIds[this.state.activeAnchorIndex];
    return (
      this.dossiers.find((dossier) => dossier.playerId === playerId) ?? null
    );
  }

  beginAnchorPoll(
    dossier: PlayerTierDossier,
    channelId: string,
    windowMs: number
  ) {
    this.closeAnchorPoll();
    const promise = new Promise<TierListAnchorVoteSummary>((resolve) => {
      this.activeAnchor = {
        playerId: dossier.playerId,
        channelId,
        votes: new Map(),
        closed: false,
        paused: false,
        timer: setTimeout(() => {
          this.finishAnchorPoll();
        }, windowMs),
        resolve,
      };
    });
    return promise;
  }

  pauseAnchorPoll() {
    const session = this.activeAnchor;
    if (!session || session.closed) return null;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    session.paused = true;
    return session;
  }

  finishAnchorPoll() {
    const session = this.activeAnchor;
    if (!session || session.closed) return null;
    session.closed = true;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    const summary = this.anchorSummary(session);
    if (this.state) {
      this.state.anchorVotesByPlayerId[session.playerId] = summary;
      this.state.activeAnchorIndex += 1;
      if (this.state.activeAnchorIndex >= this.state.anchorPlayerIds.length) {
        this.state.phase = "provisional";
      }
    }
    this.activeAnchor = null;
    session.resolve(summary);
    return summary;
  }

  closeAnchorPoll() {
    this.finishAnchorPoll();
  }

  nextDossier() {
    if (!this.state || this.state.phase === "anchor") return null;
    const nextId = this.state.unplacedPlayerIds[0];
    return this.dossiers.find((dossier) => dossier.playerId === nextId) ?? null;
  }

  dossierByQuery(query: string) {
    const normalized = query.toLowerCase();
    return this.dossiers.find(
      (candidate) =>
        candidate.displayName.toLowerCase() === normalized ||
        candidate.displayName.toLowerCase().includes(normalized)
    );
  }

  commitPlacement(placement: TierPlacement) {
    if (!this.state) return;
    commitTierPlacement(this.state, placement);
    const review = {
      playerId: placement.playerId,
      placementId: `${placement.playerId}:${this.state.placementCount}`,
      voters: [],
      justifications: [],
      thresholdReached: false,
    };
    this.state.placementReviewsByPlayerId[placement.playerId] = review;
    this.state.activePlacementReview = review;
  }

  skipNext() {
    if (!this.state) return null;
    const [playerId] = this.state.unplacedPlayerIds.splice(0, 1);
    if (!playerId) return null;
    this.state.unplacedPlayerIds.push(playerId);
    this.state.skippedPlayerIds.push(playerId);
    return (
      this.dossiers.find((dossier) => dossier.playerId === playerId) ?? null
    );
  }

  undoLastPlacement() {
    if (!this.state) return null;
    this.clearAutoAdvanceTimer();
    const placement = this.state.placementHistory.pop();
    if (!placement) return null;
    this.state.placed[placement.tier] = this.state.placed[
      placement.tier
    ].filter((candidate) => candidate.playerId !== placement.playerId);
    delete this.state.reasoningByPlayerId[placement.playerId];
    this.state.placementCount = Math.max(0, this.state.placementCount - 1);
    this.state.unplacedPlayerIds = [
      placement.playerId,
      ...this.state.unplacedPlayerIds.filter(
        (playerId) => playerId !== placement.playerId
      ),
    ];
    if (this.state.activePlacementReview?.playerId === placement.playerId) {
      this.state.activePlacementReview = undefined;
    }
    delete this.state.placementReviewsByPlayerId[placement.playerId];
    return placement;
  }

  replacePlacement(placement: TierPlacement) {
    if (!this.state) return false;
    const existing = this.findPlacement(placement.playerId);
    if (!existing) return false;

    this.state.placed[existing.tier] = this.state.placed[existing.tier].filter(
      (candidate) => candidate.playerId !== placement.playerId
    );
    this.state.placed[placement.tier].push(placement);
    this.sortTier(placement.tier);
    this.state.reasoningByPlayerId[placement.playerId] = placement.reasoning;
    const historyIndex = this.state.placementHistory.findIndex(
      (candidate) => candidate.playerId === placement.playerId
    );
    if (historyIndex >= 0)
      this.state.placementHistory[historyIndex] = placement;
    this.state.placementReviewsByPlayerId[placement.playerId] ??= {
      playerId: placement.playerId,
      placementId: `${placement.playerId}:${this.state.placementCount}`,
      voters: [],
      justifications: [],
      thresholdReached: false,
    };
    return true;
  }

  canStartFinalReview() {
    return !!this.state && this.state.unplacedPlayerIds.length === 0;
  }

  nextFinalReviewTier() {
    if (!this.state) return null;
    return TIER_ORDER[this.state.finalReviewTierIndex] ?? null;
  }

  startOrAdvanceFinalReview() {
    if (!this.state || !this.canStartFinalReview()) return null;
    this.state.phase = "final";
    return this.nextFinalReviewTier();
  }

  buildFinalReviewPayload(
    tier: TierListTier
  ): TierListFinalReviewPayload | null {
    if (!this.state) return null;
    const tierIndex = TIER_ORDER.indexOf(tier);
    const higherTier = tierIndex > 0 ? TIER_ORDER[tierIndex - 1] : undefined;
    const lowerTier =
      tierIndex < TIER_ORDER.length - 1 ? TIER_ORDER[tierIndex + 1] : undefined;

    return {
      tier,
      players: this.state.placed[tier].map((placement) =>
        this.finalReviewPlayer(placement)
      ),
      adjacentReferences: {
        ...(higherTier
          ? {
              higherTier: this.boundaryReferences(higherTier, "low"),
            }
          : {}),
        ...(lowerTier
          ? {
              lowerTier: this.boundaryReferences(lowerTier, "high"),
            }
          : {}),
      },
      currentTierList: Object.fromEntries(
        TIER_ORDER.map((item) => [
          item,
          this.state!.placed[item].map(
            (placement) => `${placement.position} ${placement.displayName}`
          ),
        ])
      ) as TierListFinalReviewPayload["currentTierList"],
      instructions: [
        `Review every player currently in ${tier}.`,
        "Return strict JSON only: an array of objects with playerId, tier, position, reasoning, confidence.",
        "Compare players within this tier and assign high/mid/low ordering.",
        "C is the community-average tier; B is above average; S is exceptional and rare.",
        `Low-sample players have fewer than ${resolveLimitedSamplePolicy().threshold} all-season games and are C/D by default.`,
        "Low-sample B requires accepted community or organiser context; S, A, and E are unavailable.",
        "Move players only to an adjacent tier unless the reasoning is explicit and strong.",
        "Raw team-game win rate is team-context evidence; prefer adjusted win score and individual signals like MVP rate, captain results, draft value, and underdog wins.",
        "Interpret percentages with their game and captain-game counts. Elo values are all-season averages/percentiles.",
        TIER_LIST_REASONING_STYLE_INSTRUCTION,
        "Keep reasoning under 450 characters and evidence-based.",
      ],
    };
  }

  buildFinalReviewSegmentPayload(
    tier: TierListTier,
    segment: TierPosition,
    playerIds?: string[]
  ): TierListFinalReviewPayload | null {
    if (!this.state) return null;
    const tierIndex = TIER_ORDER.indexOf(tier);
    const higherTier = tierIndex > 0 ? TIER_ORDER[tierIndex - 1] : undefined;
    const lowerTier =
      tierIndex < TIER_ORDER.length - 1 ? TIER_ORDER[tierIndex + 1] : undefined;
    const selectedPlayerIds = new Set(playerIds);
    const segmentPlayers = this.state.placed[tier].filter(
      (placement) =>
        placement.position === segment &&
        (!playerIds || selectedPlayerIds.has(placement.playerId))
    );

    return {
      tier,
      segment,
      players: segmentPlayers.map((placement) =>
        this.finalReviewPlayer(placement)
      ),
      sameTierReferences: this.sameTierSegmentReferences(tier, segment),
      adjacentReferences: {
        ...(higherTier
          ? {
              higherTier: this.boundaryReferences(higherTier, "low"),
            }
          : {}),
        ...(lowerTier
          ? {
              lowerTier: this.boundaryReferences(lowerTier, "high"),
            }
          : {}),
      },
      currentTierList: Object.fromEntries(
        TIER_ORDER.map((item) => [
          item,
          this.state!.placed[item].map(
            (placement) => `${placement.position} ${placement.displayName}`
          ),
        ])
      ) as TierListFinalReviewPayload["currentTierList"],
      instructions: [
        `Review only the ${segment} segment players currently in ${tier}.`,
        "Return strict JSON only: an array of objects with playerId, tier, position, reasoning, confidence.",
        "Do not return players outside this segment payload.",
        "Use same-tier segment references and adjacent tier boundaries for context.",
        "C is the community-average tier; B is above average; S is exceptional and rare.",
        `Low-sample players have fewer than ${resolveLimitedSamplePolicy().threshold} all-season games and are C/D by default.`,
        "Low-sample B requires accepted community or organiser context; S, A, and E are unavailable.",
        "Move players only to an adjacent tier unless the reasoning is explicit and strong.",
        "Raw team-game win rate is team-context evidence; prefer adjusted win score and individual signals like MVP rate, captain results, draft value, and underdog wins.",
        "Interpret percentages with their game and captain-game counts. Elo values are all-season averages/percentiles.",
        TIER_LIST_REASONING_STYLE_INSTRUCTION,
        "Keep reasoning under 450 characters and evidence-based.",
      ],
    };
  }

  buildFinalVerdictPayload(): TierListFinalVerdictPayload | null {
    if (!this.state) return null;
    return {
      tiers: Object.fromEntries(
        TIER_ORDER.map((tier) => [
          tier,
          this.state!.placed[tier].map((placement, index) => {
            const dossier = this.dossiers.find(
              (candidate) => candidate.playerId === placement.playerId
            );
            return {
              ...this.finalReviewPlayer(placement),
              rank: index + 1,
              notableStrengths: dossier?.notableStrengths ?? [],
              riskNotes: dossier?.riskNotes ?? [],
            };
          }),
        ])
      ) as TierListFinalVerdictPayload["tiers"],
      currentTierList: Object.fromEntries(
        TIER_ORDER.map((tier) => [
          tier,
          this.state!.placed[tier].map(
            (placement) =>
              `${placement.position} ${placement.displayName} (${placement.confidence})`
          ),
        ])
      ) as TierListFinalVerdictPayload["currentTierList"],
      instructions: [
        "Write a final commentary verdict for the completed tier list.",
        "Return strict JSON only with string keys S, A, B, C, D, E, and overall.",
        "Each tier string should summarize the list shape, evidence quality, confidence, limited-sample concerns, and notable player archetypes in that tier.",
        "The overall string should summarize the full distribution and major caveats.",
        "Do not change placements. Do not include markdown or Discord IDs.",
        "Keep each string under 900 characters.",
      ],
    };
  }

  applyFinalReviewRevisions(
    tier: TierListTier,
    revisions: TierListFinalReviewRevision[]
  ) {
    if (!this.state) return [];
    const originalPlayerIds = new Set(
      this.state.placed[tier].map((placement) => placement.playerId)
    );
    const applied: TierPlacement[] = [];

    for (const revision of revisions) {
      if (!originalPlayerIds.has(revision.playerId)) continue;
      const existing = this.findPlacement(revision.playerId);
      if (!existing) continue;
      const reviewed: TierPlacement = this.guardFinalReviewPlacement({
        ...existing,
        tier: this.boundedFinalTier(tier, revision),
        position: revision.position,
        confidence: revision.confidence,
        reasoning: revision.reasoning,
      });
      if (this.replacePlacement(reviewed)) applied.push(reviewed);
    }

    this.state.finalReviewedTiers = [
      ...this.state.finalReviewedTiers.filter((item) => item !== tier),
      tier,
    ];
    this.state.finalReviewTierIndex = Math.max(
      this.state.finalReviewTierIndex,
      TIER_ORDER.indexOf(tier) + 1
    );
    return applied;
  }

  applyFinalReviewSegmentRevisions(
    tier: TierListTier,
    playerIds: string[],
    revisions: TierListFinalReviewRevision[]
  ) {
    if (!this.state) return [];
    const originalPlayerIds = new Set(playerIds);
    const applied: TierPlacement[] = [];

    for (const revision of revisions) {
      if (!originalPlayerIds.has(revision.playerId)) continue;
      const existing = this.findPlacement(revision.playerId);
      if (!existing) continue;
      const reviewed: TierPlacement = this.guardFinalReviewPlacement({
        ...existing,
        tier: this.boundedFinalTier(tier, revision),
        position: revision.position,
        confidence: revision.confidence,
        reasoning: revision.reasoning,
      });
      if (this.replacePlacement(reviewed)) applied.push(reviewed);
    }

    return applied;
  }

  completeFinalReviewTier(tier: TierListTier) {
    if (!this.state) return;
    this.state.finalReviewedTiers = [
      ...this.state.finalReviewedTiers.filter((item) => item !== tier),
      tier,
    ];
    this.state.finalReviewTierIndex = Math.max(
      this.state.finalReviewTierIndex,
      TIER_ORDER.indexOf(tier) + 1
    );
  }

  currentPlacement() {
    const review = this.state?.activePlacementReview;
    if (!review) return null;
    return this.findPlacement(review.playerId);
  }

  setActivePlacementMessage(messageId?: string) {
    if (!this.state?.activePlacementReview || !messageId) return;
    this.state.activePlacementReview.messageId = messageId;
  }

  recordRerateVote(userId: string, isBot: boolean, threshold: number) {
    const review = this.state?.activePlacementReview;
    if (!review || isBot) {
      return { accepted: false, count: review?.voters.length ?? 0 };
    }
    if (!review.voters.includes(userId)) {
      review.voters.push(userId);
    }
    review.thresholdReached = review.voters.length >= threshold;
    if (review.thresholdReached) this.clearAutoAdvanceTimer();
    return {
      accepted: true,
      count: review.voters.length,
      thresholdReached: review.thresholdReached,
    };
  }

  addRerateJustification(justification: string, maxLength: number) {
    const review = this.state?.activePlacementReview;
    if (!review) return false;
    const trimmed = justification.trim().slice(0, maxLength);
    if (trimmed.length < 12) return false;
    if (/^\s*(put|move|make)\s+\S+\s+[SABCDE]\s*(tier)?\s*$/i.test(trimmed)) {
      return false;
    }
    review.justifications.push(trimmed);
    review.justifications = review.justifications.slice(-10);
    return true;
  }

  rerateJustifications() {
    return this.state?.activePlacementReview?.justifications ?? [];
  }

  rerateJustificationsFor(playerId: string) {
    return (
      this.state?.placementReviewsByPlayerId[playerId]?.justifications ?? []
    );
  }

  setPlacementStatusNote(note?: string) {
    if (!this.state?.activePlacementReview) return;
    this.state.activePlacementReview.statusNote = note;
  }

  setPlacementStatusNoteFor(playerId: string, note?: string) {
    const review = this.state?.placementReviewsByPlayerId[playerId];
    if (!review) return;
    review.statusNote = note;
  }

  completeActivePlacementReview() {
    if (!this.state?.activePlacementReview) return;
    this.state.activePlacementReview.thresholdReached = false;
    this.state.activePlacementReview = undefined;
  }

  pauseAutoAdvance() {
    if (!this.state) return;
    this.state.paused = true;
    this.clearAutoAdvanceTimer();
  }

  resumeAutoAdvance() {
    if (!this.state) return;
    this.state.paused = false;
  }

  setAutoAdvanceTimer(timer: NodeJS.Timeout) {
    if (!this.state) return;
    this.clearAutoAdvanceTimer();
    this.state.autoAdvanceTimer = timer;
  }

  clearAutoAdvanceTimer() {
    if (!this.state?.autoAdvanceTimer) return;
    clearTimeout(this.state.autoAdvanceTimer);
    this.state.autoAdvanceTimer = undefined;
  }

  addManualNote(playerId: string, note: string) {
    if (!this.state) return;
    const notes = this.state.manualNotesByPlayerId[playerId] ?? [];
    notes.push(note.slice(0, 500));
    this.state.manualNotesByPlayerId[playerId] = notes.slice(-5);
  }

  clearManualNotes(playerId: string) {
    if (!this.state) return;
    delete this.state.manualNotesByPlayerId[playerId];
  }

  setPendingConsistencyMoves(moves: TierListConsistencyMove[]) {
    this.pendingConsistencyMoves = moves;
  }

  applyPendingConsistencyMoves() {
    if (!this.state) return [];
    const applied: TierListConsistencyMove[] = [];
    for (const move of this.pendingConsistencyMoves) {
      const placement = this.findPlacement(move.playerId);
      if (!placement) continue;
      this.state.placed[placement.tier] = this.state.placed[
        placement.tier
      ].filter((candidate) => candidate.playerId !== move.playerId);
      const guarded = this.guardFinalReviewPlacement({
        ...placement,
        tier: move.targetTier,
        position: move.targetPosition,
        reasoning: `${placement.reasoning} Consistency review moved to ${move.targetPosition} ${move.targetTier}.`,
      });
      this.state.placed[guarded.tier].push(guarded);
      this.sortTier(guarded.tier);
      this.state.reasoningByPlayerId[move.playerId] = guarded.reasoning;
      applied.push(move);
    }
    this.pendingConsistencyMoves = [];
    return applied;
  }

  manualNotesFor(playerId: string) {
    return this.state?.manualNotesByPlayerId[playerId] ?? [];
  }

  placedDossierByQuery(query: string) {
    if (!this.state) return null;
    const normalized = query.trim().toLowerCase();
    const placements = (Object.keys(this.state.placed) as TierListTier[])
      .flatMap((tier) => this.state!.placed[tier])
      .filter(
        (placement) =>
          placement.displayName.toLowerCase() === normalized ||
          placement.displayName.toLowerCase().includes(normalized)
      );
    const placement = placements[0];
    if (!placement) return null;
    const dossier = this.dossiers.find(
      (candidate) => candidate.playerId === placement.playerId
    );
    return dossier ? { dossier, placement } : null;
  }

  beginQuestion(
    dossier: PlayerTierDossier,
    channelId: string,
    windowMs: number,
    maxAccepted: number
  ) {
    this.closeQuestion("discard");
    const questionIndex = this.questionIndexFor(dossier.playerId);
    const promise = new Promise<TierListQuestionResult>((resolve) => {
      const session: ActiveQuestionSession = {
        playerId: dossier.playerId,
        channelId,
        question: renderQuestion(
          dossier.displayName,
          questionIndex,
          this.state ?? undefined
        ),
        questionIndex,
        answers: [],
        answeredUserIds: new Set(),
        extensionVoterIds: new Set(),
        extended: false,
        discard: false,
        closed: false,
        paused: false,
        closesAt: Date.now() + windowMs,
        timer: setTimeout(() => {
          this.finishQuestion("timeout", maxAccepted);
        }, windowMs),
        resolve,
      };
      this.activeQuestion = session;
    });
    return promise;
  }

  pauseQuestion() {
    const session = this.activeQuestion;
    if (!session || session.closed) return null;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    session.paused = true;
    session.closesAt = null;
    return session;
  }

  requestQuestionExtension(
    userId: string,
    extensionMs: number,
    requiredVoters: number,
    maxAccepted: number
  ) {
    const session = this.activeQuestion;
    if (!session || session.closed) return { status: "inactive" as const };
    if (session.extended) return { status: "already-extended" as const };

    session.extensionVoterIds.add(userId);
    const votes = session.extensionVoterIds.size;
    if (votes < requiredVoters) {
      return { status: "recorded" as const, votes, requiredVoters };
    }

    session.extended = true;
    if (!session.paused && session.timer) {
      clearTimeout(session.timer);
      const baseClosesAt = Math.max(session.closesAt ?? Date.now(), Date.now());
      session.closesAt = baseClosesAt + extensionMs;
      session.timer = setTimeout(
        () => {
          this.finishQuestion("timeout", maxAccepted);
        },
        Math.max(0, session.closesAt - Date.now())
      );
    }
    return { status: "extended" as const, votes, requiredVoters };
  }

  handleMessage(message: Message) {
    const anchorSession = this.activeAnchor;
    if (anchorSession && !anchorSession.closed) {
      if (message.channelId !== anchorSession.channelId) return false;
      if (message.author.bot) return true;
      const vote = normalizeAnchorVote(message.content);
      if (!vote) return true;
      if (anchorSession.votes.has(message.author.id)) return true;
      anchorSession.votes.set(message.author.id, vote);
      return true;
    }

    const session = this.activeQuestion;
    if (!session || session.closed) return false;
    if (message.channelId !== session.channelId) return false;
    if (message.author.bot) return true;
    const content = message.content.trim();
    if (!content || content.length > 500) return true;
    if (content.startsWith("/tierlist")) return true;
    if (session.answeredUserIds.has(message.author.id)) return true;

    session.answers.push({ userId: message.author.id, content });
    session.answeredUserIds.add(message.author.id);
    return true;
  }

  private anchorSummary(
    session: ActiveAnchorSession
  ): TierListAnchorVoteSummary {
    const votes = Object.fromEntries(
      ANCHOR_TIER_VOTES.map((tier) => [tier, 0])
    ) as Record<AnchorTierVote, number>;
    for (const vote of session.votes.values()) {
      votes[vote] += 1;
    }
    const totalVotes = ANCHOR_TIER_VOTES.reduce(
      (sum, tier) => sum + votes[tier],
      0
    );
    const topVotes = Math.max(...ANCHOR_TIER_VOTES.map((tier) => votes[tier]));
    const topTiers = ANCHOR_TIER_VOTES.filter(
      (tier) => votes[tier] === topVotes
    );
    const dossier = this.dossiers.find(
      (candidate) => candidate.playerId === session.playerId
    );
    return {
      playerId: session.playerId,
      displayName: dossier?.displayName ?? session.playerId,
      votes,
      consensus: totalVotes > 0 && topTiers.length === 1 ? topTiers[0] : null,
      totalVotes,
    };
  }

  rerollQuestion() {
    const session = this.activeQuestion;
    if (!session || session.closed) return null;
    session.questionIndex = this.nextAllowedQuestionIndex(
      session.questionIndex + 1
    );
    const dossier = this.dossiers.find(
      (candidate) => candidate.playerId === session.playerId
    );
    session.question = renderQuestion(
      dossier?.displayName ?? "this player",
      session.questionIndex,
      this.state ?? undefined
    );
    return session.question;
  }

  finishQuestion(
    action: TierListQuestionResult["action"],
    maxAccepted: number
  ) {
    const session = this.activeQuestion;
    if (!session || session.closed) return null;
    session.closed = true;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    const notes =
      action === "discard" || session.discard
        ? { accepted: [], rejected: [], summary: null }
        : filterCommunityAnswers(session.answers, maxAccepted);
    if (action === "discard" && this.state) {
      this.state.discardedCommunityNotePlayerIds.push(session.playerId);
    }
    this.activeQuestion = null;
    session.resolve({ action, notes });
    return { action, notes };
  }

  closeQuestion(action: TierListQuestionResult["action"]) {
    this.finishQuestion(action, 0);
  }

  private questionIndexFor(playerId: string) {
    const total = Array.from(playerId).reduce(
      (sum, char) => sum + char.charCodeAt(0),
      0
    );
    return this.nextAllowedQuestionIndex(total);
  }

  private nextAllowedQuestionIndex(start: number) {
    for (let offset = 0; offset < QUESTION_TEMPLATES.length; offset++) {
      const index = (start + offset) % QUESTION_TEMPLATES.length;
      const template = QUESTION_TEMPLATES[index];
      if (!template.needsPlacedPlayers || this.hasPlacedPlayersInEveryTier()) {
        return index;
      }
    }
    return 0;
  }

  private hasPlacedPlayersInEveryTier() {
    return (
      !!this.state &&
      (Object.keys(this.state.placed) as TierListTier[]).every(
        (tier) => this.state!.placed[tier].length > 0
      )
    );
  }

  private findPlacement(playerId: string) {
    if (!this.state) return null;
    for (const tier of Object.keys(this.state.placed) as TierListTier[]) {
      const placement = this.state.placed[tier].find(
        (candidate) => candidate.playerId === playerId
      );
      if (placement) return placement;
    }
    return null;
  }

  private finalReviewPlayer(placement: TierPlacement) {
    const dossier = this.dossiers.find(
      (candidate) => candidate.playerId === placement.playerId
    );
    const stats = dossier?.stats;
    return {
      playerId: placement.playerId,
      displayName: placement.displayName,
      tier: placement.tier,
      position: placement.position,
      score: placement.score,
      confidence: placement.confidence,
      statisticalBand: dossier?.statisticalBand ?? placement.tier,
      gamesPlayed: dossier?.gamesPlayed ?? 0,
      limitedSample: dossier?.limitedSample ?? false,
      reasoning: placement.reasoning,
      objectiveSummary: dossier?.objectiveSummary ?? placement.reasoning,
      statContext: {
        record: stats ? `${stats.wins}-${stats.losses}` : "unknown",
        adjustedWinScore: stats?.adjustedWinScore ?? 0,
        mvpCount: stats?.mvpCount ?? 0,
        mvpEligibleGames: stats?.mvpEligibleGames ?? 0,
        mvpRate: stats?.mvpRate ?? 0,
        captainEligibleGames: stats?.captainEligibleGames ?? 0,
        captainRate: stats?.captainRate ?? 0,
        captainGames: stats?.captainGames ?? 0,
        captainWins: stats?.captainWins ?? 0,
        captainWinRate: stats?.captainWinRate ?? null,
        averageElo: stats?.averageElo ?? 0,
        averageSeasonEloPercentile: stats?.averageSeasonEloPercentile ?? 0,
      },
    };
  }

  private boundaryReferences(tier: TierListTier, side: "high" | "low") {
    const placements = this.state?.placed[tier] ?? [];
    const references =
      side === "high" ? placements.slice(0, 3) : placements.slice(-3);
    return references.map((placement) => this.finalReviewPlayer(placement));
  }

  private sameTierSegmentReferences(tier: TierListTier, segment: TierPosition) {
    const placements = this.state?.placed[tier] ?? [];
    const bySegment = (position: TierPosition) =>
      placements
        .filter((placement) => placement.position === position)
        .slice(0, 4)
        .map((placement) => this.finalReviewPlayer(placement));

    if (segment === "high") {
      return { lowerSegment: bySegment("mid") };
    }
    if (segment === "mid") {
      return {
        higherSegment: bySegment("high"),
        lowerSegment: bySegment("low"),
      };
    }
    return { higherSegment: bySegment("mid") };
  }

  private boundedFinalTier(
    sourceTier: TierListTier,
    revision: TierListFinalReviewRevision
  ) {
    const sourceIndex = TIER_ORDER.indexOf(sourceTier);
    const targetIndex = TIER_ORDER.indexOf(revision.tier);
    if (Math.abs(targetIndex - sourceIndex) <= 1) return revision.tier;
    if (
      /\b(exceptional|overwhelming|outlier|dominant|clear evidence)\b/i.test(
        revision.reasoning
      )
    ) {
      return revision.tier;
    }
    return sourceTier;
  }

  private guardFinalReviewPlacement(placement: TierPlacement): TierPlacement {
    const dossier = this.dossiers.find(
      (candidate) => candidate.playerId === placement.playerId
    );
    if (!dossier) return placement;
    return applyLimitedSampleGuardrail(
      dossier,
      placement,
      this.hasLimitedSampleContext(placement.playerId)
    );
  }

  private hasLimitedSampleContext(playerId: string) {
    return Boolean(
      this.state?.manualNotesByPlayerId[playerId]?.length ||
        this.state?.placementReviewsByPlayerId[playerId]?.justifications
          .length ||
        this.findPlacement(playerId)?.limitedSampleEvidence
    );
  }

  private sortTier(tier: TierListTier) {
    const rank: Record<TierPosition, number> = { high: 0, mid: 1, low: 2 };
    this.state?.placed[tier].sort(
      (a, b) => rank[a.position] - rank[b.position] || b.score - a.score
    );
  }
}

function renderQuestion(player: string, index: number, state?: TierListState) {
  const placedNames = state
    ? (Object.keys(state.placed) as TierListTier[])
        .flatMap((tier) =>
          state.placed[tier].map((item) => `${item.displayName} (${tier})`)
        )
        .join(", ")
    : "";
  const question = QUESTION_TEMPLATES[index].text.replace("{player}", player);
  return QUESTION_TEMPLATES[index].needsPlacedPlayers && placedNames
    ? `${question} Options: ${placedNames}.`
    : question;
}

function normalizeAnchorVote(content: string): AnchorTierVote | null {
  const normalized = content.trim().toUpperCase();
  return ANCHOR_TIER_VOTES.includes(normalized as AnchorTierVote)
    ? (normalized as AnchorTierVote)
    : null;
}
