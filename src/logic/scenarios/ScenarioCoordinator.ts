import type { GameInstance } from "../../database/GameInstance";
import { randomUUID } from "node:crypto";
import type { Guild } from "discord.js";
import { Scheduler } from "../../util/SchedulerUtil";
import TeamCommand from "../../commands/TeamCommand";
import { GameRecoveryCoordinator } from "../ActiveGameRecovery";
import { MatchRecoveryGate } from "../MatchRecoveryGate";
import { GuildMembership } from "../GuildMembership";
import { ScenarioRegistry, scenarioRegistry } from "./ScenarioRegistry";
import {
  ScenarioAction, ScenarioDefinition, ScenarioPhase, ScenarioRole,
  ScenarioState, ScenarioValue, ScenarioTriggerPolicy, ScenarioTriggerRun,
  ScenarioPromptDelivery, ScenarioPrivatePrompt,
} from "./ScenarioTypes";

const validPhases: ScenarioPhase[] = ["configured", "collecting", "ready", "completed", "needs_review", "cancelled"];
const validRoles: ScenarioRole[] = ["participant", "captain", "organiser"];
const MAX_STATE_BYTES = 64_000;
const runStatuses = ["pending", "scheduled", "running", "active", "completed", "missed", "failed"];
const promptStatuses = ["pending", "delivered", "failed", "completed"];

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function validValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => validValue(entry, depth + 1));
  return plainRecord(value) && Object.entries(value).every(
    ([key, entry]) => key !== "__proto__" && key !== "constructor" &&
      validValue(entry, depth + 1)
  );
}
const validDeadline = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const validAction = (a: unknown): a is ScenarioAction =>
  plainRecord(a) && typeof a.id === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(a.id) &&
  typeof a.kind === "string" && a.kind.length > 0 && a.kind.length <= 64 &&
  typeof a.ownerId === "string" && /^\d{1,22}$/.test(a.ownerId) &&
  validRoles.includes(a.role as ScenarioRole) &&
  validPhases.includes(a.phase as ScenarioPhase) && validDeadline(a.deadline) &&
  typeof a.allowUpdates === "boolean" &&
  (a.response === undefined || validValue(a.response)) &&
  (a.submittedAt === undefined || validDeadline(a.submittedAt));

/** Strictly validate untrusted recovery payloads before installing any of it. */
export function validateScenarioState(input: unknown, registry: ScenarioRegistry = scenarioRegistry): asserts input is ScenarioState {
  if (!plainRecord(input) ||
      typeof input.id !== "string" || !registry.get(input.id) ||
      !Number.isSafeInteger(input.version) || (input.version as number) < 1 ||
      typeof input.gameToken !== "string" || !/^[a-f0-9-]{36}$/.test(input.gameToken) ||
      !validPhases.includes(input.phase as ScenarioPhase) ||
      !plainRecord(input.config) || !validValue(input.config) ||
      !plainRecord(input.data) || !validValue(input.data) ||
      (input.deadline !== undefined && !validDeadline(input.deadline)) ||
      (input.reviewReason !== undefined && (typeof input.reviewReason !== "string" || input.reviewReason.length > 500)) ||
      (input.triggers !== undefined && (!Array.isArray(input.triggers) ||
        !input.triggers.every((r) => plainRecord(r) && typeof r.id === "string" &&
          /^[a-z][a-z0-9-]{0,23}$/.test(r.id) && runStatuses.includes(r.status as string) &&
          (r.scheduledAt === undefined || validDeadline(r.scheduledAt)) &&
          (r.activatedAt === undefined || validDeadline(r.activatedAt)) &&
          (r.completedAt === undefined || validDeadline(r.completedAt)) &&
          (r.reason === undefined || (typeof r.reason === "string" && r.reason.length <= 500)) &&
          (r.rosterIds === undefined || (Array.isArray(r.rosterIds) &&
            r.rosterIds.every((id) => typeof id === "string" && /^\d{1,22}$/.test(id)) &&
            new Set(r.rosterIds).size === r.rosterIds.length))) ||
        new Set(input.triggers.map((r: ScenarioTriggerRun) => r.id)).size !== input.triggers.length ||
        input.triggers.some((r: ScenarioTriggerRun) => !registry.get(input.id as string)?.triggers?.some((p) => p.id === r.id)) )) ||
      (input.prompts !== undefined && (!Array.isArray(input.prompts) ||
        !input.prompts.every((p) => plainRecord(p) && typeof p.triggerId === "string" &&
          typeof p.actionId === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(p.actionId) &&
          typeof p.userId === "string" && /^\d{1,22}$/.test(p.userId) &&
          promptStatuses.includes(p.status as string)) ||
        new Set(input.prompts.map((p: ScenarioPromptDelivery) => `${p.triggerId}:${p.userId}`)).size !== input.prompts.length)) ||
      !Array.isArray(input.actions) || !input.actions.every(validAction) ||
      new Set(input.actions.map((a: ScenarioAction) => a.id)).size !== input.actions.length ||
      JSON.stringify(input).length > MAX_STATE_BYTES) {
    throw new Error("Invalid scenario recovery payload");
  }
}

/** One coordinator per GameInstance; all state is keyed to its lifecycle token. */
export class ScenarioCoordinator {
  private state: ScenarioState | null = null;
  private readonly scheduledIds = new Set<string>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly game: GameInstance, private readonly registry: ScenarioRegistry = scenarioRegistry) {}

  get selectedId(): string | null { return this.state?.id ?? null; }
  get definition(): ScenarioDefinition | undefined {
    return this.state ? this.registry.get(this.state.id) : undefined;
  }
  get phase(): ScenarioPhase | null { return this.state?.phase ?? null; }
  snapshot(): ScenarioState | null { return this.state ? copy(this.state) : null; }

  /** Scenario-owned bounded state, updated under the same roster operation as actions. */
  setData(key: string, value: ScenarioValue): void {
    const classAccess = this.state?.id === "class-hex" && this.state.phase === "completed" &&
      key === "access" && this.state.gameToken === this.game.getLifecycleToken() &&
      this.game.announced && !this.game.isFinished && this.game.getGameStartStatus() === "idle";
    if ((!this.isLive() && !classAccess) || !/^[a-z][a-zA-Z0-9]{0,40}$/.test(key) || !validValue(value))
      throw new Error("Scenario data cannot be updated in this phase.");
    const before = this.state!.data[key];
    this.state!.data[key] = copy(value);
    if (JSON.stringify(this.state).length > MAX_STATE_BYTES) {
      if (before === undefined) delete this.state!.data[key];
      else this.state!.data[key] = before;
      throw new Error("Scenario state limit reached.");
    }
  }

  async reopenAction(userId: string): Promise<ScenarioPrivatePrompt | null> {
    const registration = await this.registrationPrompt(userId);
    if (registration) return registration;
    if (!this.isLive() || this.state?.phase !== "collecting") return null;
    const action = [...this.state.actions].reverse().find((entry) =>
      entry.ownerId === userId && Date.parse(entry.deadline) > Date.now());
    if (!action || !this.definition?.implementation?.renderAction) return null;
    return this.definition.implementation.renderAction(this.game, copy(action),
      `fwsc:${this.state.gameToken}:${action.id}:${userId}`);
  }

  configure(id: string | null, config: Record<string, ScenarioValue> = {}): void {
    if (this.game.announced) throw new Error("Scenario cannot be changed after announcement.");
    if (!id || id === "none") { this.state = null; return; }
    const definition = this.registry.requireAvailable(id);
    if (!validValue(config) || JSON.stringify(config).length > MAX_STATE_BYTES)
      throw new Error("Invalid scenario configuration.");
    definition.implementation!.validateConfig?.(config);
    this.state = {
      id, version: definition.version, gameToken: this.game.getLifecycleToken(),
      phase: "configured", config: copy(config), data: {}, actions: [],
      triggers: definition.triggers?.filter((t) => t.type !== "on_registration").map((t) => ({ id: t.id, status: "pending" })), prompts: [],
    };
  }

  confirmAnnouncement(): void {
    if (!this.state) return;
    this.registry.requireAvailable(this.state.id);
    if (this.state.phase !== "configured") throw new Error("Scenario is not configured.");
    this.state.gameToken = this.game.getLifecycleToken();
    this.state.phase = "collecting";
  }

  async onAnnounced(guild?: Guild): Promise<void> {
    if (!this.state) return;
    try {
      await this.definition?.implementation?.onAnnounced?.(this.game, this.state);
      this.syncTriggerSchedule(Date.now(), guild);
    } catch (error) {
      this.needsReview("Scenario announcement setup failed; inspect the workflow before continuing.");
      throw error;
    }
  }

  async onRegistrationChanged(userId: string, joined: boolean): Promise<void> {
    if (!this.state || this.state.gameToken !== this.game.getLifecycleToken() ||
        !this.game.announced || this.game.isFinished || this.game.getGameStartStatus() !== "idle" ||
        this.state.phase === "cancelled" || this.state.phase === "needs_review") return;
    // Never retain a departed player's private response. A published proposal
    // cannot be confirmed after any participant change.
    if (!joined) {
      this.state.actions = this.state.actions.filter((a) => a.ownerId !== userId);
      this.state.prompts = this.state.prompts?.filter((p) => p.userId !== userId);
    }
    if (this.state.triggers?.some((r) => r.rosterIds?.includes(userId) ||
        (r.rosterIds && joined && !r.rosterIds.includes(userId))))
      this.needsReview("Roster changed after scenario snapshot; review eligibility and recalculate before confirmation.");
    if (this.state.phase === "ready" || this.state.phase === "completed")
      this.needsReview("Roster changed after scenario preparation; rebuild or review the result.");
    try {
      await this.definition?.implementation?.onRegistrationChanged?.(this.game, userId, joined);
    } catch (error) {
      console.error("Scenario registration hook failed:", error instanceof Error ? error.message : String(error));
      this.needsReview("Scenario registration update failed; organiser review required.");
    }
  }

  async onTeamsFinalized(guild?: Guild): Promise<void> {
    if (!this.state || this.state.gameToken !== this.game.getLifecycleToken() ||
        !this.game.announced || this.game.isFinished ||
        !["collecting", "ready", "completed"].includes(this.state.phase)) return;
    // Lifecycle callbacks may originate inside TeamCommand's roster lock.
    // Schedule activation after it has released that lock.
    queueMicrotask(() => { void this.activateType("on_teams_finalized", guild); });
    try { await this.definition?.implementation?.onTeamsFinalized?.(this.game); }
    catch (error) {
      this.needsReview("Scenario teams-finalised hook failed.");
      throw error;
    }
  }
  async onDraftTurn(team: "RED" | "BLUE"): Promise<void> {
    if (!this.isLive()) return;
    queueMicrotask(() => { void this.activateType("on_draft_start"); });
    try { await this.definition?.implementation?.onDraftTurn?.(this.game, team); }
    catch (error) {
      this.needsReview("Scenario draft-turn hook failed.");
      throw error;
    }
  }
  private isLive(): boolean {
    return !!this.state && this.state.gameToken === this.game.getLifecycleToken() &&
      this.game.announced && !this.game.isFinished && this.game.getGameStartStatus() === "idle" &&
      ["collecting", "ready"].includes(this.state.phase);
  }
  /** A block on ownership prevents competing automated/manual captain/draft workflows. */
  automationBlock(operation: "captains" | "teams" | "draft"): string | null {
    if (!this.state) return null;
    if (this.state.gameToken !== this.game.getLifecycleToken()) return "Scenario belongs to an old match; organiser review required.";
    if (this.state.phase === "completed" || this.state.phase === "cancelled") return null;
    if (this.state.phase === "needs_review") return "Scenario requires organiser review. Reset or resolve the scenario before proceeding.";
    const caps = this.definition?.capabilities;
    if ((operation === "captains" && caps?.captains) ||
        (operation === "teams" && caps?.teams) ||
        (operation === "draft" && (caps?.draft || caps?.teams || caps?.captains))) {
      return `${this.definition?.name ?? "Scenario"} controls this stage. Finish or cancel its preparation first.`;
    }
    return null;
  }
  startBlock(): string | null {
    if (!this.state) return null;
    if (this.state.gameToken !== this.game.getLifecycleToken())
      return "Scenario belongs to a different game; organiser review required.";
    if (this.state.phase !== "completed") return `Scenario ${this.definition?.name ?? this.state.id} is ${this.state.phase}; organiser must complete or cancel its preparation before starting.`;
    if (this.definition?.capabilities.requiresFinalTeams && !this.game.hasFinalizedPlayableTeams())
      return "Scenario requires finalised teams.";
    return this.definition?.implementation?.checkReadyToStart?.(this.game) ?? null;
  }
  markReady(data?: Record<string, ScenarioValue>): void {
    if (!this.isLive() || this.state?.phase !== "collecting") throw new Error("Scenario cannot become ready in this phase.");
    if (data) {
      if (!validValue(data)) throw new Error("Invalid scenario result.");
      // Preserve the underlying private submissions while attaching a public
      // proposal. The archived result is still explicitly publicResult only.
      const merged = { ...this.state.data, ...data };
      if (JSON.stringify({ ...this.state, data: merged }).length > MAX_STATE_BYTES)
        throw new Error("Scenario result exceeds recovery-state limits.");
      this.state.data = copy(merged);
    }
    this.state.phase = "ready";
    for (const run of this.state.triggers ?? []) if (run.status === "active") {
      run.status = "completed";
      run.completedAt = new Date().toISOString();
    }
  }
  async approveResult(guild: Guild): Promise<void> {
    if (!this.isLive() || this.state?.phase !== "ready" ||
        !this.definition?.implementation?.approveResult)
      throw new Error("No scenario result is awaiting organiser approval.");
    await this.definition.implementation.approveResult(this.game, guild);
  }

  complete(): void {
    if (!this.isLive() || !this.state || !["collecting", "ready"].includes(this.state.phase))
      throw new Error("Scenario cannot be completed in this phase.");
    this.state.phase = "completed";
    this.clearTriggerTimers();
    for (const run of this.state.triggers ?? []) if (run.status === "active") {
      run.status = "completed"; run.completedAt = new Date().toISOString();
    }
    this.state.actions = [];
  }
  /** Future organiser UX may explicitly resume from a reviewed snapshot; never automatically resume on restart. */
  resumeAfterReview(): void {
    if (this.state?.phase !== "needs_review" || !this.game.announced || this.game.isFinished ||
        this.game.getGameStartStatus() !== "idle") throw new Error("There is no resumable scenario.");
    this.registry.requireAvailable(this.state.id);
    if (["masked-draft", "draft-roulette", "captains-wildcards"].includes(this.state.id))
      throw new Error("An interrupted draft cannot be resumed without its live turn state. Cancel the scenario and use a fresh normal draft instead; the preserved picks remain available for review.");
    // Explicit organiser review discards only the derived proposal/stage, never
    // silently reuses stale roster snapshots or random Class Hex assignments.
    for (const run of this.state.triggers ?? []) {
      run.status = "pending";
      delete run.rosterIds;
      delete run.activatedAt;
      delete run.completedAt;
      delete run.reason;
      delete run.scheduledAt;
    }
    if (this.state.id === "class-hex") {
      delete this.state.data.hexDraw;
      delete this.state.data.hexEditors;
      delete this.state.data.access;
    } else if (this.state.id === "mystery-dungeon" || this.state.id === "partners-in-crime") {
      for (const key of ["red", "blue", "types", "pairs", "kept", "split"])
        delete this.state.data[key];
    } else if (this.state.id === "peoples-captains") {
      for (const key of ["slate", "ballots", "votes", "captainRed", "captainBlue", "turnout", "exposures", "counts"])
        delete this.state.data[key];
    }
    this.state.phase = "collecting";
    delete this.state.reviewReason;
    this.state.actions = [];
    this.state.prompts = [];
    // No timer replay: organiser must start a fresh eligible stage manually.
  }
  needsReview(reason: string): void {
    if (!this.state || this.state.phase === "cancelled") return;
    this.clearTriggerTimers();
    this.state.phase = "needs_review";
    this.state.reviewReason = reason.slice(0, 500);
    this.state.actions = [];
  }
  invalidateTeams(): void {
    if (this.state && (
      this.state.phase === "ready" ||
      (this.definition?.capabilities.requiresFinalTeams && ["collecting", "completed"].includes(this.state.phase)) ||
      (this.state.phase === "completed" && this.definition?.capabilities.teams)))
      this.needsReview("Team assignments changed; scenario preparation must be checked again.");
  }
  async cancel(): Promise<void> {
    if (!this.state || this.state.phase === "cancelled") return;
    const previous = this.state;
    this.state.phase = "cancelled";
    this.clearTriggerTimers();
    this.state.actions = [];
    this.state.prompts = [];
    try { await this.definition?.implementation?.onCancel?.(this.game); }
    catch (error) { console.error("Scenario cleanup failed:", error instanceof Error ? error.message : String(error)); }
    if (this.state === previous) this.state = null;
  }
  reset(): void { this.clearTriggerTimers(); this.state = null; }

  /** Stop automatic resumes of private collectors/timers after a preserved restart. */
  restore(raw: ScenarioState | null, token: string): void {
    this.clearTriggerTimers();
    if (!raw) { this.state = null; return; }
    validateScenarioState(raw, this.registry);
    if (raw.gameToken !== token) throw new Error("Scenario belongs to a different game.");
    this.state = copy(raw);
    // A hook interrupted during restart must not be treated as still running
    // forever or automatically retried with fresh random results.
    for (const run of this.state.triggers ?? []) if (run.status === "running") {
      run.status = "failed";
      run.reason = "Activation interrupted by restart; manual investigation required.";
    }
    if (this.state.phase !== "completed" && this.state.phase !== "cancelled") {
      this.needsReview("Recovered scenario interactions are paused; organiser must inspect and resume or cancel.");
    }
    const definition = this.definition;
    if (!definition?.enabled || !definition.implementation || definition.version !== this.state.version) {
      this.needsReview("Scenario implementation or version unavailable after recovery.");
      return;
    }
    try { definition.implementation.onRestore?.(this.game); }
    catch { this.needsReview("Scenario restore hook failed; organiser review required."); }
  }

  /** Short, scoped IDs (under Discord's 100-character limit). Caller verifies interaction.user.id. */
  openAction(input: Omit<ScenarioAction, "phase" | "response" | "submittedAt">): string {
    if (!this.isLive() || this.state?.phase !== "collecting") throw new Error("Scenario is not accepting choices.");
    if (this.definition?.capabilities.requiresFinalTeams && !this.game.hasFinalizedPlayableTeams())
      throw new Error("Scenario actions require finalised teams.");
    this.expireActions();
    if (!validAction({ ...input, phase: this.state.phase })) throw new Error("Invalid scenario action.");
    if (this.state.actions.some((a) => a.id === input.id)) throw new Error("Duplicate scenario action ID.");
    const customId = `fwsc:${this.state.gameToken}:${input.id}:${input.ownerId}`;
    if (customId.length > 100) throw new Error("Scenario interaction ID too long.");
    this.state.actions.push({ ...input, phase: this.state.phase });
    return customId;
  }
  submitAction(customId: string, actorId: string, value: ScenarioValue, isOrganiser = false, now = Date.now()): string {
    if (!this.isLive() || this.state?.phase !== "collecting") throw new Error("Scenario interaction has expired.");
    this.expireActions(now);
    const match = /^fwsc:([a-f0-9-]{36}):([a-zA-Z0-9_-]{1,32}):(\d{1,22})$/.exec(customId);
    if (!match || match[1] !== this.state.gameToken) throw new Error("Interaction belongs to a different game.");
    const action = this.state.actions.find((a) => a.id === match[2] && a.ownerId === match[3]);
    if (!action || action.phase !== this.state.phase || action.ownerId !== actorId)
      throw new Error("Interaction is expired or belongs to another player.");
    if (Date.parse(action.deadline) <= now || (this.state.deadline && Date.parse(this.state.deadline) <= now))
      throw new Error("Scenario interaction deadline passed.");
    if (action.role === "organiser" && !isOrganiser) throw new Error("Organiser permission required.");
    const participant = this.game.getPlayers().find((p) => p.discordSnowflake === actorId);
    if (action.role === "participant" && !participant) throw new Error("Only registered players can respond.");
    if (action.role === "captain" && (!participant?.captain ||
        !["RED", "BLUE"].includes(this.game.getPlayersTeam(participant) ?? "")))
      throw new Error("Only a registered team captain can respond.");
    if (action.response !== undefined && !action.allowUpdates) throw new Error("This choice has already been submitted.");
    if (!validValue(value) || JSON.stringify(value).length > 8_000) throw new Error("Invalid choice data.");
    if (action.response !== undefined && JSON.stringify(action.response) === JSON.stringify(value))
      throw new Error("This choice has already been submitted.");
    this.definition?.implementation?.validateAction?.(this.game, copy(action), value);
    action.response = copy(value);
    const prompt = this.state.prompts?.find((p) => p.actionId === action.id && p.userId === actorId);
    if (prompt) prompt.status = "completed";
    action.submittedAt = new Date(now).toISOString();
    if (JSON.stringify(this.state).length > MAX_STATE_BYTES) {
      delete action.response;
      delete action.submittedAt;
      if (prompt) prompt.status = "pending";
      throw new Error("Scenario response storage is full.");
    }
    return action.allowUpdates ? "Choice saved; you may update it before the deadline." : "Choice submitted.";
  }
  async applyAction(customId: string, actorId: string, value: ScenarioValue, isOrganiser = false): Promise<string | ScenarioPrivatePrompt> {
    const message = this.submitAction(customId, actorId, value, isOrganiser);
    const action = this.state?.actions.find((a) => customId === `fwsc:${this.state?.gameToken}:${a.id}:${a.ownerId}`);
    if (action) {
      try { await this.definition?.implementation?.onActionSubmitted?.(this.game, copy(action)); }
      catch (error) {
        this.needsReview("Scenario submission processing failed; organiser must inspect the workflow.");
        throw error;
      }
    }
    if (action && this.isLive() && this.definition?.implementation?.renderAction) {
      const prompt = await this.definition.implementation.renderAction(this.game, copy(action), customId);
      return { ...prompt, content: `${message}\n${prompt.content}` };
    }
    return message;
  }
  expireActions(now = Date.now()): void {
    if (!this.state) return;
    this.state.actions = this.state.actions.filter((a) => Date.parse(a.deadline) > now);
  }
  /** Same current-match, prerequisite and roster-lock path for automatic and manual starts. */
  async activateTrigger(id: string, source: "automatic" | "manual" | "lifecycle" = "manual", guild?: Guild): Promise<string> {
    const policy = this.definition?.triggers?.find((t) => t.id === id && t.type !== "on_registration");
    if (!policy || !this.state) throw new Error("No such available scenario stage.");
    if (source === "manual" && !policy.manual && policy.type !== "manual")
      throw new Error("This stage cannot be started manually.");
    const run = this.getRun(id);
    if (run.status === "completed" || run.status === "active") return `${id} is already ${run.status}.`;
    if (this.inFlight.has(id) || run.status === "running") return `${id} is already starting.`;
    this.inFlight.add(id);
    const token = this.game.getLifecycleToken();
    const selectedId = this.state.id;
    const execute = async (): Promise<string> => {
      if (this.game.getLifecycleToken() !== token || this.state?.gameToken !== token ||
          this.state.id !== selectedId)
        throw new Error("Scenario stage belongs to an obsolete match.");
      const reason = this.triggerPrerequisite(policy);
      if (reason) throw new Error(reason);
      if (guild && TeamCommand.instance) {
        await GuildMembership.reconcile(guild, TeamCommand.instance);
        const afterReconcile = this.triggerPrerequisite(policy);
        if (afterReconcile) throw new Error(afterReconcile);
      }
      if (this.game.getLifecycleToken() !== token || this.state?.gameToken !== token ||
          this.state.id !== selectedId)
        throw new Error("Scenario stage belongs to an obsolete match.");
      const implementation = this.definition?.implementation;
      if (!implementation?.activateTrigger)
        throw new Error("Scenario stage has no implementation.");
      const ids = [...new Set(this.game.getPlayers().map((p) => p.discordSnowflake))].sort();
      run.status = "running";
      this.cancelStageTimer(id);
      run.activatedAt = new Date().toISOString();
      if (policy.captureRoster) run.rosterIds = ids;
      try {
        await implementation.activateTrigger(this.game, policy, ids);
        if (this.game.getLifecycleToken() !== token || !this.isLive() && this.state?.phase !== "completed")
          throw new Error("Match changed while activating the scenario.");
        if (run.status === "running") run.status = this.state?.phase === "ready" || this.state?.phase === "completed" ? "completed" : "active";
        if (run.status === "completed") run.completedAt = new Date().toISOString();
        return `${this.definition?.name ?? selectedId}: ${id} ${run.status}.`;
      } catch (error) {
        run.status = "failed";
        run.reason = error instanceof Error ? error.message.slice(0, 500) : "Scenario hook failed";
        if (this.state?.gameToken === token && this.state.id === selectedId)
          this.needsReview(`Scenario stage ${id} failed: ${run.reason}`);
        throw error;
      }
    };
    try {
      // The team lock also obtains the recovery coordinator's operation lease.
      if (TeamCommand.instance) return await TeamCommand.instance.runRosterOperation(execute);
      const release = GameRecoveryCoordinator.enterOperation();
      if (!release) throw new Error("Recovery is in progress; scenario activation paused.");
      try { return await execute(); } finally { release(); }
    } catch (error) {
      if (source === "automatic" && this.state?.phase !== "needs_review" && this.state?.gameToken === token) {
        run.status = "missed";
        run.reason = error instanceof Error ? error.message.slice(0, 500) : "Prerequisites not met";
      }
      throw error;
    } finally {
      this.inFlight.delete(id);
    }
  }

  async activateType(type: ScenarioTriggerPolicy["type"], guild?: Guild): Promise<void> {
    if (!this.isLive()) return;
    for (const policy of this.definition?.triggers ?? []) {
      if (policy.type !== type || policy.type === "on_registration") continue;
      try { await this.activateTrigger(policy.id, "lifecycle", guild); }
      catch (error) {
        console.warn(`Scenario ${type} could not activate:`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Timers are only armed for live, newly confirmed announcements, never restores. */
  syncTriggerSchedule(now = Date.now(), guild?: Guild): void {
    this.clearTriggerTimers();
    if (!this.isLive() || !this.game.startTime) return;
    // Update pending private action deadlines alongside any announcement time edit.
    // Submitted answers retain their original response; no prompt is resent.
    const collection = this.definition?.triggers?.find((p) => p.type === "on_registration");
    const close = this.definition?.triggers?.find((p) => p.type === "before_game_start");
    if (collection && this.state?.phase === "collecting") {
      const at = this.game.startTime.getTime() -
        (collection.offsetMinutes ?? close?.offsetMinutes ?? 0) * 60_000;
      for (const prompt of this.state.prompts ?? []) {
        const action = this.state.actions.find((a) => a.id === prompt.actionId && a.ownerId === prompt.userId);
        if (action && at > now) action.deadline = new Date(at).toISOString();
      }
    }
    for (const policy of this.definition?.triggers ?? []) {
      if (policy.type !== "before_game_start") continue;
      const run = this.getRun(policy.id);
      if (!["pending", "scheduled", "missed"].includes(run.status)) continue;
      const at = this.game.startTime.getTime() - (policy.offsetMinutes ?? 15) * 60_000;
      run.scheduledAt = new Date(at).toISOString();
      if (at <= now) {
        run.status = "missed";
        run.reason = "Scheduled time has passed; an organiser may start this stage manually after checking prerequisites.";
        continue;
      }
      run.status = "scheduled";
      delete run.reason;
      const token = this.game.getLifecycleToken();
      const taskId = `scenario:${token}:${policy.id}`;
      this.scheduledIds.add(taskId);
      Scheduler.schedule(taskId, async () => {
        if (this.game.getLifecycleToken() !== token || !this.isLive() ||
            !this.game.startTime || this.game.startTime.getTime() - (policy.offsetMinutes ?? 15) * 60_000 > Date.now())
          return;
        try { await this.activateTrigger(policy.id, "automatic", guild); }
        catch (error) {
          console.warn(`Scenario stage ${policy.id} requires organiser attention:`, error instanceof Error ? error.message : String(error));
          const { DiscordUtil } = await import("../../util/DiscordUtil");
          await DiscordUtil.sendMessage("gameFeed",
            `⚠️ Scenario ${this.definition?.name ?? "stage"} did not activate: ${error instanceof Error ? error.message.slice(0, 300) : "review required"}. Use /game scenario status.`
          ).catch(() => {});
        }
      }, new Date(at));
    }
  }

  clearSchedules(): void { this.clearTriggerTimers(); }

  private cancelStageTimer(id: string): void {
    const taskId = `scenario:${this.game.getLifecycleToken()}:${id}`;
    if (!this.scheduledIds.delete(taskId)) return;
    Scheduler.cancel(taskId);
  }

  private clearTriggerTimers(): void {
    for (const id of this.scheduledIds) Scheduler.cancel(id);
    this.scheduledIds.clear();
  }

  private getRun(id: string): ScenarioTriggerRun {
    if (!this.state) throw new Error("No scenario selected.");
    this.state.triggers ??= [];
    let run = this.state.triggers.find((r) => r.id === id);
    if (!run) { run = { id, status: "pending" }; this.state.triggers.push(run); }
    return run;
  }

  private triggerPrerequisite(policy: ScenarioTriggerPolicy): string | null {
    if (!this.isLive() || this.game.isRestarting || GameRecoveryCoordinator.getBlockReason() || MatchRecoveryGate.getBlockReason()) return "No live announced scenario accepting activation, or recovery review is outstanding.";
    const implementationBlock = this.definition?.implementation?.validateTrigger?.(this.game, policy);
    if (implementationBlock) return implementationBlock;
    if (policy.requiredPhase && this.state?.phase !== policy.requiredPhase)
      return `Stage requires phase ${policy.requiredPhase} (currently ${this.state?.phase ?? "none"}).`;
    if (this.game.getPlayers().length < (policy.minPlayers ?? 0))
      return `At least ${policy.minPlayers} registered players are required (${this.game.getPlayers().length} currently).`;
    if (policy.requireCaptains && (!this.game.getCaptainOfTeam("RED") || !this.game.getCaptainOfTeam("BLUE")))
      return "RED and BLUE captains have not both been selected.";
    if (policy.requireFinalTeams && !this.game.hasFinalizedPlayableTeams())
      return "Teams must be finalised first.";
    if (TeamCommand.instance?.isTeamPickingSessionActive() &&
        (policy.type !== "on_draft_start" || !this.definition?.capabilities.normalDraft))
      return "Team selection is already active.";
    return null;
  }

  /** Capture is a frozen identity set, not permission to commit stale teams. */
  assertCapturedRoster(id: string): string[] {
    const run = this.getRun(id);
    if (!run.rosterIds) throw new Error("Scenario stage has no captured roster.");
    const current = [...new Set(this.game.getPlayers().map((p) => p.discordSnowflake))].sort();
    if (JSON.stringify(current) !== JSON.stringify(run.rosterIds) || !this.isLive())
      throw new Error("Scenario roster changed since locking; review and recalculate.");
    return [...current];
  }

  assertCapturedRosters(): void {
    for (const run of this.state?.triggers ?? []) {
      if (run.rosterIds) this.assertCapturedRoster(run.id);
    }
  }

  /** Registration delivery is best-effort and never part of the DB/roster commit. */
  async registrationPrompt(userId: string): Promise<ScenarioPrivatePrompt | null> {
    if (!this.isLive() || this.state?.phase !== "collecting" ||
        !this.game.getPlayers().some((p) => p.discordSnowflake === userId)) return null;
    const policy = this.definition?.triggers?.find((t) => t.type === "on_registration");
    const render = this.definition?.implementation?.registrationPrompt;
    if (!policy || !render || !this.game.startTime) return null;
    const close = this.definition?.triggers?.find((t) => t.type === "before_game_start");
    const deadline = this.game.startTime.getTime() - (policy.offsetMinutes ?? close?.offsetMinutes ?? 0) * 60_000;
    if (deadline <= Date.now()) return null;
    this.state.prompts ??= [];
    let record = this.state.prompts.find((p) => p.userId === userId && p.triggerId === policy.id);
    if (!record) {
      record = { userId, triggerId: policy.id, actionId: `r${randomUUID().slice(0, 12)}`, status: "pending" };
      this.state.prompts.push(record);
    }
    const action = this.state.actions.find((a) => a.id === record!.actionId);
    if (action?.response !== undefined && !action.allowUpdates) return null;
    try {
      if (!action) this.openAction({
        id: record.actionId, kind: policy.kind ?? policy.id, ownerId: userId,
        role: "participant", deadline: new Date(deadline).toISOString(),
        allowUpdates: policy.allowUpdates ?? false,
      });
      const customId = `fwsc:${this.state.gameToken}:${record.actionId}:${userId}`;
      const message = await render(this.game, userId, customId);
      if (!this.isLive() || !this.game.getPlayers().some((p) => p.discordSnowflake === userId))
        return null;
      if (!message.content) throw new Error("Scenario prompt has no content.");
      return message;
    } catch (error) {
      record.status = "failed";
      console.warn("Scenario private prompt unavailable:", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  markPromptDelivered(userId: string): void {
    const record = this.state?.prompts?.find((p) => p.userId === userId);
    if (record && record.status !== "completed") record.status = "delivered";
  }
  markPromptFailed(userId: string): void {
    const record = this.state?.prompts?.find((p) => p.userId === userId);
    if (record && record.status !== "completed") record.status = "failed";
  }

  triggerStatus(): string {
    if (!this.state) return "Scenario: None. Ordinary game preparation applies.";
    const lines = [`Scenario: ${this.definition?.name ?? this.state.id} | Phase: ${this.state.phase}`,
      `Registered participants: ${this.game.getPlayers().length}`];
    for (const policy of this.definition?.triggers ?? []) {
      if (policy.type === "on_registration") {
        const records = this.state.prompts?.filter((p) => p.triggerId === policy.id) ?? [];
        lines.push(`${policy.id}: ${records.filter((p) => p.status === "completed").length}/${records.length} completed; ${records.filter((p) => p.status === "failed").length} delivery failures. Players: /game scenario open`);
        continue;
      }
      const run = this.getRun(policy.id);
      const reason = this.triggerPrerequisite(policy);
      lines.push(`${policy.id} (${policy.type}): ${run.status}${run.scheduledAt ? ` at ${run.scheduledAt}` : ""} | manual: ${policy.manual ? "yes" : "no"}${reason ? ` | blocked: ${reason}` : ""}${run.reason ? ` | ${run.reason}` : ""}${run.rosterIds ? ` | roster locked: ${run.rosterIds.length}` : ""}`);
    }
    const next = this.definition?.triggers?.find((policy) =>
      policy.type !== "on_registration" &&
      !["completed", "active"].includes(this.getRun(policy.id).status));
    if (next) lines.push(`Next expected stage: ${next.id} (${next.type})`);
    if (this.state.reviewReason) lines.push(`Review: ${this.state.reviewReason}`);
    return lines.join("\n").slice(0, 1900);
  }

  async startNextManualTrigger(id?: string, guild?: Guild): Promise<string> {
    const policy = id
      ? this.definition?.triggers?.find((p) => p.id === id)
      : this.definition?.triggers?.find((p) => p.manual &&
          !["completed", "active"].includes(this.getRun(p.id).status));
    if (!policy) throw new Error("No pending manual-eligible scenario stage.");
    return this.activateTrigger(policy.id, "manual", guild);
  }

  publicMatchMetadata(): ScenarioValue | null {
    const result = this.definition?.implementation?.publicResult?.(this.game);
    if (result === undefined) return null;
    if (!validValue(result) || JSON.stringify(result).length > 8_000)
      throw new Error("Scenario public result is invalid or too large.");
    return copy(result);
  }
}
