import { selectVoiceTargets, voiceEffects, type VoiceEffectId, type VoiceOperation, type VoiceParticipant } from "./VoiceEffects";
import type { ScenarioRandom } from "./ScenarioRandom";

export interface VoiceEffectRequest {
  token: string;
  slotId: string;
  team: string;
  channelId: string;
  eligibleIds: readonly string[];
  captainId?: string;
  effect: VoiceEffectId;
  latestStart: number;
}

export interface VoiceChange {
  memberId: string;
  operation: VoiceOperation;
  originalChannel: string;
  destination?: string;
}

export interface VoiceEffectAdapter {
  inspect(ids: readonly string[], channelId: string): Promise<VoiceParticipant[]>;
  createIsolation(request: VoiceEffectRequest, selected: readonly string[]): Promise<string>;
  /** Recheck membership, permissions and original state immediately before applying. */
  apply(change: VoiceChange, canApply: () => boolean): Promise<"applied" | "skipped" | "uncertain">;
  /** Never force reconnect; preserve known moderation conflicts and voluntary moves. */
  restore(change: VoiceChange): Promise<"restored" | "unchanged" | "unresolved">;
  /** Only delete an owned, empty channel. */
  removeIsolation(channelId: string): Promise<boolean>;
  /** Restricted operational receipts; no role or ballot information. */
  receipt(event: "intent" | "applied" | "uncertain" | "restored" | "unresolved", change: VoiceChange): void;
}

interface ActiveEffect {
  request: VoiceEffectRequest;
  changes: VoiceChange[];
  uncertain: VoiceChange[];
  destination?: string;
  uncertainIsolation?: boolean;
  startedAt?: number;
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  application?: Promise<VoiceEffectStatus>;
  restoration?: Promise<VoiceCleanup>;
}

export type VoiceEffectStatus = "fulfilled" | "void";
export interface VoiceCleanup {
  unresolved: VoiceChange[];
  channels: string[];
}

/** One instance per match. Never reuse after stop(). */
export class VoiceEffectService {
  private readonly active = new Map<string, ActiveEffect>();
  private readonly used = new Set<string>();
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly adapter: VoiceEffectAdapter,
    private readonly current: () => boolean,
    private readonly now = Date.now,
    private readonly random: ScenarioRandom = Math.random
  ) {}

  activate(request: VoiceEffectRequest): Promise<VoiceEffectStatus> {
    if (this.stopped || !this.current() || request.token !== this.token ||
        this.now() > request.latestStart || this.used.has(request.slotId) ||
        this.active.has(request.team)) return Promise.resolve("void");
    this.used.add(request.slotId);
    const effect: ActiveEffect = {
      request: { ...request, eligibleIds: [...request.eligibleIds] },
      changes: [], uncertain: [], stopped: false,
    };
    this.active.set(request.team, effect);
    effect.application = this.apply(effect);
    return effect.application;
  }

  private canApply(effect: ActiveEffect): boolean {
    return !this.stopped && !effect.stopped && this.current() &&
      this.now() <= effect.request.latestStart;
  }

  private async apply(effect: ActiveEffect): Promise<VoiceEffectStatus> {
    const request = effect.request;
    const definition = voiceEffects[request.effect];
    let applied = false;
    try {
      const states = await this.adapter.inspect(request.eligibleIds, request.channelId);
      const eligible = new Set(request.eligibleIds);
      const unique = new Map(states.filter((p) => eligible.has(p.id)).map((p) => [p.id, p]));
      const targets = selectVoiceTargets(request.effect, request.channelId, [...unique.values()], request.captainId, this.random);
      if (targets.length && this.canApply(effect)) {
        if (definition.operation === "move") {
          effect.uncertainIsolation = true;
          effect.destination = await this.adapter.createIsolation(request, targets);
          effect.uncertainIsolation = false;
        }
        for (const memberId of targets) {
          if (!this.canApply(effect)) break;
          const change: VoiceChange = {
            memberId, operation: definition.operation,
            originalChannel: request.channelId, destination: effect.destination,
          };
          this.adapter.receipt("intent", change);
          // A failed response is not evidence that Discord did not apply the request.
          let result: "applied" | "skipped" | "uncertain";
          effect.startedAt ??= this.now();
          try { result = await this.adapter.apply(change, () => this.canApply(effect)); }
          catch { result = "uncertain"; }
          if (result === "applied") {
            effect.changes.push(change);
            this.adapter.receipt("applied", change);
          } else if (result === "uncertain") {
            effect.uncertain.push(change);
            this.adapter.receipt("uncertain", change);
          }
        }
        applied = effect.changes.length === targets.length && effect.uncertain.length === 0;
      }
    } catch {
      // The caller gets neutral credit; known changes still go through cleanup.
      applied = false;
    }
    if (!applied || !this.canApply(effect)) {
      // Do not await restore() here: it waits for this application to settle.
      queueMicrotask(() => { void this.restore(effect); });
    } else {
      const expires = (effect.startedAt ?? this.now()) + definition.durationMs;
      effect.timer = setTimeout(() => { void this.restore(effect); }, Math.max(0, expires - this.now()));
    }
    return applied ? "fulfilled" : "void";
  }

  private restore(effect: ActiveEffect): Promise<VoiceCleanup> {
    effect.stopped = true;
    if (effect.timer) clearTimeout(effect.timer);
    if (!effect.restoration) effect.restoration = this.restoreOnce(effect);
    return effect.restoration;
  }

  private async restoreOnce(effect: ActiveEffect): Promise<VoiceCleanup> {
    await effect.application;
    const unresolved = [...effect.uncertain];
    for (const change of effect.changes) {
      let result: "restored" | "unchanged" | "unresolved";
      try { result = await this.adapter.restore(change); }
      catch { result = "unresolved"; }
      this.adapter.receipt(result === "unresolved" ? "unresolved" : "restored", change);
      if (result === "unresolved") unresolved.push(change);
    }
    const channels: string[] = effect.uncertainIsolation ? [`unknown isolation from ${effect.request.channelId}`] : [];
    if (effect.destination) {
      try {
        if (!(await this.adapter.removeIsolation(effect.destination))) channels.push(effect.destination);
      } catch { channels.push(effect.destination); }
    }
    // Retain failures for authorised manual reconciliation; don't start more
    // effects on this team or repeat uncertain mutations.
    if (!unresolved.length && !channels.length) this.active.delete(effect.request.team);
    return { unresolved, channels };
  }

  async stop(): Promise<VoiceCleanup> {
    this.stopped = true;
    const results = await Promise.all([...this.active.values()].map((effect) => this.restore(effect)));
    return { unresolved: results.flatMap((r) => r.unresolved), channels: results.flatMap((r) => r.channels) };
  }
}
