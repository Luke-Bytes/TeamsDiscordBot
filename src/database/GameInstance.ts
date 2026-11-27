import NeedCommand from "../commands/NeedCommand";
import { $Enums, AnniMap, Team } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { MatchRecoveryGate } from "../logic/MatchRecoveryGate";
import { GameRecoveryCoordinator } from "../logic/ActiveGameRecovery";
import type { DraftRecoveryProgress } from "../logic/ActiveGameRecovery";
import {
  CacheType,
  CacheTypeReducer,
  Guild,
  Message,
  Snowflake,
} from "discord.js";
import { PlayerInstance } from "./PlayerInstance";
import { MapVoteManager } from "../logic/MapVoteManager";
import { RegistrationIdentity } from "./RegistrationIdentity";
import { SeasonService } from "./SeasonService";
import { MojangAPI } from "../api/MojangAPI";
import { fetchGuildMember } from "../util/DiscordFailures";
import { MinerushVoteManager } from "../logic/MinerushVoteManager";
import { prismaClient } from "./prismaClient";
import { ConfigManager } from "../ConfigManager";
import { DiscordUtil } from "../util/DiscordUtil";
import { activateFeed } from "../logic/gameFeed/ActivateFeed";
import { Channels } from "../Channels";
import { addRegisteredPlayersFeed } from "../logic/gameFeed/RegisteredGameFeed";
import { addTeamsGameFeed } from "../logic/gameFeed/TeamsGameFeed";
import { Elo } from "../logic/Elo";
import { ModifierSelector } from "../logic/ModifierSelector";
import { TeamPlanRecord } from "../util/PlanUtil";
import { PrismaUtils } from "../util/PrismaUtils";
import { escapeIgn } from "../util/Utils";
import { ScenarioCoordinator } from "../logic/scenarios/ScenarioCoordinator";

export type ModifierMode = "custom" | "randomised" | "default" | "none";
export type GameStartStatus = "idle" | "starting" | "started";
export type GameStartAttempt = "acquired" | "inProgress" | "alreadyStarted";

// wrapper class for Game
export class GameInstance {
  public static readonly MIN_ELO_PLAYER_COUNT = 20;
  public static readonly MIN_AUTO_START_REGISTERED_COUNT = 15;
  private static instance: GameInstance;
  gameId?: string;
  isFinished?: boolean;
  announced = false;
  /** Recovery-only diagnostics: incomplete workflows are retained but not restarted. */
  recoveryPausedWorkflows: string[] = [];
  recoveryDraftProgress?: DraftRecoveryProgress;
  isRestarting = false;
  isDoubleElo = false;
  isRelaxedSeason = false;
  noElo = false;
  /** Explicit organiser selection, independent of attendance and season rules. */
  organiserNoElo = false;
  readonly scenarios = new ScenarioCoordinator(this);
  private gameStartStatus: GameStartStatus = "idle";
  private lifecycleVersion = 0;
  private lifecycleToken = randomUUID();
  startTime?: Date;
  endTime?: Date;
  settings: {
    organiserBannedClasses: $Enums.AnniClass[];
    sharedCaptainBannedClasses: $Enums.AnniClass[];
    nonSharedCaptainBannedClasses: Record<Team, $Enums.AnniClass[]>;
    map?: $Enums.AnniMap;
    modifiers: { category: string; name: string }[];
    delayedBan: number;
  } = {
    organiserBannedClasses: [],
    sharedCaptainBannedClasses: [],
    nonSharedCaptainBannedClasses: { [Team.RED]: [], [Team.BLUE]: [] },
    modifiers: [],
    delayedBan: 0,
  };

  public classBanMode: "shared" | "opponentOnly" | null = null;

  teams: Record<Team | "UNDECIDED", PlayerInstance[]> = {
    RED: [],
    BLUE: [],
    UNDECIDED: [],
  };
  lateSignups: Set<string> = new Set();
  captainNominations: Set<string> = new Set();
  private readonly captainBanLocked: Set<string> = new Set();

  blueMeanElo?: number;
  redMeanElo?: number;
  blueExpectedScore?: number;
  redExpectedScore?: number;

  gameWinner?: "RED" | "BLUE";
  teamsDecidedBy?:
    | "DRAFT"
    | "SNAKE_DRAFT"
    | "RANDOMISED"
    | "ELO"
    | "BALANCE"
    | null;

  MVPPlayerBlue?: string;
  MVPPlayerRed?: string;

  organiser?: string | null;
  host?: string | null;
  lastRegisteredSnowflake?: Snowflake;
  announcementPreviewMessage?: Message<boolean>;
  announcementMessage?: Message<boolean>;
  announcementPingMessage?: Message<boolean>;
  redTeamPlan?: TeamPlanRecord;
  blueTeamPlan?: TeamPlanRecord;

  mapVoteManager?: MapVoteManager;
  minerushVoteManager?: MinerushVoteManager;
  private readonly mvpVoters = new Set<string>();

  mvpVotes: {
    RED: Record<string, number>;
    BLUE: Record<string, number>;
  } = {
    RED: {},
    BLUE: {},
  };

  public pickOtherTeamsSupportRoles: boolean = false;
  public modifierMode: ModifierMode = "default";

  public classBanLimit: number = 0;
  private readonly captainBanCounts: Map<string, number> = new Map();
  private classBansAnnounced: boolean = false;

  private constructor() {
    this.reset();
  }

  public static getInstance(): GameInstance {
    if (!GameInstance.instance) {
      GameInstance.instance = new GameInstance();
    }
    return GameInstance.instance;
  }

  public reset() {
    this.scenarios.assertRuntimeResetSafe();
    void NeedCommand.instance?.expireAll();
    this.lifecycleVersion += 1;
    this.lifecycleToken = randomUUID();
    this.gameId = undefined;
    this.isFinished = undefined;
    this.announced = false;
    this.recoveryPausedWorkflows = [];
    this.recoveryDraftProgress = undefined;
    this.isRestarting = false;
    this.isDoubleElo = false;
    this.isRelaxedSeason = false;
    this.noElo = false;
    this.organiserNoElo = false;
    this.scenarios.reset();
    this.gameStartStatus = "idle";
    this.startTime = undefined;
    this.endTime = undefined;
    this.gameWinner = undefined;
    this.organiser = undefined;
    this.host = undefined;
    this.blueMeanElo = undefined;
    this.redMeanElo = undefined;
    this.blueExpectedScore = undefined;
    this.redExpectedScore = undefined;
    this.settings = {
      organiserBannedClasses: [],
      sharedCaptainBannedClasses: [],
      nonSharedCaptainBannedClasses: { [Team.RED]: [], [Team.BLUE]: [] },
      map: undefined,
      modifiers: [],
      delayedBan: 0,
    };
    this.classBanMode = null;
    this.teams = { RED: [], BLUE: [], UNDECIDED: [] };
    this.lateSignups.clear();
    this.teamsDecidedBy = null;
    this.mapVoteManager = undefined;
    this.minerushVoteManager = undefined;
    this.mvpVoters.clear();
    this.mvpVotes = { RED: {}, BLUE: {} };
    this.MVPPlayerBlue = "";
    this.MVPPlayerRed = "";
    this.pickOtherTeamsSupportRoles = false;
    this.modifierMode = "default";
    this.classBanLimit = 2;
    this.captainBanCounts.clear();
    this.lastRegisteredSnowflake = undefined;
    this.captainNominations.clear();
    this.captainBanLocked.clear();
    this.classBansAnnounced = false;
    this.redTeamPlan = undefined;
    this.blueTeamPlan = undefined;
    this.announcementPreviewMessage = undefined;
    this.announcementMessage = undefined;
    this.announcementPingMessage = undefined;
  }

  public hasFinalizedPlayableTeams(): boolean {
    return (
      this.teamsDecidedBy !== null &&
      this.teamsDecidedBy !== undefined &&
      this.teams.RED.length > 0 &&
      this.teams.BLUE.length > 0
    );
  }

  public getLifecycleVersion(): number {
    return this.lifecycleVersion;
  }

  /** Distinct across resets and process restarts; scopes persistent Discord buttons. */
  public getLifecycleToken(): string {
    return this.lifecycleToken;
  }

  public getGameStartStatus(): GameStartStatus {
    return this.gameStartStatus;
  }

  /** Domain-only recovery metadata; no runtime handles or Discord objects. */
  public exportRecoveryMetadata() {
    return {
      captainBanCounts: [...this.captainBanCounts.entries()],
      captainBanLocked: [...this.captainBanLocked],
      classBansAnnounced: this.classBansAnnounced,
    };
  }

  /** Called only after the complete snapshot has been validated. */
  public restoreRecoveryMetadata(
    gameId: string,
    lifecycleToken: string,
    metadata: ReturnType<GameInstance["exportRecoveryMetadata"]>
  ): void {
    this.lifecycleVersion += 1;
    this.lifecycleToken = lifecycleToken as ReturnType<typeof randomUUID>;
    this.gameId = gameId;
    this.gameStartStatus = "idle";
    this.captainBanCounts.clear();
    metadata.captainBanCounts.forEach(([id, count]) => this.captainBanCounts.set(id, count));
    this.captainBanLocked.clear();
    metadata.captainBanLocked.forEach((id) => this.captainBanLocked.add(id));
    this.classBansAnnounced = metadata.classBansAnnounced;
  }

  public tryBeginGameStart(): GameStartAttempt {
    if (this.gameStartStatus === "starting") return "inProgress";
    if (this.gameStartStatus === "started") return "alreadyStarted";
    this.gameStartStatus = "starting";
    return "acquired";
  }

  public completeGameStart(): void {
    if (this.gameStartStatus === "starting") {
      this.scenarios.clearSchedules();
      this.gameStartStatus = "started";
    }
  }

  public releaseGameStart(): void {
    if (this.gameStartStatus === "starting") {
      this.gameStartStatus = "idle";
    }
  }

  public beginConfirmedAnnouncement(): void {
    SeasonService.assertGameAdmission();
    const blocked = MatchRecoveryGate.getBlockReason() ?? GameRecoveryCoordinator.getBlockReason();
    if (blocked) {
      throw new Error(`Cannot begin announcement while recovery is unresolved: ${blocked}`);
    }
    this.lifecycleVersion += 1;
    this.lifecycleToken = randomUUID();
    // Stable for the entire announcement; Mongo Game.id is the match claim.
    this.gameId = this.lifecycleToken;
    this.isFinished = false;
    this.announced = true;
    this.recoveryPausedWorkflows = [];
    this.recoveryDraftProgress = undefined;
    this.isRestarting = false;
    this.noElo = this.organiserNoElo || this.isRelaxedSeason;
    this.scenarios.confirmAnnouncement();
    this.gameStartStatus = "idle";
    this.endTime = undefined;
    this.gameWinner = undefined;

    this.teams = { RED: [], BLUE: [], UNDECIDED: [] };
    this.lateSignups.clear();
    this.teamsDecidedBy = null;
    this.lastRegisteredSnowflake = undefined;
    this.captainNominations.clear();
    this.captainBanLocked.clear();
    this.captainBanCounts.clear();
    this.classBansAnnounced = false;
    this.settings.sharedCaptainBannedClasses = [];
    this.settings.nonSharedCaptainBannedClasses = {
      [Team.RED]: [],
      [Team.BLUE]: [],
    };
    this.redTeamPlan = undefined;
    this.blueTeamPlan = undefined;

    this.mvpVoters.clear();
    this.mvpVotes = { RED: {}, BLUE: {} };
    this.MVPPlayerBlue = "";
    this.MVPPlayerRed = "";
    this.blueMeanElo = undefined;
    this.redMeanElo = undefined;
    this.blueExpectedScore = undefined;
    this.redExpectedScore = undefined;
  }

  public static async resetGameInstance() {
    const currentInstance = this.getInstance();
    if (currentInstance) {
      currentInstance.scenarios.assertRuntimeResetSafe();
      await prismaClient.game.saveGameFromInstance(currentInstance);
      // Ensure any scheduled vote tasks and poll messages are cleaned up
      // before we drop references in reset().
      try {
        await currentInstance.mapVoteManager?.cancelVote();
      } catch {
        // ignore vote cleanup failures
      }
      try {
        await currentInstance.minerushVoteManager?.cancelVote();
      } catch {
        // ignore vote cleanup failures
      }
      currentInstance.reset();
    }
  }

  public startMinerushVote() {
    // if (this.minerushVoteManager) {
    //   this.minerushVoteManager.cancelVote();
    // }
    // this.minerushVoteManager = new MinerushVoteManager();
    // this.minerushVoteManager.on("pollEnd", (minerushWinner) => {
    //   this.setMinerushing(minerushWinner);
    // });
  }

  public startMapVote(maps: AnniMap[]) {
    if (this.mapVoteManager) {
      this.mapVoteManager.cancelVote();
    }
    // The preview's vote manager survives confirmation, which rotates the token.
    // Manager identity still rejects votes from reset or replaced games.
    const manager = new MapVoteManager(maps);
    this.mapVoteManager = manager;
    manager.on("pollEnd", (winningMap) => {
      if (this.mapVoteManager !== manager ||
          !this.announced || this.isFinished || GameRecoveryCoordinator.isFrozen()) return;
      this.setMap(winningMap);
    });
  }

  public closePolls() {
    if (this.mapVoteManager) {
      this.mapVoteManager.cancelVote();
      console.log("Map vote has been closed.");
    }

    // if (this.minerushVoteManager) {
    //   this.minerushVoteManager.cancelVote();
    //   console.log("Minerush vote has been closed.");
    // }
  }

  public stopVoting() {
    if (this.mapVoteManager) {
      this.mapVoteManager.stopVote();
      console.log("Map vote has been stopped without deleting the message.");
    }

    // if (this.minerushVoteManager) {
    //   this.minerushVoteManager.stopVote();
    //   console.log(
    //     "Minerush vote has been stopped without deleting the message."
    //   );
    // }
  }

  public getActivePlayerCount(): number {
    return this.teams.RED.length + this.teams.BLUE.length;
  }

  public getRegisteredPlayerCount(): number {
    return this.getPlayers().length;
  }

  public shouldBeNoEloForPlayerCount(): boolean {
    return this.getActivePlayerCount() < GameInstance.MIN_ELO_PLAYER_COUNT;
  }

  /** Organiser No Elo is additive: never force a game rated against attendance/season rules. */
  public refreshNoElo(): boolean {
    this.noElo = this.organiserNoElo || this.isRelaxedSeason || this.shouldBeNoEloForPlayerCount();
    return this.noElo;
  }

  public shouldAutoCancelForLowRegistration(): boolean {
    return (
      this.getRegisteredPlayerCount() <
      GameInstance.MIN_AUTO_START_REGISTERED_COUNT
    );
  }

  public setMap(map: AnniMap) {
    this.settings.map = map;
    console.log("The winning map was: " + map);
  }

  public setMinerushing(minerush: boolean) {
    // Minerushing is now captured as a modifier; set or replace the entry.
    this.settings.modifiers = [
      ...this.settings.modifiers.filter((m) => m.category !== "Minerushing"),
      {
        category: "Minerushing",
        name: minerush ? "Always" : "Not before phase 3 (Three)",
      },
    ];
    console.log("Minerushing is: " + minerush);
  }

  public async announce() {
    this.announced = true;

    if (this.mapVoteManager) {
      await this.mapVoteManager.startMapVote();
    }
    // if (this.minerushVoteManager) {
    //   await this.minerushVoteManager.startMinerushVote();
    // }
  }

  private getTeamWithLeastPlayers() {
    return Object.keys(this.teams).sort(
      (a, b) => this.teams[a as Team].length - this.teams[b as Team].length
    )[0] as Team;
  }

  public addLateSignup(discordSnowflake: string): void {
    this.lateSignups.add(discordSnowflake);
  }

  public isLateSignup(discordSnowflake: string): boolean {
    return this.lateSignups.has(discordSnowflake);
  }

  public async addPlayerByDiscordId(
    discordSnowflake: Snowflake,
    ignUsed: string,
    prepared?: RegistrationIdentity
  ) {
    const token = this.getLifecycleToken();
    if (this.getPlayers().some((p) => p.discordSnowflake === discordSnowflake)) {
      return { error: "This player is already registered." } as const;
    }
    if (prepared === undefined) {
      // Internal callers without prepared evidence must resolve identity before
      // creating any profile or statistics.
      const existing = await prismaClient.player.byDiscordSnowflake(discordSnowflake);
      const result = await RegistrationIdentity.prepare(discordSnowflake, token, existing, ignUsed, true);
      if ("error" in result) return { error: result.error } as const;
      prepared = result.identity;
    }
    if (!(prepared instanceof RegistrationIdentity) ||
        prepared.discordSnowflake !== discordSnowflake || prepared.gameToken !== token) {
      return { error: "The registration identity or announced game changed. Please register again." } as const;
    }
    const { uuid, expectedPrimary, expectedIGN, expectedAccounts, playerId } = prepared;
    if (this.getLifecycleToken() !== token || this.isRestarting)
      return { error: "The announced game changed. Please register again." } as const;

    // An overlapping registration may have completed during the awaits above.
    if (this.getPlayers().some((p) => p.discordSnowflake === discordSnowflake ||
        p.primaryMinecraftAccount?.toLowerCase() === uuid.toLowerCase())) {
      return { error: "This player or Minecraft account is already registered." } as const;
    }

    // Refresh the profile after acquiring the roster lock. A database snapshot
    // cannot detect a Minecraft rename while preparation was awaiting Discord.
    const resolved = await MojangAPI.uuidToUsername(uuid, true);
    const ign = resolved ?? prepared.ign;
    if (this.getLifecycleToken() !== token || this.isRestarting)
      return { error: "The announced game changed. Please register again." } as const;
    // A new account must not be linked to a UUID whose current name now
    // contradicts the forward lookup. Existing UUID associations remain stable.
    if (!expectedPrimary && resolved && resolved.toLowerCase() !== prepared.ign.toLowerCase())
      return { error: "The Minecraft username changed during verification. Please register again." } as const;
    if (!MojangAPI.validateUsername(ign))
      return { error: "Unable to retrieve a verified Minecraft username. Please retry later." } as const;
    const committed = await RegistrationIdentity.serializeMutation(async () => {
      if (playerId) {
        const punishment = await PrismaUtils.registrationPunishmentError(playerId);
        if (punishment) return { error: punishment } as const;
      }
      if (this.getLifecycleToken() !== token || this.isRestarting)
        return { error: "The announced game changed. Please register again." } as const;
      // Check ownership inside the shared identity-write queue, before linking.
      if (!expectedPrimary) {
        const owner = await prismaClient.player.findFirst({
          where: {
            NOT: { discordSnowflake },
            OR: RegistrationIdentity.ownershipConditions(uuid),
          },
          select: { id: true },
        });
        if (owner) return { error: "That Minecraft account is already linked to another member." } as const;
      }
      if (this.getLifecycleToken() !== token || this.isRestarting)
        return { error: "The announced game changed. Please register again." } as const;
      const player = await PlayerInstance.byDiscordSnowflake(discordSnowflake, playerId);
      if (this.getLifecycleToken() !== token || this.isRestarting)
        return { error: "The announced game changed. Please register again." } as const;
      if (player.primaryMinecraftAccount !== expectedPrimary || player.latestIGN !== expectedIGN ||
          (playerId && player.playerId !== playerId) ||
          player.minecraftAccounts.length !== expectedAccounts.length ||
          player.minecraftAccounts.some((name, index) => name !== expectedAccounts[index])) {
        return { error: "The stored Minecraft identity changed. Please register again." } as const;
      }
      // A blank profile may have appeared concurrently after preparation.
      if (!playerId) {
        const punishment = await PrismaUtils.registrationPunishmentError(player.playerId);
        if (punishment) return { error: punishment } as const;
        if (this.getLifecycleToken() !== token || this.isRestarting)
          return { error: "The announced game changed. Please register again." } as const;
      }
      const addName = !player.minecraftAccounts.includes(ign);
      const accounts = addName ? [...player.minecraftAccounts, ign] : player.minecraftAccounts;
      if (!player.primaryMinecraftAccount || addName || player.latestIGN !== ign) {
        // Compare-and-swap all identity fields: never overwrite a concurrent
        // organiser account change or another registration's name history.
        // MongoDB distinguishes explicitly null fields from missing legacy fields.
        const result = await prismaClient.player.update({
          where: {
            id: player.playerId,
            AND: [
              expectedPrimary === undefined
                ? { OR: [{ primaryMinecraftAccount: null }, { primaryMinecraftAccount: { isSet: false } }] }
                : { primaryMinecraftAccount: expectedPrimary },
              expectedIGN === undefined
                ? { OR: [{ latestIGN: null }, { latestIGN: { isSet: false } }] }
                : { latestIGN: expectedIGN },
              { minecraftAccounts: { equals: player.minecraftAccounts } },
            ],
          },
          data: {
            ...(!player.primaryMinecraftAccount ? { primaryMinecraftAccount: uuid } : {}),
            ...(addName ? { minecraftAccounts: accounts } : {}),
            ...(player.latestIGN !== ign ? { latestIGN: ign } : {}),
          },
        }).catch((error: unknown) => {
          if ((error as { code?: string })?.code === "P2025") return null;
          throw error;
        });
        if (!result) return { error: "The stored Minecraft identity changed. Please register again." } as const;
        player.primaryMinecraftAccount = uuid;
        player.minecraftAccounts = accounts;
        player.latestIGN = ign;
      }
      player.ignUsed = ign;

      // Check again after all identity/statistics I/O. The same per-player
      // queue orders organiser ban additions against this synchronous admission.
      return PrismaUtils.withPunishmentAdmission(player.playerId, async () => {
        const punishment = await PrismaUtils.registrationPunishmentError(player.playerId);
        if (punishment) return { error: punishment } as const;
        if (this.getLifecycleToken() !== token || this.isRestarting)
          return { error: "The announced game changed. Please register again." } as const;
        if (this.getPlayers().some((p) => p.discordSnowflake === discordSnowflake ||
            p.primaryMinecraftAccount?.toLowerCase() === uuid.toLowerCase())) {
          return { error: "This player is already registered." } as const;
        }
        this.teams["UNDECIDED"].push(player);
        this.lastRegisteredSnowflake = discordSnowflake;
        return { error: false, playerInstance: player } as const;
      });
    });
    if (committed.error !== false) return committed;
    if (this.getLifecycleToken() !== token || this.isRestarting)
      return { error: "The announced game changed. Please register again." } as const;
    let scenarioWarning = false;
    try {
      await this.scenarios.onRegistrationChanged(discordSnowflake, true);
    } catch (error) {
      scenarioWarning = true;
      console.error(`Scenario registration sync failed member=${discordSnowflake}`, error);
      if (this.getLifecycleToken() === token)
        this.scenarios.needsReview("Scenario registration update failed; organiser review required.");
    }

    return {
      error: false,
      playerInstance: committed.playerInstance,
      scenarioWarning,
    } as const;
  }

  public async removePlayerByDiscordId(discordSnowflake: Snowflake) {
    const found = this.getPlayers().some(
      (player) => player.discordSnowflake === discordSnowflake
    );
    if (!found) {
      return { error: "Player not found in any team." } as const;
    }
    for (const team of ["RED", "BLUE", "UNDECIDED"] as const) {
      this.teams[team] = this.teams[team].filter(
        (player) => player.discordSnowflake !== discordSnowflake
      );
    }
    this.lateSignups.delete(discordSnowflake);
    this.captainNominations.delete(discordSnowflake);
    if (this.lastRegisteredSnowflake === discordSnowflake) {
      this.lastRegisteredSnowflake = undefined;
    }
    await this.scenarios.onRegistrationChanged(discordSnowflake, false);
  }

  public getPlayers() {
    return Object.values(this.teams).flat(1);
  }

  public getPlayersOfTeam(team: Team | "UNDECIDED") {
    return this.teams[team];
  }

  public resetTeams() {
    void NeedCommand.instance?.expireAll();
    this.scenarios.invalidateTeams();
    const combined = new Map(
      [...this.teams["UNDECIDED"], ...this.teams["RED"], ...this.teams["BLUE"]]
        .map((player) => [player.discordSnowflake, player])
    );
    this.teams["UNDECIDED"] = Array.from(combined.values());
    this.teams["RED"] = [];
    this.teams["BLUE"] = [];
  }

  public createTeams(createMethod: "random" | "elo" | "balance") {
    switch (createMethod) {
      case "random": {
        const simulatedTeams = this.simulateShuffledTeams();
        this.teams.BLUE = simulatedTeams.BLUE;
        this.teams.RED = simulatedTeams.RED;
        this.teams.UNDECIDED = [];
        break;
      }
      case "elo": {
        const simulatedTeams = this.simulateEloTeams();
        this.teams.BLUE = simulatedTeams.BLUE;
        this.teams.RED = simulatedTeams.RED;
        break;
      }
      case "balance": {
        const simulatedTeams = this.simulateBalancedTeams();
        this.teams.BLUE = simulatedTeams.BLUE;
        this.teams.RED = simulatedTeams.RED;
        break;
      }
    }
  }

  public simulateShuffledTeams(): Record<Team, PlayerInstance[]> {
    // Regenerate from the whole active roster; previously assigned players
    // must not disappear from a new random preview.
    const registeredPlayers = [...new Map(
      this.getPlayers().map((player) => [player.discordSnowflake, player])
    ).values()];
    const shuffled = registeredPlayers.sort(() => Math.random() - 0.5);
    const half = Math.ceil(shuffled.length / 2);

    return {
      BLUE: shuffled.slice(0, half),
      RED: shuffled.slice(half),
    };
  }

  public simulateEloTeams(): Record<Team, PlayerInstance[]> {
    const players = [...new Map(
      this.getPlayers().map((player) => [player.discordSnowflake, player])
    ).values()];

    players.forEach((p) => {
      p.captain = false;
    });

    const sorted = players.sort((a, b) => (b.elo ?? 0) - (a.elo ?? 0));
    const blue: PlayerInstance[] = [];
    const red: PlayerInstance[] = [];

    sorted.forEach((player, idx) => {
      if (idx % 2 === 0) {
        blue.push(player);
      } else {
        red.push(player);
      }
    });

    if (blue[0]) blue[0].captain = true;
    if (red[0]) red[0].captain = true;

    this.teams.UNDECIDED = [];

    return { BLUE: blue, RED: red };
  }

  public simulateBalancedTeams(): Record<Team, PlayerInstance[]> {
    const players = [...new Map(
      this.getPlayers().map((player) => [player.discordSnowflake, player])
    ).values()];

    players.forEach((p) => {
      p.captain = false;
    });

    if (players.length === 0) {
      return { BLUE: [], RED: [] };
    }

    const sorted = players.sort((a, b) => (b.elo ?? 0) - (a.elo ?? 0));
    const firstIdx = Math.floor(Math.random() * sorted.length);
    const firstCaptain = sorted.splice(firstIdx, 1)[0];
    if (sorted.length === 0) {
      firstCaptain.captain = true;
      return { BLUE: [firstCaptain], RED: [] };
    }
    let secondCaptain = sorted[0];
    let closestDiff = Math.abs(
      (firstCaptain.elo ?? 0) - (secondCaptain?.elo ?? 0)
    );
    for (const candidate of sorted) {
      const diff = Math.abs((firstCaptain.elo ?? 0) - (candidate.elo ?? 0));
      if (diff < closestDiff) {
        closestDiff = diff;
        secondCaptain = candidate;
      }
    }
    sorted.splice(sorted.indexOf(secondCaptain), 1);

    const blue: PlayerInstance[] = [firstCaptain];
    const red: PlayerInstance[] = [secondCaptain];
    let blueTotal = firstCaptain.elo ?? 0;
    let redTotal = secondCaptain.elo ?? 0;

    for (const player of sorted) {
      const elo = player.elo ?? 0;
      const blueAvg = blueTotal / blue.length;
      const redAvg = redTotal / red.length;
      if (blue.length < red.length) {
        blue.push(player);
        blueTotal += elo;
        continue;
      }
      if (red.length < blue.length) {
        red.push(player);
        redTotal += elo;
        continue;
      }
      if (blueAvg <= redAvg) {
        blue.push(player);
        blueTotal += elo;
      } else {
        red.push(player);
        redTotal += elo;
      }
    }

    if (blue[0]) blue[0].captain = true;
    if (red[0]) red[0].captain = true;

    this.teams.UNDECIDED = [];

    return { BLUE: blue, RED: red };
  }

  public setTeamCaptain(team: Team, player: PlayerInstance) {
    const oldTeamCaptain = this.getCaptainOfTeam(team);

    if (oldTeamCaptain && oldTeamCaptain !== player) {
      oldTeamCaptain.captain = false;

      (Object.keys(this.teams) as Array<Team | "UNDECIDED">).forEach(
        (k) =>
          (this.teams[k] = this.teams[k].filter((p) => p !== oldTeamCaptain))
      );
      if (!this.teams["UNDECIDED"].includes(oldTeamCaptain)) {
        this.teams["UNDECIDED"].push(oldTeamCaptain);
      }
    }

    player.captain = true;

    (Object.keys(this.teams) as Array<Team | "UNDECIDED">).forEach((k) => {
      this.teams[k] = this.teams[k].filter((p) => p !== player);
    });

    if (!this.teams[team].includes(player)) {
      this.teams[team].push(player);
    }

    if (this.getCaptainOfTeam("RED") && this.getCaptainOfTeam("BLUE"))
      queueMicrotask(() => { void this.scenarios.activateType("on_captains_ready"); });

    return {
      oldCaptain: oldTeamCaptain?.discordSnowflake,
      newCaptain: player.discordSnowflake,
    };
  }

  public getCaptainOfTeam(team: Team) {
    return this.teams[team].find((p) => p.captain === true);
  }

  public async testValues(fillOption: "red-blue" | "undecided" | "none") {
    console.info(
      `[GAME] Initializing test values with fillOption: ${fillOption}`
    );

    // this.gameId = "default-game-id";
    this.isFinished = false;
    this.announced = true;
    this.startTime = new Date(Date.now() + 6 * 60 * 1000); // 6m from now for polls
    this.endTime = new Date("2025-01-01T02:00:00Z");
    this.settings = {
      organiserBannedClasses: ["SNIPER"],
      sharedCaptainBannedClasses: [],
      nonSharedCaptainBannedClasses: { RED: ["SCOUT"], BLUE: ["NEPTUNE"] },
      map: "DUELSTAL",
      modifiers: [{ category: "Minerushing", name: "Always" }],
      delayedBan: 0,
    };
    this.MVPPlayerBlue = "Immortal";
    this.MVPPlayerRed = "5trawHato";
    this.teams.RED = [];
    this.teams.BLUE = [];
    this.teams.UNDECIDED = [];
    ModifierSelector.runSelection();
    this.captainBanCounts.clear();

    await activateFeed(Channels.gameFeed, addRegisteredPlayersFeed);
    await activateFeed(Channels.gameFeed, addTeamsGameFeed);

    if (fillOption !== "none") {
      console.info(`[GAME] Filling teams with test players...`);
      await this.fillTeamsWithTestPlayers(8, fillOption);
      console.info(`[GAME] Teams filled. Current teams:`, this.teams);

      this.teams.RED.forEach((player) => {
        this.mvpVotes.RED[player.discordSnowflake] = Math.floor(
          Math.random() * 20
        );
      });
      this.teams.BLUE.forEach((player) => {
        this.mvpVotes.BLUE[player.discordSnowflake] = Math.floor(
          Math.random() * 20
        );
      });

      console.info(`[GAME] MVP votes populated with test players.`);
    }

    this.mapVoteManager = new MapVoteManager([
      "AFTERMATH1V1",
      "ANDORRA1V1",
      "DUELSTAL",
    ] as AnniMap[]);

    // this.minerushVoteManager = new MinerushVoteManager();

    if (this.mapVoteManager) {
      await this.mapVoteManager.startMapVote();
    }
    // if (this.minerushVoteManager) {
    //   await this.minerushVoteManager.startMinerushVote();
    // }

    const pollVotes = false;
    if (pollVotes) {
      console.info(`[GAME] Starting map votes.`);
      await this.mapVoteManager.startMapVote();
      // await this.minerushVoteManager.startMinerushVote();
    }
  }

  private async fillTeamsWithTestPlayers(
    playerCount: number,
    fillOption: "red-blue" | "undecided"
  ) {
    console.info(`[GAME] Creating ${playerCount} test player instances...`);

    const playerInstances: PlayerInstance[] = [];
    for (let i = 0; i < playerCount; i++) {
      const player = await PlayerInstance.testValues();
      playerInstances.push(player);
    }

    if (fillOption === "red-blue") {
      playerInstances.forEach((player, index) => {
        if (index % 2 === 0) {
          this.teams.RED.push(player);
        } else {
          this.teams.BLUE.push(player);
        }
      });
      console.info(`[GAME] Players assigned to RED and BLUE teams.`);
    } else if (fillOption === "undecided") {
      this.teams.UNDECIDED.push(...playerInstances);
      console.info(`[GAME] Players assigned to UNDECIDED team.`);
    }

    console.info(`[GAME] Final team state:`, this.teams);
  }

  /** Allow edits before and during play; abort across resets or lifecycle transitions. */
  private canCompleteRosterMutation(token: string): boolean {
    return token === this.getLifecycleToken() &&
      this.getGameStartStatus() !== "starting" && !this.isRestarting;
  }

  public async addPlayerByNameOrDiscord(
    identifier: string,
    team: Team | "UNDECIDED",
    guild: CacheTypeReducer<CacheType, Guild, null>
  ): Promise<boolean> {
    const token = this.getLifecycleToken();
    const player = await this.findPlayerByNameOrDiscord(identifier);
    if (!this.canCompleteRosterMutation(token) ||
        !player || !this.isPlayerInUndecided(player)) return false;

    if (!guild) {
      console.error(`Guild not found for ID: ${player.discordSnowflake}`);
      return false;
    }
    const member = await fetchGuildMember(guild, player.discordSnowflake);
    if (!member) {
      console.warn(`Cannot add departed member ${player.discordSnowflake} to a team`);
      return false;
    }
    if (!this.canCompleteRosterMutation(token) || !this.isPlayerInUndecided(player)) {
      return false;
    }

    const config = ConfigManager.getConfig();
    const blueTeamRoleId = config.roles.blueTeamRole;
    const redTeamRoleId = config.roles.redTeamRole;

    if (team === "BLUE") {
      if (member.roles.cache.has(redTeamRoleId)) {
        await DiscordUtil.removeRole(member, redTeamRoleId);
      }
      await DiscordUtil.assignRole(member, blueTeamRoleId);
    } else if (team === "RED") {
      if (member.roles.cache.has(blueTeamRoleId)) {
        await DiscordUtil.removeRole(member, blueTeamRoleId);
      }
      await DiscordUtil.assignRole(member, redTeamRoleId);
    }

    if (!this.canCompleteRosterMutation(token) || !this.isPlayerInUndecided(player)) return false;
    this.removePlayerFromAllTeams(player);
    this.teams[team].push(player);
    if (this.announced && this.getGameStartStatus() === "idle") this.scenarios.invalidateTeams();
    return true;
  }

  public async removePlayerByNameOrDiscord(
    identifier: string,
    guild: CacheTypeReducer<CacheType, Guild, null>
  ): Promise<boolean> {
    const token = this.getLifecycleToken();
    const player = await this.findPlayerByNameOrDiscord(identifier);
    if (!this.canCompleteRosterMutation(token) || !player) return false;

    if (!guild) return false;
    const member = await fetchGuildMember(guild, player.discordSnowflake);
    if (!this.canCompleteRosterMutation(token)) return false;
    if (member) {
      const roles = ConfigManager.getConfig().roles;
      if (member.roles.cache.has(roles.blueTeamRole)) {
        await DiscordUtil.removeRole(member, roles.blueTeamRole);
      }
      if (member.roles.cache.has(roles.redTeamRole)) {
        await DiscordUtil.removeRole(member, roles.redTeamRole);
      }
    }
    // A confirmed 10007 is not a reason to keep the departed player in the roster.
    if (!this.canCompleteRosterMutation(token)) return false;
    this.removePlayerFromAllTeams(player);
    await this.scenarios.onRegistrationChanged(player.discordSnowflake, false);
    return true;
  }

  public async findPlayerByNameOrDiscord(
    identifier: string
  ): Promise<PlayerInstance | null> {
    const lowerIdentifier = identifier.toLowerCase();

    const playerByName = this.getPlayers().find(
      (p) => p.ignUsed?.toLowerCase() === lowerIdentifier
    );
    if (playerByName) return playerByName;

    const playerByDiscord =
      await prismaClient.player.byDiscordSnowflake(identifier);
    return playerByDiscord
      ? this.getPlayers().find(
          (p) => p.discordSnowflake === playerByDiscord.discordSnowflake
        ) || null
      : null;
  }

  private isPlayerInUndecided(player: PlayerInstance): boolean {
    return this.teams["UNDECIDED"]?.includes(player) || false;
  }

  private removePlayerFromAllTeams(player: PlayerInstance): void {
    for (const team of Object.keys(this.teams) as Array<Team | "UNDECIDED">) {
      this.teams[team] = this.teams[team].filter((p) => p !== player);
    }
  }

  public async replacePlayerByNameOrDiscord(
    oldIdentifier: string,
    newIdentifier: string,
    guild: CacheTypeReducer<CacheType, Guild, null>
  ): Promise<boolean> {
    const token = this.getLifecycleToken();
    const oldPlayer = await this.findPlayerByNameOrDiscord(oldIdentifier);
    const newPlayer = await this.findPlayerByNameOrDiscord(newIdentifier);

    if (
      !this.canCompleteRosterMutation(token) ||
      !oldPlayer ||
      !newPlayer ||
      this.isPlayerInUndecided(oldPlayer) ||
      !this.isPlayerInUndecided(newPlayer)
    ) {
      return false;
    }

    const oldPlayerTeam = this.getPlayersTeam(oldPlayer);
    if (!oldPlayerTeam || oldPlayerTeam === "UNDECIDED") {
      return false;
    }

    if (!guild) {
      console.error(
        `Guild not found for replacing players: ${oldPlayer.discordSnowflake}, ${newPlayer.discordSnowflake}`
      );
      return false;
    }

    const oldMember = await fetchGuildMember(guild, oldPlayer.discordSnowflake);
    const newMember = await fetchGuildMember(guild, newPlayer.discordSnowflake);

    if (!oldMember || !newMember) {
      console.error(
        `Guild members not found for players: ${oldPlayer.discordSnowflake}, ${newPlayer.discordSnowflake}`
      );
      return false;
    }
    if (!this.canCompleteRosterMutation(token) ||
        this.getPlayersTeam(oldPlayer) !== oldPlayerTeam ||
        !this.isPlayerInUndecided(newPlayer)) return false;

    const config = ConfigManager.getConfig();
    const blueTeamRoleId = config.roles.blueTeamRole;
    const redTeamRoleId = config.roles.redTeamRole;

    if (oldMember.roles.cache.has(blueTeamRoleId)) {
      await DiscordUtil.removeRole(oldMember, blueTeamRoleId);
    }
    if (oldMember.roles.cache.has(redTeamRoleId)) {
      await DiscordUtil.removeRole(oldMember, redTeamRoleId);
    }

    if (newMember.roles.cache.has(blueTeamRoleId)) {
      await DiscordUtil.removeRole(newMember, blueTeamRoleId);
    }
    if (newMember.roles.cache.has(redTeamRoleId)) {
      await DiscordUtil.removeRole(newMember, redTeamRoleId);
    }

    if (oldPlayerTeam === "BLUE") {
      await DiscordUtil.assignRole(newMember, blueTeamRoleId);
    } else if (oldPlayerTeam === "RED") {
      await DiscordUtil.assignRole(newMember, redTeamRoleId);
    }

    if (!this.canCompleteRosterMutation(token) ||
        this.getPlayersTeam(oldPlayer) !== oldPlayerTeam ||
        !this.isPlayerInUndecided(newPlayer)) return false;
    this.removePlayerFromAllTeams(oldPlayer);
    this.removePlayerFromAllTeams(newPlayer);
    this.teams[oldPlayerTeam].push(newPlayer);

    return true;
  }

  getPlayersTeam(player: PlayerInstance): Team | "UNDECIDED" | null {
    return (
      (Object.keys(this.teams) as Array<Team | "UNDECIDED">).find((team) =>
        this.teams[team]?.includes(player)
      ) ?? null
    );
  }

  public async movePlayerBetweenTeams(
    playerName: string,
    fromTeam: Team | "UNDECIDED",
    toTeam: Team | "UNDECIDED",
    guild: CacheTypeReducer<CacheType, Guild, null>
  ): Promise<boolean> {
    const token = this.getLifecycleToken();
    if (
      !["RED", "BLUE", "UNDECIDED"].includes(fromTeam) ||
      !["RED", "BLUE", "UNDECIDED"].includes(toTeam)
    ) {
      console.error("Invalid teams specified:", { fromTeam, toTeam });
      return false;
    }

    const player = await this.findPlayerByNameOrDiscord(playerName);
    if (!this.canCompleteRosterMutation(token) ||
        !player || this.getPlayersTeam(player) !== fromTeam) {
      console.error("Player lookup failed or team mismatch:", {
        playerName,
        fromTeam,
      });
      return false;
    }

    if (!guild) {
      console.error(
        `Guild not found for moving player: ${player.discordSnowflake}`
      );
      return false;
    }

    const member = await fetchGuildMember(guild, player.discordSnowflake);
    if (!member) {
      console.warn(
        `Cannot move departed member: ${player.discordSnowflake}`
      );
      return false;
    }
    if (!this.canCompleteRosterMutation(token) ||
        this.getPlayersTeam(player) !== fromTeam) return false;

    const config = ConfigManager.getConfig();
    const blueTeamRoleId = config.roles.blueTeamRole;
    const redTeamRoleId = config.roles.redTeamRole;

    if (fromTeam === "BLUE") {
      if (member.roles.cache.has(blueTeamRoleId)) {
        await DiscordUtil.removeRole(member, blueTeamRoleId);
      }
    } else if (fromTeam === "RED") {
      if (member.roles.cache.has(redTeamRoleId)) {
        await DiscordUtil.removeRole(member, redTeamRoleId);
      }
    }

    if (toTeam === "BLUE") {
      if (member.roles.cache.has(redTeamRoleId)) {
        await DiscordUtil.removeRole(member, redTeamRoleId);
      }
      await DiscordUtil.assignRole(member, blueTeamRoleId);
    } else if (toTeam === "RED") {
      if (member.roles.cache.has(blueTeamRoleId)) {
        await DiscordUtil.removeRole(member, blueTeamRoleId);
      }
      await DiscordUtil.assignRole(member, redTeamRoleId);
    }

    if (!this.canCompleteRosterMutation(token) ||
        this.getPlayersTeam(player) !== fromTeam) return false;
    this.removePlayerFromAllTeams(player);
    this.teams[toTeam].push(player);
    if (this.scenarios.hasRuntime) await this.scenarios.onRegistrationChanged(player.discordSnowflake, true);
    console.info(
      `Player ${playerName} successfully moved from ${JSON.stringify(fromTeam)} to ${JSON.stringify(toTeam)}.`
    );
    return true;
  }

  public async setGameWinner(team: Team) {
    void NeedCommand.instance?.expireAll();
    this.gameWinner = team;
    await this.scenarios.runtimeWinnerReported();
  }

  public voteMvp(voterId: string, targetId: string): { error?: string } {
    if (!this.isFinished) {
      return { error: "The game is not finished yet." };
    }

    if (this.mvpVoters.has(voterId)) {
      return { error: "You have already voted for MVP." };
    }

    const voterPlayer = this.getPlayers().find(
      (p) => p.discordSnowflake === voterId
    );
    const targetPlayer = this.getPlayers().find(
      (p) => p.discordSnowflake === targetId
    );

    if (!voterPlayer || !targetPlayer) {
      return { error: "Voter or target player not found in the game." };
    }

    const voterTeam = this.getPlayersTeam(voterPlayer);
    const targetTeam = this.getPlayersTeam(targetPlayer);

    if (
      !voterTeam ||
      voterTeam === "UNDECIDED" ||
      !targetTeam ||
      targetTeam === "UNDECIDED"
    ) {
      return { error: "Both voter and target must be on a decided team." };
    }

    if (voterTeam !== targetTeam) {
      return { error: "You can only vote for a player on your own team!" };
    }

    if (voterId === targetId) {
      return { error: "You cannot vote for yourself." };
    }

    if (!this.mvpVotes[voterTeam][targetId]) {
      this.mvpVotes[voterTeam][targetId] = 0;
    }
    this.mvpVotes[voterTeam][targetId] += 1;

    this.mvpVoters.add(voterId);

    return {};
  }

  public hasVotedMvp(voterId: string): boolean {
    return this.mvpVoters.has(voterId);
  }

  public async countMVPVotes() {
    console.log("Starting to count MVP votes now...");
    const redPlayer = await this.determineTeamMVP("RED");
    this.MVPPlayerRed = redPlayer?.ignUsed ?? "";
    console.log("Determined red team MVP.");
    const bluePlayer = await this.determineTeamMVP("BLUE");
    this.MVPPlayerBlue = bluePlayer?.ignUsed ?? "";
    console.log("Determined blue team MVP.");
    const redMVP = await this.formatMvpDisplay(redPlayer);
    const blueMVP = await this.formatMvpDisplay(bluePlayer);
    console.log("Sending MVPees announcement");
    await DiscordUtil.sendMessage("gameFeed", "\u200b");

    const messageText = `🏆 **Game MVPs** 🏆\n🔴 **RED Team:** ${redMVP}\n🔵 **BLUE Team:** ${blueMVP}`;
    await DiscordUtil.sendMessage("gameFeed", messageText);
    await DiscordUtil.sendMessage("gameFeed", "\u200b");
  }

  private async determineTeamMVP(team: Team): Promise<PlayerInstance | null> {
    console.log("Determining MVP for", team);
    const teamVotes = this.mvpVotes[team];
    const entries = Object.entries(teamVotes);

    if (entries.length === 0) return null;

    console.log("Finding the maximum votes...");
    const maxVotes = Math.max(...entries.map(([, votes]) => votes));
    const tiedPlayers = entries
      .filter(([, votes]) => votes === maxVotes)
      .map(([playerId]) => playerId);

    let selectedPlayerId: string;
    if (tiedPlayers.length > 1) {
      console.log("A tie detected among players: ", tiedPlayers);
      selectedPlayerId =
        tiedPlayers[Math.floor(Math.random() * tiedPlayers.length)];
      console.log(
        `Randomly selected ${selectedPlayerId} as the MVP in case of a tie.`
      );
      await DiscordUtil.sendMessage(
        "gameFeed",
        `💥 There has been a tie for the MVP of ${team} team! There can only be one, one of them will be randomly selected.`
      );
    } else {
      selectedPlayerId = tiedPlayers[0];
    }

    console.log("Finding and returning MVP player...");
    const player = this.getPlayers().find(
      (p) => p.discordSnowflake === selectedPlayerId
    );

    return player ?? null;
  }

  private async formatMvpDisplay(
    player: PlayerInstance | null
  ): Promise<string> {
    if (!player) return "no body";
    const baseName = escapeIgn(player.ignUsed ?? "Unknown Player");
    return PrismaUtils.getDisplayNameWithTitle(player.playerId, baseName);
  }

  public changeHowTeamsDecided(
    type: "DRAFT" | "SNAKE_DRAFT" | "RANDOMISED" | "ELO" | "BALANCE" | null
  ) {
    this.teamsDecidedBy = typeof type === "string" ? type : null;
  }

  public setTeamPlan(team: Team, plan: TeamPlanRecord) {
    if (team === Team.RED) {
      this.redTeamPlan = plan;
    } else {
      this.blueTeamPlan = plan;
    }
  }

  public calculateMeanEloAndExpectedScore() {
    const { blueMeanElo, redMeanElo, blueExpectedScore, redExpectedScore } =
      Elo.calculateMeanEloAndExpectedScore(this.teams);

    this.blueMeanElo = blueMeanElo;
    this.redMeanElo = redMeanElo;
    this.blueExpectedScore = blueExpectedScore;
    this.redExpectedScore = redExpectedScore;
  }

  public setClassBanLimit(limit: number): void {
    this.classBanLimit = limit;
  }

  public getClassBanLimit(): number {
    return this.classBanLimit;
  }

  public getCaptainBanCount(userId: string): number {
    return this.captainBanCounts.get(userId) ?? 0;
  }

  public getTotalCaptainBans(): number {
    let total = 0;
    for (const c of this.captainBanCounts.values()) total += c;
    return total;
  }

  public getPerCaptainBanLimit(): number {
    return this.classBanLimit / 2;
  }

  public hasCaptainReachedBanLimit(userId: string): boolean {
    return this.getCaptainBanCount(userId) >= this.getPerCaptainBanLimit();
  }

  public markCaptainHasBanned(userId: string): void {
    const prev = this.getCaptainBanCount(userId);
    this.captainBanCounts.set(userId, prev + 1);
  }

  public isCaptainBanLocked(userId: string): boolean {
    return this.captainBanLocked.has(userId);
  }

  public lockCaptainBan(userId: string): void {
    this.captainBanLocked.add(userId);
  }

  public markClassBansAnnounced(): void {
    this.classBansAnnounced = true;
  }

  public areClassBansAnnounced(): boolean {
    return this.classBansAnnounced;
  }
}
