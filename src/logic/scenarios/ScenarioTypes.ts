import type { GameInstance } from "../../database/GameInstance";
import type { Guild } from "discord.js";

export type ScenarioCategory =
  | "captain-selection"
  | "team-formation"
  | "draft"
  | "draft-extension"
  | "gameplay-restriction";
export type ScenarioPhase =
  | "configured"
  | "collecting"
  | "ready"
  | "completed"
  | "needs_review"
  | "cancelled";
export type ScenarioStage = "registration" | "captains" | "teams" | "draft" | "pre-game";
export type ScenarioRole = "participant" | "captain" | "organiser";
export type ScenarioTriggerType =
  | "on_registration" | "before_game_start" | "on_captains_ready"
  | "on_teams_finalized" | "on_draft_start" | "manual";
export type ScenarioTriggerStatus = "pending" | "scheduled" | "running" | "active" | "completed" | "missed" | "failed";

export interface ScenarioTriggerPolicy {
  id: string;
  type: ScenarioTriggerType;
  /** Minutes before the announced start; applies to timers and registration cutoffs. */
  offsetMinutes?: number;
  manual?: boolean;
  minPlayers?: number;
  requireCaptains?: boolean;
  requireFinalTeams?: boolean;
  captureRoster?: boolean;
  /** Phase which must be current before the stage may activate. */
  requiredPhase?: "collecting" | "ready";
  /** Registration prompts use the existing participant action contract. */
  kind?: string;
  allowUpdates?: boolean;
}
export interface ScenarioTriggerRun {
  id: string;
  status: ScenarioTriggerStatus;
  scheduledAt?: string;
  activatedAt?: string;
  completedAt?: string;
  rosterIds?: string[];
  reason?: string;
}
export interface ScenarioPromptDelivery {
  triggerId: string;
  userId: string;
  actionId: string;
  status: "pending" | "delivered" | "failed" | "completed";
}
export interface ScenarioPrivatePrompt {
  content: string;
  /** Discord.js action rows are supplied by the scenario, not the framework. */
  components?: import("discord.js").InteractionReplyOptions["components"];
}

export type ScenarioValue =
  | null | boolean | number | string
  | ScenarioValue[] | { [key: string]: ScenarioValue };

export interface ScenarioAction {
  id: string;
  kind: string;
  ownerId: string;
  role: ScenarioRole;
  phase: ScenarioPhase;
  deadline: string;
  allowUpdates: boolean;
  response?: ScenarioValue;
  submittedAt?: string;
}

export interface ScenarioState {
  id: string;
  version: number;
  gameToken: string;
  phase: ScenarioPhase;
  config: Record<string, ScenarioValue>;
  data: Record<string, ScenarioValue>;
  deadline?: string;
  actions: ScenarioAction[];
  triggers?: ScenarioTriggerRun[];
  prompts?: ScenarioPromptDelivery[];
  reviewReason?: string;
}

export interface ScenarioCapabilities {
  captains?: boolean;
  teams?: boolean;
  draft?: boolean;
  normalDraft?: boolean;
  requiresFinalTeams?: boolean;
}

/** Hooks run inside the current match, never a second game manager. */
export interface ScenarioImplementation {
  validateConfig?(config: ScenarioState["config"]): void;
  /** Prerequisite failures do not consume a scheduled/manual trigger. */
  validateTrigger?(game: GameInstance, policy: ScenarioTriggerPolicy): string | null;
  onAnnounced?(game: GameInstance, state: ScenarioState): Promise<void> | void;
  onRegistrationChanged?(game: GameInstance, userId: string, joined: boolean): Promise<void> | void;
  /** Called with a server-issued owner-bound action ID; render, never publish publicly. */
  registrationPrompt?(game: GameInstance, userId: string, customId: string): Promise<ScenarioPrivatePrompt> | ScenarioPrivatePrompt;
  /** Render a live, owner-bound multi-step action after each choice or on reopen. */
  renderAction?(game: GameInstance, action: ScenarioAction, customId: string): Promise<ScenarioPrivatePrompt> | ScenarioPrivatePrompt;
  /** One invocation per stage, guarded by the shared roster/recovery lock. */
  activateTrigger?(game: GameInstance, policy: ScenarioTriggerPolicy, rosterIds: readonly string[]): Promise<void> | void;
  onTeamsFinalized?(game: GameInstance): Promise<void> | void;
  /** Authenticated organiser confirmation runs outside the activation roster lock. */
  approveResult?(game: GameInstance, guild: Guild): Promise<void>;
  validateAction?(game: GameInstance, action: ScenarioAction, value: ScenarioValue): void;
  onActionSubmitted?(game: GameInstance, action: ScenarioAction): Promise<void> | void;
  /** True only when the editor has saved a complete response. */
  isActionComplete?(game: GameInstance, action: ScenarioAction): boolean;
  /** Optional actions are never chased by automated reminders. */
  isActionAvailable?(game: GameInstance, action: ScenarioAction): boolean;
  /** Only public/auditable data is copied into finished match metadata; never raw ballots. */
  publicResult?(game: GameInstance): ScenarioValue;
  onDraftTurn?(game: GameInstance, team: "RED" | "BLUE"): Promise<void> | void;
  checkReadyToStart?(game: GameInstance): string | null;
  publicSummary?(game: GameInstance): string;
  organiserSummary?(game: GameInstance): string;
  onCancel?(game: GameInstance): Promise<void> | void;
  onRestore?(game: GameInstance): void;
}

export interface ScenarioInformation {
  players: string;
  rules: string;
  deadlines: string;
  captains?: string;
  organiser?: string;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  information?: ScenarioInformation;
  category: ScenarioCategory;
  stage: ScenarioStage;
  version: number;
  capabilities: ScenarioCapabilities;
  /** Implementation and enabled must BOTH be set before a scenario is selectable. */
  enabled?: boolean;
  implementation?: ScenarioImplementation;
  compatibility?: string[];
  triggers?: ScenarioTriggerPolicy[];
}

export interface ScenarioTeamProposal {
  red: string[];
  blue: string[];
  undecided: string[];
  captains?: { red?: string; blue?: string };
  /** Original team method stays authoritative in Game.type for historic reporting. */
  method: "RANDOMISED" | "ELO" | "BALANCE" | "DRAFT" | "SNAKE_DRAFT";
}
