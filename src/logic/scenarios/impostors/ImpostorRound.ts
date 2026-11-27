import { PrivateBallot, type BallotTally } from "../shared/PrivateBallot";
import type { ScenarioRandom } from "../shared/ScenarioRandom";
import { drawImpostors, drawMissionHand, impostorsPerTeam, rerollMission, validateMissionClaims, type ImpostorRoster, type ImpostorTeam, type MissionId } from "./ImpostorMissions";
import { assignmentResult, coverResult, impostorOutcome, teamDeduction, type VoiceCredit } from "./ImpostorScoring";
import { drawVoiceSlots, type ImpostorVoiceSlot } from "./ImpostorVoiceSlots";

export type ImpostorStage = "preparation" | "playing" | "discussion" | "voting" |
  "claims" | "mission-reveal" | "result-ready" | "aborted";

interface SecretRole {
  hand: MissionId[];
  rerolled: boolean;
  slot: ImpostorVoiceSlot;
  claims: MissionId[];
  voice: VoiceCredit;
}

const teams = ["RED", "BLUE"] as const;
export const postgameDuration = {
  discussion: 240_000,
  voting: 90_000,
  claims: 90_000,
  "mission-reveal": 45_000,
} as const;

function unavailable(): never {
  throw new Error("That scenario interaction is no longer available.");
}

/** Match-owned domain state, independent of Discord and timers. Never serialize private fields. */
export class ImpostorRound {
  private readonly sides = new Map<string, ImpostorTeam>();
  private readonly secrets = new Map<string, SecretRole>();
  private readonly seen = new Set<string>();
  private readonly predictions: Record<ImpostorTeam, PrivateBallot>;
  private readonly votes: Record<ImpostorTeam, PrivateBallot>;
  private readonly roster: ImpostorRoster;
  private readonly assigned: Record<ImpostorTeam, string[]>;
  private tallies?: Record<ImpostorTeam, BallotTally>;
  private awards: Record<ImpostorTeam, { psychic: number; sixthSense: number; masterDetective: number }> = {
    RED: { psychic: 0, sixthSense: 0, masterDetective: 0 },
    BLUE: { psychic: 0, sixthSense: 0, masterDetective: 0 },
  };
  private currentStage: ImpostorStage = "preparation";
  private currentDeadline?: number;
  readonly count: number;

  constructor(
    readonly token: string,
    roster: ImpostorRoster,
    private readonly now = Date.now,
    private readonly random: ScenarioRandom = Math.random
  ) {
    this.roster = { RED: [...roster.RED], BLUE: [...roster.BLUE] };
    this.count = impostorsPerTeam(this.roster);
    this.assigned = drawImpostors(this.roster, random);
    for (const team of teams) {
      for (const id of this.roster[team]) this.sides.set(id, team);
      for (const slot of drawVoiceSlots(this.assigned[team], random)) {
        this.secrets.set(slot.ownerId, {
          hand: drawMissionHand(random), rerolled: false, slot,
          claims: [], voice: "void",
        });
      }
    }
    this.predictions = this.newBallots();
    this.votes = this.newBallots();
  }

  get stage(): ImpostorStage { return this.currentStage; }
  get deadline(): number | undefined { return this.currentDeadline; }

  private newBallots(): Record<ImpostorTeam, PrivateBallot> {
    return {
      RED: new PrivateBallot(this.roster.RED, this.roster.RED, this.count),
      BLUE: new PrivateBallot(this.roster.BLUE, this.roster.BLUE, this.count),
    };
  }

  private require(token: string, actor: string, stage: ImpostorStage): ImpostorTeam {
    const team = this.sides.get(actor);
    if (token !== this.token || !team || this.stage !== stage ||
        (this.deadline !== undefined && this.now() >= this.deadline)) return unavailable();
    return team;
  }

  /** View only the authenticated actor's own card; no co-impostor identities. */
  ownCard(token: string, actor: string) {
    if (this.stage !== "preparation" && this.stage !== "playing") return unavailable();
    this.require(token, actor, this.stage);
    const secret = this.secrets.get(actor);
    return secret
      ? { role: "impostor" as const, hand: [...secret.hand], rerolled: secret.rerolled, slot: { ...secret.slot } }
      : { role: "innocent" as const };
  }

  acknowledge(token: string, actor: string): void {
    this.require(token, actor, "preparation");
    this.seen.add(actor);
  }

  ready(): boolean {
    return this.stage === "preparation" && this.seen.size === this.sides.size;
  }

  reroll(token: string, actor: string, unwanted: MissionId): void {
    this.require(token, actor, "preparation");
    const secret = this.secrets.get(actor);
    if (!secret || secret.rerolled) return unavailable();
    secret.hand = rerollMission(secret.hand, unwanted, this.random);
    secret.rerolled = true;
  }

  ballot(token: string, actor: string) {
    const stage = this.stage;
    if (stage !== "preparation" && stage !== "voting") return unavailable();
    const team = this.require(token, actor, stage);
    const box = (stage === "preparation" ? this.predictions : this.votes)[team];
    return { choices: box.choicesFor(actor), submitted: box.ownResponse(actor), max: this.count };
  }

  submitBallot(token: string, actor: string, choices: readonly string[]): void {
    const stage = this.stage;
    if (stage !== "preparation" && stage !== "voting") return unavailable();
    const team = this.require(token, actor, stage);
    (stage === "preparation" ? this.predictions : this.votes)[team].submit(actor, choices);
  }

  matchesRoster(roster: ImpostorRoster): boolean {
    return teams.every((team) => this.roster[team].length === roster[team].length &&
      new Set(roster[team]).size === roster[team].length &&
      roster[team].every((id) => this.sides.get(id) === team));
  }

  beginPlaying(): void {
    if (!this.ready()) throw new Error("Private role delivery is incomplete.");
    for (const team of teams) this.predictions[team].lock();
    this.currentStage = "playing";
  }

  /** Internal scheduling input, not a player or organiser projection. */
  scheduledSlots(): { team: ImpostorTeam; slot: ImpostorVoiceSlot }[] {
    if (this.stage !== "playing") return [];
    return [...this.secrets].map(([actor, secret]) => ({
      team: this.sides.get(actor)!, slot: { ...secret.slot },
    }));
  }

  ownVoiceSlot(token: string, actor: string): ImpostorVoiceSlot {
    this.require(token, actor, "playing");
    const secret = this.secrets.get(actor);
    if (!secret) return unavailable();
    return { ...secret.slot };
  }

  recordVoiceResult(actor: string, credit: VoiceCredit): void {
    // An in-flight effect may settle while end is restoring it.
    if (this.stage !== "playing" && this.stage !== "discussion") return;
    const secret = this.secrets.get(actor);
    if (secret && credit === "fulfilled") secret.voice = credit;
  }

  beginDiscussion(): void {
    if (this.stage !== "playing") return unavailable();
    this.transition("discussion");
  }

  /** Only the current stage's deadline permits progression. */
  advance(): ImpostorStage {
    if (this.deadline === undefined || this.now() < this.deadline) return unavailable();
    switch (this.stage) {
      case "discussion": this.transition("voting"); break;
      case "voting":
        this.tallies = { RED: this.votes.RED.lock(), BLUE: this.votes.BLUE.lock() };
        this.computeAwards();
        this.transition("claims");
        break;
      case "claims": this.transition("mission-reveal"); break;
      case "mission-reveal": this.transition("result-ready"); break;
      default: return unavailable();
    }
    return this.stage;
  }

  private transition(stage: ImpostorStage): void {
    this.currentStage = stage;
    this.currentDeadline = stage in postgameDuration
      ? this.now() + postgameDuration[stage as keyof typeof postgameDuration] : undefined;
  }

  ownClaims(token: string, actor: string) {
    this.require(token, actor, "claims");
    const secret = this.secrets.get(actor);
    if (!secret) return unavailable();
    return { hand: [...secret.hand], claims: [...secret.claims] };
  }

  submitClaims(token: string, actor: string, claims: readonly MissionId[]): void {
    this.require(token, actor, "claims");
    const secret = this.secrets.get(actor);
    if (!secret) return unavailable();
    secret.claims = validateMissionClaims(secret.hand, claims);
  }

  anonymousClaims() {
    if (this.stage !== "mission-reveal" && this.stage !== "result-ready") return unavailable();
    const result = { RED: {} as Partial<Record<MissionId, number>>, BLUE: {} as Partial<Record<MissionId, number>> };
    for (const [actor, secret] of this.secrets) {
      const list = result[this.sides.get(actor)!];
      for (const id of secret.claims) list[id] = (list[id] ?? 0) + 1;
    }
    return result;
  }

  /** Historical/public projection: never contains raw ballots or unclaimed missions. */
  result(winner: ImpostorTeam | null) {
    if (this.stage === "aborted") return { status: "void" as const };
    if (this.stage !== "result-ready" || !this.tallies) return null;
    const tallies = this.tallies;
    const side = (team: ImpostorTeam) => ({
      deduction: teamDeduction(this.assigned[team], tallies[team]),
      definiteAccusations: [...tallies[team].definite],
      awards: { ...this.awards[team] },
      impostors: this.assigned[team].map((id) => {
        const secret = this.secrets.get(id)!;
        const assignment = assignmentResult(secret.claims.length, secret.voice);
        const cover = coverResult(id, tallies[team]);
        const won = winner === null ? null : winner === team;
        return {
          id, claims: [...secret.claims], voiceEffect: secret.slot.effect, voice: secret.voice,
          won, assignment, cover, outcome: impostorOutcome(won, assignment, cover),
          masterOfDeception: assignment === "pass" && tallies[team].complete && !tallies[team].counts.has(id),
        };
      }),
    });
    return { status: "revealed" as const, RED: side("RED"), BLUE: side("BLUE") };
  }

  abort(): void {
    if (this.stage === "result-ready") return;
    this.transition("aborted");
    this.secrets.clear();
    this.tallies = undefined;
    for (const team of teams) {
      this.predictions[team].discardResponses();
      this.votes[team].discardResponses();
    }
  }

  private computeAwards(): void {
    for (const team of teams) {
      const correct = new Set(this.assigned[team]);
      for (const actor of this.roster[team]) {
        const predicted = this.predictions[team].ownResponse(actor) ?? [];
        const final = this.votes[team].ownResponse(actor) ?? [];
        const hits = predicted.filter((id) => correct.has(id)).length;
        if (hits === this.count) this.awards[team].psychic++;
        else if (hits > 0) this.awards[team].sixthSense++;
        if (final.length === this.count && final.every((id) => correct.has(id)))
          this.awards[team].masterDetective++;
      }
      this.predictions[team].discardResponses();
      this.votes[team].discardResponses();
    }
  }
}
