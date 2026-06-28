import { Message } from "discord.js";
import { commitTierPlacement, createTierListState } from "./AllSeasonTierList";
import { filterCommunityAnswers } from "./CommunityNotes";
import {
  CommunityAnswer,
  FilteredCommunityNotes,
  PlayerTierDossier,
  TierListState,
  TierListTier,
  TierPlacement,
  TierPosition,
} from "./types";

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
  discard: boolean;
  closed: boolean;
  timer: NodeJS.Timeout;
  resolve: (result: TierListQuestionResult) => void;
};

const QUESTION_TEMPLATES = [
  "What role or playstyle best describes {player}, and what makes that useful in teams?",
  "Where does {player} add the most team value: fighting, support, defending, rushing, mid, or comms?",
  "Which already-known player is {player} most comparable to, and why?",
  "What is one strength and one caveat organisers should remember for {player}?",
];

export class TierListEventManager {
  private state: TierListState | null = null;
  private dossiers: PlayerTierDossier[] = [];
  private activeQuestion: ActiveQuestionSession | null = null;
  private pendingConsistencyMoves: TierListConsistencyMove[] = [];

  start(dossiers: PlayerTierDossier[]) {
    this.dossiers = dossiers;
    this.state = createTierListState(dossiers);
    this.activeQuestion = null;
    this.pendingConsistencyMoves = [];
    return this.state;
  }

  reset() {
    this.state = null;
    this.dossiers = [];
    this.pendingConsistencyMoves = [];
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

  nextDossier() {
    if (!this.state) return null;
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
    return placement;
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
      placement.tier = move.targetTier;
      placement.position = move.targetPosition;
      placement.reasoning = `${placement.reasoning} Consistency review moved to ${move.targetPosition} ${move.targetTier}.`;
      this.state.placed[move.targetTier].push(placement);
      this.state.placed[move.targetTier].sort((a, b) => b.score - a.score);
      this.state.reasoningByPlayerId[move.playerId] = placement.reasoning;
      applied.push(move);
    }
    this.pendingConsistencyMoves = [];
    return applied;
  }

  manualNotesFor(playerId: string) {
    return this.state?.manualNotesByPlayerId[playerId] ?? [];
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
        question: renderQuestion(dossier.displayName, questionIndex),
        questionIndex,
        answers: [],
        answeredUserIds: new Set(),
        discard: false,
        closed: false,
        timer: setTimeout(() => {
          this.finishQuestion("timeout", maxAccepted);
        }, windowMs),
        resolve,
      };
      this.activeQuestion = session;
    });
    return promise;
  }

  handleMessage(message: Message) {
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

  rerollQuestion() {
    const session = this.activeQuestion;
    if (!session || session.closed) return null;
    session.questionIndex =
      (session.questionIndex + 1) % QUESTION_TEMPLATES.length;
    const dossier = this.dossiers.find(
      (candidate) => candidate.playerId === session.playerId
    );
    session.question = renderQuestion(
      dossier?.displayName ?? "this player",
      session.questionIndex
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
    clearTimeout(session.timer);
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
    return total % QUESTION_TEMPLATES.length;
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
}

function renderQuestion(player: string, index: number) {
  return QUESTION_TEMPLATES[index].replace("{player}", player);
}
