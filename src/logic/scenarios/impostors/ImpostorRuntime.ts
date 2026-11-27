import type { VoiceCleanup, VoiceEffectRequest, VoiceEffectService } from "../shared/VoiceEffectService";
import type { ScenarioRandom } from "../shared/ScenarioRandom";
import type { ImpostorTeam } from "./ImpostorMissions";
import { ImpostorRound, type ImpostorStage } from "./ImpostorRound";
import { slotTiming, type ImpostorVoiceSlot } from "./ImpostorVoiceSlots";

export interface ImpostorClock {
  now(): number;
  schedule(id: string, at: number, callback: () => Promise<void>): void;
  cancel(id: string): void;
}

export interface ImpostorRuntimeEnvironment {
  current(): boolean;
  canPlay(): boolean;
  rosterMatches(): boolean;
  voiceRequest(team: ImpostorTeam, slot: ImpostorVoiceSlot): Omit<VoiceEffectRequest, "token" | "slotId" | "effect" | "latestStart">;
  stageChanged(stage: ImpostorStage): Promise<void>;
  cleanupRequired(cleanup: VoiceCleanup): void;
}

interface TimedSlot {
  team: ImpostorTeam;
  slot: ImpostorVoiceSlot;
  timing: ReturnType<typeof slotTiming>;
  job: string;
  status: "pending" | "reserved" | "finished";
}

const hasFailures = (cleanup: VoiceCleanup) => cleanup.unresolved.length > 0 || cleanup.channels.length > 0;

/** Match-local timers only. Normal game lifecycle and winner remain authoritative. */
export class ImpostorRuntime {
  private readonly slots = new Map<string, TimedSlot>();
  private readonly jobs = new Map<string, symbol>();
  private ending?: Promise<void>;
  private aborting?: Promise<void>;
  private cleanup?: VoiceCleanup;
  private stopped = false;
  private manuallyReconciled = false;
  private restorePending = 0;

  constructor(
    readonly round: ImpostorRound,
    private readonly voice: VoiceEffectService,
    private readonly clock: ImpostorClock,
    private readonly environment: ImpostorRuntimeEnvironment,
    private readonly random: ScenarioRandom = Math.random
  ) {}

  start(announcedStart: number): void {
    if (!this.environment.current() || !this.environment.canPlay() || !this.environment.rosterMatches() ||
        !Number.isFinite(announcedStart) || this.stopped)
      throw new Error("Scenario cannot start safely.");
    this.round.beginPlaying();
    for (const { team, slot } of this.round.scheduledSlots()) {
      const timing = slotTiming(slot, announcedStart, this.random);
      // Scheduler logs task IDs; never put the secret actor in them.
      const job = `scenario-runtime:${this.round.token}:voice:${team}:${slot.windowIndex}`;
      const entry: TimedSlot = { team, slot, timing, job, status: "pending" };
      this.slots.set(slot.ownerId, entry);
      const at = Math.max(this.clock.now() + 1, timing.fallback);
      if (at <= timing.latestStart) this.schedule(job, at, () => this.activate(entry));
      else entry.status = "finished";
    }
  }

  ownTiming(token: string, actor: string) {
    this.round.ownVoiceSlot(token, actor);
    const entry = this.slots.get(actor);
    if (!entry || !this.environment.current() || !this.environment.canPlay() || this.stopped)
      throw new Error("That scenario interaction is no longer available.");
    return { ...entry.timing, status: entry.status, now: this.clock.now() };
  }

  delayActivation(token: string, actor: string, delay: number): void {
    const timing = this.ownTiming(token, actor);
    const entry = this.slots.get(actor)!;
    const now = this.clock.now();
    if (timing.status !== "pending" || now < timing.opens || now > timing.latestStart ||
        !Number.isSafeInteger(delay) || delay < 0 || delay > 120_000 ||
        now + Math.max(delay, 1) > timing.latestStart)
      throw new Error("That scenario interaction is no longer available.");
    entry.status = "reserved";
    this.cancelJob(entry.job);
    this.schedule(entry.job, now + Math.max(delay, 1), () => this.activate(entry));
  }

  randomDelay(token: string, actor: string): void {
    const timing = this.ownTiming(token, actor);
    const max = Math.min(90, Math.floor((timing.latestStart - this.clock.now()) / 1000));
    if (max < 15) throw new Error("That scenario interaction is no longer available.");
    const seconds = 15 + Math.floor(this.random() * (max - 15 + 1));
    this.delayActivation(token, actor, seconds * 1000);
  }

  private async activate(entry: TimedSlot): Promise<void> {
    if (entry.status === "finished" || this.stopped || !this.environment.current()) return;
    entry.status = "finished"; // Claim before any asynchronous effect call.
    if (!this.environment.rosterMatches()) { await this.abort(); return; }
    const now = this.clock.now();
    if (this.round.stage !== "playing" || !this.environment.canPlay() ||
        now < entry.timing.opens || now > entry.timing.latestStart) return;
    const result = await this.voice.activate({
      ...this.environment.voiceRequest(entry.team, entry.slot),
      token: this.round.token, slotId: entry.job, effect: entry.slot.effect,
      latestStart: entry.timing.latestStart,
    });
    this.round.recordVoiceResult(entry.slot.ownerId, result);
  }

  async stopLiveVoice(): Promise<void> {
    if (this.round.stage !== "playing") return;
    this.stopped = true;
    this.clearJobs();
    await this.restoreEffects();
  }

  /** Called when the authoritative ordinary match ends, not when winner is set. */
  end(): Promise<void> {
    if (!this.ending) this.ending = this.endOnce();
    return this.ending;
  }

  private async endOnce(): Promise<void> {
    this.stopped = true;
    this.clearJobs();
    await this.restoreEffects();
    if (!this.environment.current() || this.aborting || this.round.stage !== "playing") return;
    if (this.cleanup && hasFailures(this.cleanup) || !this.environment.rosterMatches()) {
      await this.abort();
      return;
    }
    this.round.beginDiscussion();
    this.scheduleStage();
    await this.environment.stageChanged(this.round.stage);
  }

  private scheduleStage(): void {
    const deadline = this.round.deadline;
    if (deadline === undefined || !this.environment.current()) return;
    const stage = this.round.stage;
    const id = `scenario-runtime:${this.round.token}:stage:${stage}`;
    this.schedule(id, Math.max(this.clock.now() + 1, deadline), async () => {
      if (!this.environment.current() || this.aborting || this.round.stage !== stage) return;
      if (!this.environment.rosterMatches()) { await this.abort(); return; }
      if (this.clock.now() < deadline) { this.scheduleStage(); return; }
      const next = this.round.advance();
      this.scheduleStage();
      try { await this.environment.stageChanged(next); }
      catch { await this.abort(); }
    });
  }

  abort(): Promise<void> {
    if (!this.aborting) {
      this.stopped = true;
      this.clearJobs();
      this.round.abort();
      this.aborting = this.abortOnce();
    }
    return this.aborting;
  }

  private async abortOnce(): Promise<void> {
    await this.restoreEffects();
    if (this.environment.current() && this.round.stage === "aborted")
      await this.environment.stageChanged(this.round.stage);
  }

  private async restoreEffects(): Promise<void> {
    this.restorePending++;
    try {
      const cleanup = await this.voice.stop();
      if (this.manuallyReconciled) return;
      this.cleanup = cleanup;
      if (hasFailures(cleanup)) this.environment.cleanupRequired(cleanup);
    } finally { this.restorePending--; }
  }

  shutdownBlock(): string | null {
    if (this.restorePending) return "Scenario voice cleanup is still running.";
    if (this.cleanup && hasFailures(this.cleanup))
      return "Scenario voice cleanup requires organiser reconciliation before shutdown.";
    if (this.round.stage !== "result-ready" && this.round.stage !== "aborted")
      return "The scenario's final discussion, voting and reveal are still in progress.";
    return null;
  }

  /** Call only after an authenticated organiser explicitly confirms manual cleanup. */
  confirmManualCleanup(): void {
    if (this.restorePending || (this.round.stage !== "aborted" && this.round.stage !== "result-ready"))
      throw new Error("Stop the scenario before confirming cleanup.");
    this.manuallyReconciled = true;
    this.cleanup = undefined;
  }

  private schedule(id: string, at: number, callback: () => Promise<void>): void {
    const generation = Symbol();
    this.jobs.set(id, generation);
    this.clock.schedule(id, at, async () => {
      if (this.jobs.get(id) !== generation) return;
      this.jobs.delete(id);
      await callback();
    });
  }

  private cancelJob(id: string): void {
    if (this.jobs.delete(id)) this.clock.cancel(id);
  }

  private clearJobs(): void {
    for (const job of this.jobs.keys()) this.clock.cancel(job);
    this.jobs.clear();
  }
}
