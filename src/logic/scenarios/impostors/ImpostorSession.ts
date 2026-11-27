import type { Guild, GuildMember } from "discord.js";
import type { GameInstance } from "../../../database/GameInstance";
import { ConfigManager } from "../../../ConfigManager";
import { Scheduler } from "../../../util/SchedulerUtil";
import { DiscordUtil } from "../../../util/DiscordUtil";
import { escapeText } from "../../../util/Utils";
import { GameRecoveryCoordinator } from "../../ActiveGameRecovery";
import { MatchRecoveryGate } from "../../MatchRecoveryGate";
import TeamCommand from "../../../commands/TeamCommand";
import { openScenarioButton } from "../ScenarioPromptDelivery";
import { participantLabel } from "../ScenarioGameplay";
import type { ScenarioRuntimeSession } from "../ScenarioRuntimeSession";
import type { ScenarioValue } from "../ScenarioTypes";
import { DiscordStreamRestrictions } from "../shared/DiscordStreamRestrictions";
import { DiscordVoiceEffectAdapter } from "../shared/DiscordVoiceEffectAdapter";
import { VoiceEffectService } from "../shared/VoiceEffectService";
import { ImpostorRound, type ImpostorStage } from "./ImpostorRound";
import { ImpostorRuntime } from "./ImpostorRuntime";
import { ImpostorPrivateControls } from "./ImpostorPrivateControls";
import { impostorMissions, type ImpostorTeam, type MissionId } from "./ImpostorMissions";

const teams = ["RED", "BLUE"] as const;
const missionLabel = (id: MissionId) => impostorMissions.find((m) => m.id === id)?.label ?? id;

/** Discord adapter for the optional live/post-game capability, owned by ScenarioCoordinator. */
export class ImpostorSession implements ScenarioRuntimeSession {
  readonly token: string;
  private readonly runtime: ImpostorRuntime;
  private readonly controls: ImpostorPrivateControls;
  private readonly streams: DiscordStreamRestrictions;
  private readonly channels: Record<ImpostorTeam, string>;
  private readonly spectatorRole: string;
  private readonly roles: Record<ImpostorTeam, string>;
  private voiceIssues: string[] = [];
  private streamIssues: string[] = [];
  private streamRestore?: Promise<void>;
  private continuation?: () => Promise<void>;
  private continuationStarted = false;
  private continuationFailed = false;
  private aborting?: Promise<void>;
  private abortPending = false;
  private continuationPending = false;
  private readonly moderationConflicts = new Set<string>();

  constructor(private readonly game: GameInstance, private readonly guild: Guild) {
    this.token = game.getLifecycleToken();
    const config = ConfigManager.getConfig();
    this.channels = { RED: config.channels.redTeamVC, BLUE: config.channels.blueTeamVC };
    this.roles = { RED: config.roles.redTeamRole, BLUE: config.roles.blueTeamRole };
    this.spectatorRole = config.roles.spectatorRole;
    const round = new ImpostorRound(this.token, this.roster());
    const adapter = new DiscordVoiceEffectAdapter(guild, this.token,
      (member, channel) => this.eligible(member, channel),
      (id) => this.moderationConflicts.has(id));
    const voice = new VoiceEffectService(this.token, adapter,
      () => this.canPlay() && round.matchesRoster(this.roster()));
    this.streams = new DiscordStreamRestrictions(guild, this.token,
      () => this.current() && !this.game.isFinished && round.matchesRoster(this.roster()),
      (id) => this.moderationConflicts.has(id));
    this.runtime = new ImpostorRuntime(round, voice, {
      now: Date.now,
      schedule: (id, at, callback) => Scheduler.schedule(id, async () => {
        const run = async () => { if (this.current()) await callback(); };
        if (TeamCommand.instance) await TeamCommand.instance.runRosterOperation(run);
        else await run();
      }, new Date(Math.max(at, Date.now() + 5))),
      cancel: (id) => Scheduler.cancel(id),
    }, {
      current: () => this.current(),
      canPlay: () => this.canPlay(),
      rosterMatches: () => round.matchesRoster(this.roster()),
      voiceRequest: (team) => ({
        team, channelId: this.channels[team], eligibleIds: this.roster()[team],
        captainId: this.game.getCaptainOfTeam(team)?.discordSnowflake,
      }),
      stageChanged: (stage) => this.stageChanged(stage),
      cleanupRequired: (cleanup) => {
        this.voiceIssues = [
          ...cleanup.unresolved.map((c) => `${c.memberId} (${c.operation}, channel ${c.originalChannel})`),
          ...cleanup.channels,
        ];
        console.error(`event=scenario.voice.cleanup match=${this.token} unresolved=${this.voiceIssues.join(",")}`);
      },
    });
    this.controls = new ImpostorPrivateControls(this.runtime, (id) => escapeText(participantLabel(game, id)));
  }

  private current(): boolean {
    return this.game.getLifecycleToken() === this.token && this.game.announced &&
      this.game.scenarios.selectedId === "the-impostors";
  }

  private canPlay(): boolean {
    return this.current() && this.game.getGameStartStatus() === "started" && !this.game.isFinished &&
      !this.game.gameWinner && !this.game.isRestarting &&
      !GameRecoveryCoordinator.isFrozen() && !MatchRecoveryGate.getBlockReason();
  }

  private roster() {
    return {
      RED: this.game.getPlayersOfTeam("RED").map((p) => p.discordSnowflake),
      BLUE: this.game.getPlayersOfTeam("BLUE").map((p) => p.discordSnowflake),
    };
  }

  private eligible(member: GuildMember, channel: string): boolean {
    if (!this.current() || member.roles.cache.has(this.spectatorRole)) return false;
    return teams.some((team) => channel === this.channels[team] &&
      this.roster()[team].includes(member.id) && member.roles.cache.has(this.roles[team]));
  }

  private streamTeams() {
    return teams.map((team) => ({ channelId: this.channels[team], memberIds: this.roster()[team] }));
  }

  prepare(): void {
    this.promptEveryone("Teams are set! Check your private role and optionally make an early guess. Screensharing in team voice chat is not allowed.");
  }

  private promptEveryone(content: string): void {
    const stage = this.runtime.round.stage;
    // Deliver privately outside the roster lock; no public per-player failure or secret status.
    queueMicrotask(() => {
      void (async () => {
        if (!this.current() || this.runtime.round.stage !== stage) return;
        await this.notify(content, true);
        const roster = this.roster();
        await Promise.allSettled([...roster.RED, ...roster.BLUE].map(async (id) => {
          if (!this.current() || this.runtime.round.stage !== stage) return;
          const member = await this.guild.members.fetch(id).catch(() => null);
          if (!member || !this.current() || this.runtime.round.stage !== stage) return;
          const prompt = this.open(id);
          if (!prompt) return;
          await member.send({ content: prompt.content, components: prompt.components });
          if (this.current() && this.runtime.round.stage === stage) this.delivered(id);
        }));
      })().catch(() => { /* Generic feed and self-service reopen remain available. */ });
    });
  }

  private async notify(content: string, open = false): Promise<void> {
    if (!this.current()) return;
    await DiscordUtil.sendMessage("gameFeed", {
      content, components: open ? [openScenarioButton(this.game)] : [],
      allowedMentions: { parse: [] },
    }).catch(() => { /* Private reopen remains available if a notification fails. */ });
  }

  open(actorId: string) {
    if (!this.current() || !this.runtime.round.matchesRoster(this.roster()) ||
        !this.game.getPlayers().some((p) => p.discordSnowflake === actorId)) return null;
    return this.controls.open(actorId);
  }

  apply(customId: string, actorId: string, value: ScenarioValue) {
    if (!this.current() || !this.runtime.round.matchesRoster(this.roster()) ||
        !this.game.getPlayers().some((p) => p.discordSnowflake === actorId))
      throw new Error("That scenario interaction is no longer available.");
    const prompt = this.controls.apply(customId, actorId, value);
    // A successful control proves the actor could access the role card.
    this.delivered(actorId);
    return prompt;
  }

  delivered(actorId: string): void {
    if (this.current() && this.runtime.round.stage === "preparation") {
      try { this.runtime.round.acknowledge(this.token, actorId); }
      catch { /* No longer an eligible participant. */ }
    }
  }

  startBlock(): string | null {
    if (this.abortPending || this.streamRestore) return "Scenario cleanup is still running.";
    if (this.voiceIssues.length || this.streamIssues.length)
      return "Scenario permission cleanup requires organiser reconciliation.";
    const round = this.runtime.round;
    if (round.stage === "aborted") return null;
    if (!round.matchesRoster(this.roster())) return "Scenario roster changed; stop the scenario before starting.";
    if (!round.ready()) return "Waiting for everyone to receive or privately open their role card. Use /game scenario open; organisers can stop the scenario if needed.";
    if (!this.game.startTime) return "An announced start time is required.";
    return null;
  }

  async beforeStart(): Promise<void> {
    if (this.runtime.round.stage === "aborted") return;
    const block = this.startBlock();
    if (block) throw new Error(`Game start blocked: ${block}`);
    try {
      await this.streams.enforce(this.streamTeams());
    } catch {
      await this.restoreStreams();
      if (this.streamIssues.length) await this.abort();
      throw new Error("Game start blocked: Team voice permissions or active screenshares need organiser review. No scenario effects were scheduled.");
    }
  }

  async startFailed(): Promise<void> {
    await this.restoreStreams();
    if (this.streamIssues.length) await this.abort();
  }

  async started(): Promise<void> {
    if (this.runtime.round.stage === "aborted") return;
    try {
      await this.streams.verify(this.streamTeams());
      this.runtime.start(this.game.startTime!.getTime());
    } catch {
      await this.abort();
      await this.notify("The Impostors could not start safely. The normal match continues without scenario scoring.");
    }
  }

  async winnerReported(): Promise<void> {
    if (this.runtime.round.stage === "result-ready") {
      await this.notify("The normal match winner has been updated. Scenario outcomes below use the updated winner; ballots and claims are unchanged.");
      await this.reveal();
      return;
    }
    await this.runtime.stopLiveVoice();
  }

  async end(continueOrdinaryEnd: () => Promise<void>): Promise<void> {
    this.continuation ??= continueOrdinaryEnd;
    await this.runtime.end();
    if (this.runtime.round.stage !== "discussion") await this.continueOrdinaryEnd();
  }

  private async continueOrdinaryEnd(): Promise<void> {
    if (!this.continuation || this.continuationStarted || !this.current()) return;
    this.continuationStarted = true;
    this.continuationPending = true;
    try { await this.continuation(); }
    catch {
      this.continuationFailed = true;
      console.error(`event=scenario.end.continuation match=${this.token} status=failed`);
    } finally { this.continuationPending = false; }
  }

  private async stageChanged(stage: ImpostorStage): Promise<void> {
    if (!this.current()) return;
    if (stage === "discussion") {
      await this.notify("The game has ended! Stay in your own team voice chat and discuss your suspicions for four minutes.");
    } else if (stage === "voting") {
      this.promptEveryone("Time to vote privately for the impostors on your team. You have 90 seconds. No mission reveals yet!");
    } else if (stage === "claims") {
      this.promptEveryone("Both teams' votes are locked. Impostors can now privately report which missions they completed. You have 90 seconds.");
      await this.restoreStreams();
      await this.continueOrdinaryEnd();
    } else if (stage === "mission-reveal") {
      const claims = this.runtime.round.anonymousClaims();
      for (const team of teams) {
        const list = Object.entries(claims[team]).map(([id, count]) =>
          `${missionLabel(id as MissionId)}${count > 1 ? ` (x${count})` : ""}`).join(", ");
        await this.notify(`**${team} - missions reported complete:** ${list || "None"}\nThese are self-reported, not verified. Have one last guess before the reveal!`);
      }
    } else if (stage === "result-ready") {
      await this.reveal();
    } else if (stage === "aborted") {
      await this.restoreStreams();
      await this.continueOrdinaryEnd();
      await this.notify("The Impostors has been stopped. There is no scenario result; the ordinary match result still counts.");
    }
  }

  private async reveal(): Promise<void> {
    const result = this.runtime.round.result(this.game.gameWinner ?? null);
    if (result?.status !== "revealed") return;
    for (const team of teams) {
      const side = result[team];
      const lines = side.impostors.map((actor) => {
        const name = escapeText(participantLabel(this.game, actor.id));
        return `**${name}** - ${actor.outcome}\nReported missions: ${actor.claims.map(missionLabel).join(", ") || "None"}\nSabotage: ${actor.voiceEffect} (${actor.voice}); cover: ${actor.cover}.${actor.masterOfDeception ? " Master of Deception!" : ""}`;
      });
      const accused = side.definiteAccusations.map((id) => escapeText(participantLabel(this.game, id))).join(", ") || "None";
      await this.notify(`**${team} - The Impostors revealed!**\n${lines.join("\n\n")}\nDefinite accusations: ${accused}\nTeam deduction: ${side.deduction.result} (${side.deduction.exposed} exposed).\nFirst Impressions: ${side.awards.psychic} Psychic, ${side.awards.sixthSense} Sixth Sense; ${side.awards.masterDetective} Master Detective. ${this.game.gameWinner ? "" : "Normal winner not reported yet."}`);
    }
  }

  async rosterChanged(): Promise<void> {
    if (!this.runtime.round.matchesRoster(this.roster())) await this.abort();
  }

  invalidate(): void {
    void this.abort().catch(() => { console.error(`event=scenario.invalidate match=${this.token} status=failed`); });
  }

  abort(): Promise<void> {
    if (!this.aborting) {
      this.abortPending = true;
      this.aborting = (async () => {
        await this.runtime.abort();
        await this.restoreStreams();
        await this.continueOrdinaryEnd();
      })().finally(() => { this.abortPending = false; });
    }
    return this.aborting;
  }

  private async restoreStreams(): Promise<void> {
    if (!this.streamRestore) {
      this.streamRestore = (async () => {
        this.streamIssues = await this.streams.restore();
        if (this.streamIssues.length)
          console.error(`event=scenario.stream.cleanup match=${this.token} unresolved=${this.streamIssues.join(",")}`);
      })().finally(() => { this.streamRestore = undefined; });
    }
    await this.streamRestore;
  }

  async preserveModeration(memberId: string): Promise<void> {
    if (!this.current() || !this.game.getPlayers().some(p => p.discordSnowflake === memberId))
      throw new Error("Select a current participant whose voice state staff must retain.");
    this.moderationConflicts.add(memberId);
    await this.abort();
  }

  confirmManualCleanup(): void {
    if (this.abortPending || this.streamRestore || this.continuationPending)
      throw new Error("Wait for automatic cleanup to finish before confirming manual reconciliation.");
    this.runtime.confirmManualCleanup();
    this.streams.acknowledgeManualCleanup();
    this.voiceIssues = [];
    this.streamIssues = [];
    this.continuationFailed = false;
  }

  shutdownBlock(): string | null {
    if (this.abortPending || this.streamRestore || this.continuationPending)
      return "Scenario cleanup is still running.";
    if (this.streamIssues.length || this.voiceIssues.length || this.continuationFailed)
      return "Scenario cleanup needs organiser reconciliation before shutdown.";
    return this.runtime.shutdownBlock();
  }

  summary(): string {
    const round = this.runtime.round;
    return [
      `Runtime: ${round.stage}`,
      round.deadline ? `Next stage: <t:${Math.floor(round.deadline / 1000)}:R>` : "",
      round.stage === "preparation" ? (this.startBlock() ?? "All private role cards delivered.") : "",
      this.voiceIssues.length ? `Voice cleanup - inspect: ${this.voiceIssues.join(", ")}` : "",
      this.streamIssues.length ? `Stream overwrites - channel/member: ${this.streamIssues.join(", ")}` : "",
      this.continuationFailed ? "Ordinary post-game continuation failed; inspect channels and MVP prompts." : "",
    ].filter(Boolean).join("\n").slice(0, 1400);
  }

  publicResult(): ScenarioValue | null {
    const result = this.runtime.round.result(this.game.gameWinner ?? null);
    if (!result) return null;
    if (result.status === "void") return { status: "void" };
    return { status: result.status, RED: result.RED, BLUE: result.BLUE };
  }
}
